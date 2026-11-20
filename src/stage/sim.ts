import type { SpecialName } from '../fight/special';
import { mulberry32, type Rng } from '../util/rng';
import type { BodyStats } from './body';
import { STAGE_TUNE, type StageTune } from './damage';
import { StageFighter, type StageHit } from './fighter';
import {
  carrySpot, grabbable, grabReach, THROW_ANGLE, THROW_DAMAGE, THROW_POWER, THROW_RELEASE, THROW_UP_ANGLE, type GrabCue,
} from './grab';
import { ItemDrops, type ItemCue } from './items';
import { platformsAt, solidAt, type Level, type Platform } from './level';
import { LevelMischief, type MischiefBump, type MischiefCue } from './mischief';
import type { MoveEvent } from './move';
import type { StageSpecialCue } from './specials';
import { DT, NO_INTENT, type Intent, type V2 } from './types';

export type { GrabCue } from './grab';
export type { StageSpecialCue } from './specials';
export type { MischiefBump, MischiefCue } from './mischief';
export type { ItemCue } from './items';

/**
 * What happened in one step, for the show and the headless bouts: hits that landed, who went out (each once, in the
 * step it crossed the bounds), every fighter's movement events (a bouncy platform's spring is a `bounce`), the special
 * and grab cues, presents and power-ups (`items`), mischief starting and ending, and creatures the mischief bumped (the
 * toy train).
 */
export type StageEvents = {
  hits: StageHit[];
  outs: string[];
  moves: { id: string; e: MoveEvent }[];
  specials: StageSpecialCue[];
  grabs: GrabCue[];
  items: ItemCue[];
  mischief: MischiefCue[];
  bumps: MischiefBump[];
};

/** The push apart of two overlapping fighters never moves either faster than this (m/s): gentle, never a launch. */
const PUSH_SPEED = 3;

/**
 * A live strike (an attack's or a special's) as it stood once everyone had acted: its hit circle and blow, and the
 * attacker's facing and x (for which way it pushes). Kept apart from the attacker so a hit landing on the attacker the
 * same step (which cancels its attack and turns it) does not stop its own swing: a trade hits both.
 */
type Swing = {
  f: StageFighter; x: number; y: number; r: number; power: number; damage: number; angle: number; around: boolean;
  ground: boolean; special: SpecialName | null; facing: 1 | -1; ax: number;
};

const noEvents = (): StageEvents => ({ hits: [], outs: [], moves: [], specials: [], grabs: [], items: [], mischief: [], bumps: [] });

/**
 * The fight on a level: its fighters (kept in the order they were added, which every step follows, so a bout replays
 * exactly), the level time `t` (s) and the fight steps taken. Each step every fighter acts on its wanting, then grabs
 * catch, throws let go and held fighters are carried overhead, then attacks and specials are checked against everyone
 * (one blow hits a given fighter once; a landed hit freezes both), overlapping fighters are pushed gently apart, and
 * anyone past the bounds is out. Before the grabs, a bouncy platform springs back up whoever landed on it and the
 * level's mischief (`mischief`) does its bit. The entrance freeze holds everything still.
 */
export class StageSim {
  /** Level time (s): it runs only while the fight steps (not during the entrance freeze). */
  t = 0;
  /** Fight steps taken. */
  steps = 0;
  readonly tune: StageTune;
  /** The fight's random numbers. */
  readonly rng: Rng;
  /** The level's mischief: its timer, the one under way and its effects (the show draws vines, the train…). */
  readonly mischief: LevelMischief;
  /** The presents and power-ups: presents on the level, pies in flight (the show draws them), the drop timer. */
  readonly items: ItemDrops;

