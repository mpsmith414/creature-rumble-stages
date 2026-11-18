import type { Rng } from '../util/rng';
import type { StageFighter } from './fighter';
import { solidAt, type Level, type Platform } from './level';
import { DT, type V2 } from './types';

/**
 * A level's mischief (spec §7): something that comes and goes on its own seeded timer, one at a time, about every
 * 30–45 s for 6–10 s, announced by a cue. Each level lists the mischief it has and what each needs to know about it.
 * - `vines` (jungle): vines drop from the canopy and swing; a creature jumping into a vine's grip catches it and is
 *   carried along its arc until it jumps off (keeping the swing), lands, is hit, or has ridden RIDE_MAX.
 * - `river` (jungle): the river floods the jungle floor; its current sweeps along everyone standing on that floor.
 *   (Falling off the level into the river below is an out, as always; the show makes it a splash.)
 * - `airlock` (ship): an airlock opens on one side and pulls everyone toward it, standing or in the air.
 * - `lowGravity` (ship): gravity × LOW_GRAVITY. The fight swaps in another level object for the while, so the brains'
 *   route graphs (cached by level) always match the physics (ruling R27).
 * - `toyTrain` (toy room): a toy train runs along the floor and back, bumping everyone it meets upward like a medium
 *   hit (once a way).
 * Everything random comes from the fight's seeded numbers; nothing moves while the fight is frozen.
 */
export type MischiefName = 'vines' | 'river' | 'airlock' | 'lowGravity' | 'toyTrain';

/** A mischief starting or ending, for the show and the announcer. */
export type MischiefCue = { name: MischiefName; phase: 'start' | 'end' };

/** What the announcer calls each one. */
export const MISCHIEF_TITLE: Record<MischiefName, string> = {
  vines: 'SWINGING VINES', river: 'SPLASHY RIVER', airlock: 'AIRLOCK OPEN', lowGravity: 'LOW GRAVITY', toyTrain: 'TOY TRAIN',
};

/**
 * A vine hanging from (x, y) (m), `length` long, swinging `swing` radians either side of straight down once every
 * `period` s, starting `phase` radians into its swing. Its grip is its lower end.
 */
export type Vine = { x: number; y: number; length: number; swing: number; period: number; phase: number };

/** A level's mischief and what it needs: the vines; the floor the river floods; the floor the train runs along. */
export type MischiefData =
  | { name: 'vines'; vines: Vine[] }
  | { name: 'river'; floor: string }
  | { name: 'airlock' }
  | { name: 'lowGravity' }
  | { name: 'toyTrain'; track: string };

/** A creature bumped by mischief (the toy train), for the show: like a hit, but nobody threw it. */
export type MischiefBump = { by: MischiefName; target: string; at: V2; launch: number; tumble: boolean };

/** The toy train as it is now: its box (bottom centre x, y; w × h), the way it runs and its speed (m/s). */
export type TrainBox = { x: number; y: number; w: number; h: number; dir: 1 | -1; speed: number };

/** A new mischief starts this long after the last one started, plus up to the spread (s). */
export const MISCHIEF_GAP = { min: 30, spread: 15 };
/** A mischief lasts this long plus up to the spread (s). */
export const MISCHIEF_LEN = { min: 6, spread: 4 };
/** The river's current on the flooded floor, and the airlock's pull (m/s, sideways): a creature runs against either. */
export const RIVER_SPEED = 2.5, AIRLOCK_PULL = 2.5;
/** Gravity's share in low gravity. */
export const LOW_GRAVITY = 0.5;
/** The toy train's size (m): lower than a toy block, so a creature standing on a block is safe. */
export const TRAIN_W = 3, TRAIN_H = 1;
/** A train bump: a medium hit's power, little damage (at most 10), launching steeply up (degrees). */
export const TRAIN_POWER = 1, TRAIN_DAMAGE = 6, TRAIN_ANGLE = 70;
/** A vine's grip is caught within this much (m) beside or above a creature's hands (its box's top), or this far below. */
export const GRIP_R = 0.5, GRIP_DOWN = 0.6;
/** Nobody rides a vine longer than this (s): about one swing there and back. */
export const RIDE_MAX = 3;
/** Having let go, a creature cannot catch a vine again for this long (s). */
const REGRAB = 0.6;
/** A catch eases the hands onto the grip over this long (s), so nothing snaps. */
const CATCH_EASE = 0.15;
/** Slack for "the time has come" (s), far below a step. */
const T_EPS = 1e-9;
const TAU = Math.PI * 2;