  /** Everyone added and not removed, out ones too, in add order. */
  private readonly all: StageFighter[] = [];
  /** Those still in play (not out), in add order; rebuilt when someone joins, leaves or goes out. */
  private live: StageFighter[] = [];
  private frozen = false;
  /** Per fighter in play: this step's push apart (m), and the platforms now (both reused every step). */
  private readonly push: number[] = [];
  private readonly plats: Platform[] = [];
  /** This step's live strikes, taken before any hit lands (reused every step; `n` of them in use). */
  private readonly swings: Swing[] = [];
  /** Cues from fighters taken off the stage, passed on with the next step. */
  private readonly pendingSpecials: StageSpecialCue[] = [];
  private readonly pendingGrabs: GrabCue[] = [];
  private readonly pendingItems: ItemCue[] = [];
  /** Scratch: a grab's hands, a carry spot. */
  private readonly hands = { x: 0, y: 0, r: 0 };
  private readonly spot: V2 = { x: 0, y: 0 };

  /**
   * A fight on `level`. A level with mischief takes one number from `rng` to seed the mischief's own timer (so its
   * timing does not depend on what the fighters do); a level without any takes none. With `items` on, presents drop
   * about every 15 s, timed and filled by one more number taken from `rng` the same way; off (the default, for tests
   * of the fight itself), none drop on their own (`items.drop` still drops one) and no number is taken.
   */
  constructor(o: { level: Level; rng: Rng; tune?: StageTune; items?: boolean }) {
    this.rng = o.rng;
    this.tune = o.tune ?? STAGE_TUNE;
    this.mischief = new LevelMischief(o.level, o.level.mischief.length ? mulberry32(Math.floor(o.rng() * 2 ** 32)) : null);
    this.items = new ItemDrops(o.level, o.items ? mulberry32(Math.floor(o.rng() * 2 ** 32)) : null);
  }

  /** The level as it is now: during low gravity, a low-gravity copy (a different object: ruling R27). */
  get level(): Level {
    return this.mischief.level;
  }

  /**
   * A new fighter, standing on `at` (bottom centre) or, without it, at the level entry furthest from everyone in play.
   * It is placed only in free space: if `at` is inside a solid platform it is lifted onto that platform's top. It
   * starts in the air with its air jumps and lands on the next steps. Added during the entrance freeze, it is frozen too.
   */
  add(id: string, stats: BodyStats, at?: V2): StageFighter {
    if (this.get(id)) throw new Error(`StageSim.add: "${id}" is already on the stage`);
    const f = new StageFighter(id, stats, at ?? this.freeEntry(), this.tune);
    this.placeFree(f);
    if (this.frozen) f.setFrozen(true);
    this.all.push(f);
    this.refresh();
    return f;
  }

  /**
   * Takes a fighter off the stage at once, whatever it is doing (no-op if it is not here): a special under way ends, a
   * hold either way round lets go and its power-up is gone (those cues come with the next step), so nobody and nothing
   * is left stuck (a pie it already threw flies on).
   */
  remove(id: string): void {
    const i = this.all.findIndex((f) => f.id === id);
    if (i < 0) return;
    const f = this.all[i];
    f.leave();
    this.mischief.forget(id);
    this.pendingSpecials.push(...f.specialCues);
    this.pendingGrabs.push(...f.grabCues);
    this.pendingItems.push(...f.itemCues);
    f.specialCues.length = 0;
    f.grabCues.length = 0;
    f.itemCues.length = 0;
    this.all.splice(i, 1);
    this.refresh();
  }

  get(id: string): StageFighter | undefined {
    return this.all.find((f) => f.id === id);
  }

  /** The fighters in play (not out), in add order. The same array until someone joins, leaves or goes out. */
  fighters(): readonly StageFighter[] {
    return this.live;
  }

  /**
   * The entrance freeze. On: nothing moves, no timer runs (level time and moving platforms included) and steps do
   * nothing; off: the fight carries on exactly where it stopped.
   */
  freeze(on: boolean): void {
    this.frozen = on;
    for (const f of this.all) f.setFrozen(on);
  }

  /**
   * The crowning (Task 15): the fight on this level is over, cleanly. Every fighter in play stops what it was doing
   * (`StageFighter.calm`: specials end, holds let go, power-ups end; a launch runs its course), presents and pies are
   * gone, the mischief under way ends and none comes again, and no more presents drop. Their cues come with the next
   * step. Works in the entrance freeze too.
   */
  calm(): void {
    for (const f of this.live) f.calm();
    this.items.clear();
    this.mischief.end(this.t);
  }