/** Low-gravity copies of levels, made once each (a new object: never the level itself changed; ruling R27). */
const lowLevels = new WeakMap<Level, Level>();

/** `level` in low gravity: the same platforms and everything else, gravity × LOW_GRAVITY. The same object every call. */
export function lowGravity(level: Level): Level {
  let l = lowLevels.get(level);
  if (!l) lowLevels.set(level, (l = { ...level, gravity: level.gravity * LOW_GRAVITY }));
  return l;
}

/** Where vine `v`'s grip is at time `t` (s). Fills and returns `out`. */
export function vineGrip(v: Vine, t: number, out: V2): V2 {
  const a = v.swing * Math.sin((TAU * t) / v.period + v.phase);
  out.x = v.x + v.length * Math.sin(a);
  out.y = v.y - v.length * Math.cos(a);
  return out;
}

/** A creature on a vine: which vine, since when, and how far its hands were from the grip when it caught it. */
type Rider = { vine: number; since: number; ex: number; ey: number };

/**
 * A level's mischief during a fight: the timer, the one under way (`active`, with its `side`: the way the river flows,
 * the airlock pulls or the train first runs) and its effects on the fighters, which the sim applies every step after
 * everyone has moved (`step`). `level` is the level as it is now (a low-gravity copy during low gravity). A level with
 * no mischief never draws a random number.
 */
export class LevelMischief {
  /** The level as made. */
  readonly base: Level;
  /** The level as it is now: `base`, or its low-gravity copy. */
  level: Level;
  active: MischiefName | null = null;
  side: 1 | -1 = 1;
  /** When the one under way started and ends, and when the next one starts (level time, s). */
  startT = 0;
  endT = 0;
  nextT = Infinity;

  private data: MischiefData | null = null;
  private last: MischiefName | null = null;
  private readonly rng: Rng | null;
  /** The level time of the last step. */
  private now = 0;
  private readonly pending: MischiefCue[] = [];
  private readonly riders = new Map<string, Rider>();
  /** Who rides each vine ('' = nobody): one creature to a vine. */
  private readonly vineRider: string[] = [];
  /** When each creature last let go of a vine (s). */
  private readonly letGo = new Map<string, number>();
  /** Who the train has bumped on the way it is running now, and which way that is (0 out, 1 back). */
  private readonly bumped = new Set<string>();
  private leg = 0;
  /** The train's floor: its ends and top (m). */
  private trackL = 0;
  private trackR = 0;
  private trackY = 0;
  private readonly g0: V2 = { x: 0, y: 0 };
  private readonly g1: V2 = { x: 0, y: 0 };
  private readonly box: TrainBox = { x: 0, y: 0, w: TRAIN_W, h: TRAIN_H, dir: 1, speed: 0 };

  /** The mischief of `level`, timed by `rng` (null for a level without any). The first comes 30–45 s in. */
  constructor(level: Level, rng: Rng | null) {
    this.base = this.level = level;
    this.rng = level.mischief.length ? rng : null;
    if (this.rng) this.nextT = MISCHIEF_GAP.min + this.rng() * MISCHIEF_GAP.spread;
  }

  /**
   * Starts mischief `name` now (level time `t`), ending any under way first; it lasts `length` s if given (tests, the
   * dev page), else 6–10 s. The next one is timed from this start. The level must have it.
   */
  start(name: MischiefName, t: number, length?: number): void {
    const data = this.base.mischief.find((m) => m.name === name);
    if (!data || !this.rng) throw new Error(`LevelMischief.start: the ${this.base.id} level has no ${name}`);
    if (this.active) this.stop(t);
    const r = this.rng;
    this.data = data;
    this.active = this.last = name;
    this.now = this.startT = t;
    this.endT = t + (length ?? MISCHIEF_LEN.min + r() * MISCHIEF_LEN.spread);
    this.nextT = t + MISCHIEF_GAP.min + r() * MISCHIEF_GAP.spread;
    this.side = r() < 0.5 ? -1 : 1;
    if (data.name === 'lowGravity') this.level = lowGravity(this.base);
    if (data.name === 'vines') {
      this.vineRider.length = data.vines.length;
      this.vineRider.fill('');
    }
    if (data.name === 'toyTrain') {
      const track = this.base.platforms.find((p) => p.id === data.track)!;
      this.trackL = track.x - track.w / 2;
      this.trackR = track.x + track.w / 2;
      this.trackY = track.y;
      this.leg = 0;
      this.bumped.clear();
    }
    this.pending.push({ name, phase: 'start' });
  }