  /**
   * Stands fighter `id` on `at` (bottom centre), still and in the air, so it lands there on the next steps (the
   * champion carried to the top platform). Never inside a solid platform: it is lifted onto its top. No-op if unknown.
   */
  put(id: string, at: V2): void {
    const f = this.get(id);
    if (!f) return;
    const m = f.mover;
    m.pos.x = at.x;
    m.pos.y = at.y;
    m.vel.x = m.vel.y = 0;
    m.ground = null;
    this.placeFree(f);
  }

  /**
   * One fight step (DT): each fighter acts on its intent (none = wanting nothing), then bouncy platforms and the
   * mischief, presents and power-ups (pies fly), grabs, throws and carrying, hits, push apart, outs; the special, grab,
   * item and mischief cues of the step come last.
   */
  step(intents: ReadonlyMap<string, Intent>): StageEvents {
    const ev = noEvents();
    if (this.frozen) {
      this.cues(ev);
      return ev;
    }
    const fs = this.live;
    for (const f of fs) {
      f.act(intents.get(f.id) ?? NO_INTENT, this.level, this.t);
      for (const e of f.events) ev.moves.push({ id: f.id, e });
    }
    this.steps++;
    this.t = this.steps * DT;
    platformsAt(this.level, this.t, this.plats);
    this.bounces(fs, ev);
    this.mischief.step(this.t, fs, this.plats, ev.bumps);
    this.items.step(this.t, this.level, fs, this.plats);
    this.grabs(fs, ev.hits);
    this.hits(fs, ev.hits);
    this.pushApart(fs);
    let gone = false;
    for (const f of fs) {
      if (f.action !== 'out') continue;
      ev.outs.push(f.id);
      gone = true;
    }
    this.cues(ev);
    if (gone) this.refresh();
    return ev;
  }

  /**
   * Passes on the special, grab and item cues (those of fighters taken off the stage first, then everyone's in play),
   * and the mischief's.
   */
  private cues(ev: StageEvents): void {
    this.mischief.takeCues(ev.mischief);
    if (this.pendingSpecials.length) ev.specials.push(...this.pendingSpecials.splice(0));
    if (this.pendingGrabs.length) ev.grabs.push(...this.pendingGrabs.splice(0));
    if (this.pendingItems.length) ev.items.push(...this.pendingItems.splice(0));
    this.items.takeCues(this.live, ev.items);
    for (const f of this.live) {
      if (f.specialCues.length) {
        ev.specials.push(...f.specialCues);
        f.specialCues.length = 0;
      }
      if (f.grabCues.length) {
        ev.grabs.push(...f.grabCues);
        f.grabCues.length = 0;
      }
    }
  }

  /** Springs back up whoever landed on a bouncy platform this step, at its jump speed × the platform's bounce. */
  private bounces(fs: readonly StageFighter[], ev: StageEvents): void {
    for (const f of fs) {
      const m = f.mover;
      if (m.ground === null || !f.events.includes('land')) continue;
      let p: Platform | null = null;
      for (const q of this.plats) if (q.id === m.ground) p = q;
      if (!p?.bounce) continue;
      m.vel.y = f.stats.moves.jump * p.bounce;
      m.ground = null;
      ev.moves.push({ id: f.id, e: 'bounce' });
    }
  }