  /**
   * One fight step at level time `t`, after everyone has moved (`fs` in play, `plats` the platforms now): the timer
   * (an end or a start), then the effects of the one under way. Train bumps go to `bumps`.
   */
  step(t: number, fs: readonly StageFighter[], plats: readonly Platform[], bumps: MischiefBump[]): void {
    this.now = t;
    if (this.active && t >= this.endT - T_EPS) this.stop(t);
    else if (!this.active && this.rng && t >= this.nextT - T_EPS) this.start(this.pick(), t);
    const d = this.data;
    if (!d) return;
    if (d.name === 'river' || d.name === 'airlock') this.drift(fs, plats);
    else if (d.name === 'vines') this.swing(d.vines, t, fs);
    else if (d.name === 'toyTrain') this.runTrain(fs, bumps);
  }

  /**
   * Ends the one under way now (level time `t`: its `end` cue; riders let go, gravity comes back) and starts no more
   * (the crowning: the fight is over on this level).
   */
  end(t: number): void {
    if (this.active) this.stop(t);
    this.nextT = Infinity;
  }

  /** Hands over the start and end cues not yet passed on. */
  takeCues(out: MischiefCue[]): void {
    if (this.pending.length) out.push(...this.pending.splice(0));
  }

  /** Forgets a fighter taken off the stage (off its vine). */
  forget(id: string): void {
    this.unride(id, this.now);
    this.letGo.delete(id);
  }

  /**
   * The sideways speed (m/s) the mischief puts on fighter `f` now: the airlock's pull on everyone, the river's current
   * on those standing on the flooded floor; 0 for the held, the riders and the frozen. (The brains lean against it.)
   */
  driftOn(f: StageFighter): number {
    const d = this.data;
    if (!d || (d.name !== 'airlock' && d.name !== 'river')) return 0;
    const a = f.action;
    if (a === 'held' || a === 'out' || a === 'frozen' || this.riders.has(f.id)) return 0;
    if (d.name === 'airlock') return this.side * AIRLOCK_PULL;
    return f.mover.ground === d.floor ? this.side * RIVER_SPEED : 0;
  }

  /** How many vines are out now (0 when it is not vine time). */
  vineCount(): number {
    return this.data?.name === 'vines' ? this.data.vines.length : 0;
  }

  /** Vine `i` while the vines are out, else null. */
  vine(i: number): Vine | null {
    const d = this.data;
    return d?.name === 'vines' ? d.vines[i] ?? null : null;
  }

  /** Where vine `i`'s grip is at time `t`, or null when the vines are not out. Fills and returns `out`. */
  grip(i: number, t: number, out: V2): V2 | null {
    const d = this.data;
    if (!d || d.name !== 'vines' || i < 0 || i >= d.vines.length) return null;
    return vineGrip(d.vines[i], t, out);
  }

  /** The vine fighter `id` rides, or −1. */
  riding(id: string): number {
    return this.riders.get(id)?.vine ?? -1;
  }

  /** Whether vine `i` has a rider. */
  vineTaken(i: number): boolean {
    return !!this.vineRider[i];
  }

  /** The toy train now, or null when it is not running. Fills and returns `out`. */
  train(out: TrainBox): TrainBox | null {
    if (this.data?.name !== 'toyTrain') return null;
    const span = this.trackR - this.trackL + TRAIN_W, len = this.endT - this.startT;
    const left = this.trackL - TRAIN_W / 2, right = this.trackR + TRAIN_W / 2;
    const speed = (2 * span) / len;
    const u = Math.min(2 * span, (this.now - this.startT) * speed);
    const out1 = u <= span;
    const dir = out1 ? this.side : (-this.side as 1 | -1);
    const d = out1 ? u : u - span;
    out.x = dir > 0 ? left + d : right - d;
    out.y = this.trackY;
    out.w = TRAIN_W;
    out.h = TRAIN_H;
    out.dir = dir;
    out.speed = speed;
    return out;
  }

  /** Ends the one under way: riders let go (keeping the swing), gravity comes back. */
  private stop(t: number): void {
    const name = this.active!;
    for (const id of [...this.riders.keys()]) this.unride(id, t);
    this.level = this.base;
    this.active = null;
    this.data = null;
    this.pending.push({ name, phase: 'end' });
  }

  /** The next one: any of the level's, but not the last one again when it has two. */
  private pick(): MischiefName {
    const all = this.base.mischief;
    const options = all.length > 1 ? all.filter((m) => m.name !== this.last) : all;
    return options[Math.floor(this.rng!() * options.length)].name;
  }