  /**
   * Grabs, throws and carrying, in add order: a grab whose hands touch a fighter that can be caught catches the first
   * such (the holder lifts it); a throw at its release step launches the held one like a hit (a landed throw, reported
   * with the hits); then every held fighter is carried to its holder's spot overhead (in front if a solid platform is in
   * the way overhead; let go if both are blocked). By design this all comes before the step's strikes: a grab beats a
   * live attack (the one caught mid-swing is held and its swing is gone), as a throw beats a hit landing the same step.
   */
  private grabs(fs: readonly StageFighter[], out: StageHit[]): void {
    for (const a of fs) {
      const hands = grabReach(a, this.hands);
      if (!hands) continue;
      for (const b of fs) {
        if (b === a || !grabbable(b) || !this.touches(hands.x, hands.y, hands.r, b)) continue;
        a.seize(b);
        break;
      }
    }
    for (const a of fs) {
      if (a.action !== 'throw' || !a.holding || a.actionT < THROW_RELEASE) continue;
      const b = a.release()!;
      const angle = a.throwDir === 'up' ? THROW_UP_ANGLE : THROW_ANGLE;
      // (a grown holder throws harder)
      const power = THROW_POWER * a.powerShare();
      const launch = b.takeHit({ power, damage: THROW_DAMAGE, angle, from: a.facing, byKid: a.kid });
      if (launch <= 0) {
        // a Bubble Shield stopped the throw: a let-go, the held one drops free now (ruling R36)
        a.throwStopped(b);
        continue;
      }
      const at = { x: b.mover.pos.x, y: b.mover.pos.y + b.mover.h / 2 };
      a.freeze = this.tune.hitFreeze;
      a.landed(null, at);
      out.push({ attacker: a.id, target: b.id, at, power, launch, tumble: b.action === 'tumble' });
    }
    for (const a of fs) {
      const b = a.holding;
      if (!b || b.action !== 'held') continue;
      const m = b.mover;
      let p = carrySpot(a, b, false, this.spot);
      if (this.inSolid(p.x, p.y, m.w, m.h)) p = carrySpot(a, b, true, this.spot);
      if (this.inSolid(p.x, p.y, m.w, m.h)) {
        a.letGo();
        continue;
      }
      m.pos.x = p.x;
      m.pos.y = p.y;
      m.vel.x = m.vel.y = 0;
    }
  }

  /** Whether a circle touches fighter `b`'s box. */
  private touches(x: number, y: number, r: number, b: StageFighter): boolean {
    const p = b.mover.pos, hw = b.mover.w / 2;
    const nx = Math.max(p.x - hw, Math.min(x, p.x + hw)), ny = Math.max(p.y, Math.min(y, p.y + b.mover.h));
    return (nx - x) ** 2 + (ny - y) ** 2 <= r * r;
  }

  /**
   * Every strike live this step (attacks and specials) against everyone else, in add order. All the strikes are taken
   * first, so a hit landing on an attacker never cancels the swing it threw the same step (a trade hits both). A hit
   * lands when the strike's circle touches the target's box, the target can be hit (a slam's shockwave: and stands on
   * something) and this attack or blow has not hit it yet; the attacker freezes too.
   */
  private hits(fs: readonly StageFighter[], out: StageHit[]): void {
    const swings = this.swings;
    let n = 0;
    for (const f of fs) {
      const k = f.strike();
      if (!k) continue;
      const s = swings[n] ?? (swings[n] = {
        f, x: 0, y: 0, r: 0, power: 0, damage: 0, angle: 0, around: false, ground: false, special: null, facing: 1, ax: 0,
      });
      s.f = f;
      s.x = k.x;
      s.y = k.y;
      s.r = k.r;
      s.power = k.power;
      s.damage = k.damage;
      s.angle = k.angle;
      s.around = k.around;
      s.ground = k.ground;
      s.special = k.special;
      s.facing = f.facing;
      s.ax = f.mover.pos.x;
      n++;
    }
    for (let i = 0; i < n; i++) {
      const s = swings[i], a = s.f;
      for (const b of fs) {
        if (b === a || a.attackHits.has(b.id) || !b.canBeHit() || (s.ground && b.mover.ground === null)) continue;
        const p = b.mover.pos, hw = b.mover.w / 2;
        // The point of the target's box nearest the circle's centre.
        const nx = Math.max(p.x - hw, Math.min(s.x, p.x + hw));
        const ny = Math.max(p.y, Math.min(s.y, p.y + b.mover.h));
        if ((nx - s.x) ** 2 + (ny - s.y) ** 2 > s.r ** 2) continue;
        a.attackHits.add(b.id);
        // Along the facing, or away from the body for a blow all around it (as StageFighter.pushToward).
        const from = s.around && p.x !== s.ax ? (p.x > s.ax ? 1 : -1) : s.facing;
        const launch = b.takeHit({ power: s.power, damage: s.damage, angle: s.angle, from, byKid: a.kid });
        if (launch <= 0) continue;
        const at = { x: nx, y: ny };
        a.freeze = this.tune.hitFreeze;
        a.landed(s.special, at);
        const hit: StageHit = { attacker: a.id, target: b.id, at, power: s.power, launch, tumble: b.action === 'tumble' };
        if (s.special) hit.special = s.special;
        out.push(hit);
      }
    }
  }

  /**
   * Overlapping fighters drift apart sideways, each at most PUSH_SPEED, never more than the overlap: positions only, no
   * speed is added, so nobody is launched. Two on the same spot part by add order (the earlier to the left). A push
   * never moves a fighter into a solid platform, nor its centre off the edge of the platform it stands on.
   */
  private pushApart(fs: readonly StageFighter[]): void {
    const n = fs.length, push = this.push, max = PUSH_SPEED * DT;
    push.length = n;
    push.fill(0);
    for (let i = 0; i < n; i++) {
      // the held are carried, not pushed
      if (fs[i].action === 'out' || fs[i].action === 'held') continue;
      const a = fs[i].mover;
      for (let j = i + 1; j < n; j++) {
        if (fs[j].action === 'out' || fs[j].action === 'held') continue;
        const b = fs[j].mover;
        if (a.pos.y >= b.pos.y + b.h || b.pos.y >= a.pos.y + a.h) continue;
        const dx = b.pos.x - a.pos.x;
        const overlap = (a.w + b.w) / 2 - Math.abs(dx);
        if (overlap <= 0) continue;
        const s = Math.min(overlap / 2, max) * (dx < 0 ? -1 : 1);
        push[i] -= s;
        push[j] += s;
      }
    }
    for (let i = 0; i < n; i++) {
      if (push[i] === 0) continue;
      const m = fs[i].mover;
      let d = Math.max(-max, Math.min(max, push[i]));
      if (m.ground !== null) {
        let g: Platform | null = null;
        for (const p of this.plats) if (p.id === m.ground) g = p;
        if (g) {
          const lo = g.x - g.w / 2, hi = g.x + g.w / 2;
          d = d > 0 ? Math.min(d, Math.max(0, hi - m.pos.x)) : Math.max(d, Math.min(0, lo - m.pos.x));
        }
      }
      if (d !== 0 && !this.inSolid(m.pos.x + d, m.pos.y, m.w, m.h)) m.pos.x += d;
    }
  }

  /** Whether a box (bottom centre x, y) would overlap a solid platform (as the platforms are now). */
  private inSolid(x: number, y: number, w: number, h: number): boolean {
    return solidAt(this.plats, x, y, w, h) !== null;
  }

  /** Lifts a newcomer out of any solid platform it was placed in, onto its top. */
  private placeFree(f: StageFighter): void {
    const m = f.mover;
    platformsAt(this.level, this.t, this.plats);
    for (let k = 0; k <= this.plats.length; k++) {
      const p = solidAt(this.plats, m.pos.x, m.pos.y, m.w, m.h);
      if (!p) return;
      m.pos.y = p.y;
    }
  }

  /** The level entry whose nearest fighter in play is furthest away (the first entry when the stage is empty). */
  private freeEntry(): V2 {
    let best = this.level.entries[0] ?? { x: 0, y: 0 }, bestD = -1;
    for (const e of this.level.entries) {
      let d = Infinity;
      for (const f of this.live) d = Math.min(d, Math.hypot(f.mover.pos.x - e.x, f.mover.pos.y - e.y));
      if (d > bestD) {
        bestD = d;
        best = e;
      }
    }
    return { x: best.x, y: best.y };
  }

  private refresh(): void {
    this.live = this.all.filter((f) => f.action !== 'out');
  }
}