  /** The river's current or the airlock's pull: each fighter it moves slides that way, never into a solid platform. */
  private drift(fs: readonly StageFighter[], plats: readonly Platform[]): void {
    for (const f of fs) {
      const v = this.driftOn(f), m = f.mover;
      // a hit's freeze holds the fighter still, current or not
      if (v === 0 || f.freeze > 0) continue;
      const x = m.pos.x + v * DT;
      if (!solidAt(plats, x, m.pos.y, m.w, m.h)) m.pos.x = x;
    }
  }

  /**
   * The vines: a rider lets go when it jumps (a jump off a vine is free: its air jumps come back), lands on something,
   * is hit or busy (anything but flying or an air swing), or has ridden RIDE_MAX; the rest hang from their grips and
   * swing with them (their speed is the grip's, so they fly off with the swing). Then anyone free in the air whose
   * hands reach a free vine's grip catches it.
   */
  private swing(vines: readonly Vine[], t: number, fs: readonly StageFighter[]): void {
    for (const f of fs) {
      const r = this.riders.get(f.id);
      if (!r) continue;
      const m = f.mover, jumped = f.events.includes('airJump') || f.events.includes('recover');
      if (jumped || m.ground !== null || (f.action !== 'air' && f.action !== 'attack') || t - r.since >= RIDE_MAX - T_EPS) {
        this.unride(f.id, t);
        if (jumped) {
          m.airJumpsLeft = f.stats.moves.airJumps;
          m.recoveryUsed = false;
        }
        continue;
      }
      this.hang(f, vines[r.vine], r, t);
    }
    for (const f of fs) {
      const m = f.mover;
      if (this.riders.has(f.id) || f.action !== 'air' || m.ground !== null || f.freeze > 0) continue;
      if (t - (this.letGo.get(f.id) ?? -Infinity) < REGRAB) continue;
      const hx = m.pos.x, hy = m.pos.y + m.h;
      for (let i = 0; i < vines.length; i++) {
        if (this.vineRider[i]) continue;
        const g = vineGrip(vines[i], t, this.g0);
        if (Math.abs(g.x - hx) > m.w / 2 + GRIP_R || g.y - hy > GRIP_R || hy - g.y > GRIP_DOWN) continue;
        const r: Rider = { vine: i, since: t, ex: hx - g.x, ey: hy - g.y };
        this.riders.set(f.id, r);
        this.vineRider[i] = f.id;
        m.airJumpsLeft = f.stats.moves.airJumps;
        m.recoveryUsed = false;
        this.hang(f, vines[i], r, t);
        break;
      }
    }
  }

  /** Puts a rider's hands on its grip (eased in just after the catch) and gives it the grip's speed. */
  private hang(f: StageFighter, v: Vine, r: Rider, t: number): void {
    const m = f.mover, g = vineGrip(v, t, this.g0), p = vineGrip(v, t - DT, this.g1);
    const k = Math.max(0, 1 - (t - r.since) / CATCH_EASE);
    m.pos.x = g.x + r.ex * k;
    m.pos.y = g.y + r.ey * k - m.h;
    m.vel.x = (g.x - p.x) / DT;
    m.vel.y = (g.y - p.y) / DT;
    m.ground = null;
  }

  private unride(id: string, t: number): void {
    const r = this.riders.get(id);
    if (!r) return;
    this.riders.delete(id);
    if (this.vineRider[r.vine] === id) this.vineRider[r.vine] = '';
    this.letGo.set(id, t);
  }

  /**
   * The toy train runs out along its floor (from hiding past one end) and back: everyone it meets on the way it is
   * running is bumped up and along, once a way (a dodge's no-hit moment lets it pass).
   */
  private runTrain(fs: readonly StageFighter[], bumps: MischiefBump[]): void {
    const tr = this.train(this.box)!;
    const leg = tr.dir === this.side ? 0 : 1;
    if (leg !== this.leg) {
      this.leg = leg;
      this.bumped.clear();
    }
    for (const f of fs) {
      const m = f.mover;
      if (this.bumped.has(f.id) || !f.canBeHit()) continue;
      if (Math.abs(m.pos.x - tr.x) >= (m.w + tr.w) / 2 || m.pos.y >= tr.y + tr.h || m.pos.y + m.h <= tr.y) continue;
      const launch = f.takeHit({ power: TRAIN_POWER, damage: TRAIN_DAMAGE, angle: TRAIN_ANGLE, from: tr.dir });
      this.bumped.add(f.id);
      bumps.push({ by: 'toyTrain', target: f.id, at: { x: m.pos.x, y: m.pos.y + m.h / 2 }, launch, tumble: f.action === 'tumble' });
    }
  }
}
