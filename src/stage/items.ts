import type { Rng } from '../util/rng';
import type { Attack, AttackDir } from './attacks';
import { attackSet } from './attacks';
import type { BodyStats } from './body';
import type { StageFighter } from './fighter';
import { solidAt, type Level, type Platform } from './level';
import { DT, type V2 } from './types';

/**
 * Presents and power-ups (spec §8). About every 15 s a present parachutes down at one of the level's drop spots and
 * lands on the first platform below it; a creature touching it opens it and gets what is inside:
 * - Grow Juice: 10 s huge (box and look ×1.6, from its bottom centre, as soon as there is room overhead: ruling R7),
 *   hitting ×1.4 as hard and ×1.6 as heavy (hard to launch).
 * - Zoom Sneakers: 10 s running ×1.5 as fast, with an extra air jump.
 * - Pool Noodle (held): its next 4 swings are noodle bonks, reaching much further and hitting ×1.5 as hard.
 * - Custard Pie (held): `item` throws it in an arc; a creature it splats is stunned 1.2 s.
 * - Bubble Shield: the next 3 hits bounce off it, then it pops.
 * - Ice Pop: cools the creature right down: its damage back to 0.
 * A creature has one power-up at a time: opening another ends the one it has (an Ice Pop just cools it, keeping what
 * it has). One that goes out or leaves the stage loses its power-up. Everything random (when, where, what) comes from
 * the fight's own seeded numbers; nothing moves while the fight is frozen.
 */
export type ItemName = 'growJuice' | 'zoomSneakers' | 'poolNoodle' | 'custardPie' | 'bubbleShield' | 'icePop';

/** Every power-up, in the spec's order. */
export const ITEM_NAMES: readonly ItemName[] = ['growJuice', 'zoomSneakers', 'poolNoodle', 'custardPie', 'bubbleShield', 'icePop'];

/** What the announcer calls each one. */
export const ITEM_TITLE: Record<ItemName, string> = {
  growJuice: 'GROW JUICE', zoomSneakers: 'ZOOM SNEAKERS', poolNoodle: 'POOL NOODLE', custardPie: 'CUSTARD PIE',
  bubbleShield: 'BUBBLE SHIELD', icePop: 'ICE POP',
};

/**
 * A present or power-up moment for the show: a present `drop`s (at the top of its fall) and `land`s; fighter `id` opens
 * it (`open`), `use`s the power-up (a noodle swing, a pie thrown, a hit the shield stopped, growing, the ice pop) and
 * its power-up `end`s (run out, popped, the last swing done, a thrown pie gone — with `target` only when it splatted a
 * creature and stunned it, never when a shield stopped it — or lost going out). A present nobody opened ends without an `id` (it wrapped itself up, or fell off the level).
 */
export type ItemCue = { phase: 'drop' | 'land' | 'open' | 'use' | 'end'; item: ItemName; id?: string; at: V2; target?: string };

/** A present parachutes down every this many seconds, give or take the spread (s), the first that long into the fight. */
export const PRESENT_GAP = { mean: 15, spread: 3 };
/** How fast a present floats down under its parachute (m/s). */
export const PRESENT_FALL = 3;
/** A present's box: this wide and tall (m). It starts falling this far above the top of the camera's view. */
export const PRESENT_SIZE = 0.6, PRESENT_ABOVE = 1;
/** An unopened present wraps itself up and goes after lying this long (s). */
export const PRESENT_LIFE = 20;
/** At most this many presents on the level at once (one due while there are already this many waits for the next). */
export const MAX_PRESENTS = 2;

/** Grow Juice: how long (s), the size of box and look, and hit power and weight shares while it lasts. */
export const GROW = { seconds: 10, size: 1.6, power: 1.4, weight: 1.6 } as const;
/** Steps the look takes to grow or shrink (display: the box changes at once). */
export const GROW_EASE = 12;
/** Zoom Sneakers: how long (s), the share of run speed (and the speeding up to it), and the extra air jumps. */
export const ZOOM = { seconds: 10, run: 1.5, airJumps: 1 } as const;
/**
 * Pool Noodle: swings, how much further a swing reaches (m, ahead of the body's own reach; an around-the-body swing gets
 * that much more radius), its radius share, and its power share.
 */
export const NOODLE = { swings: 4, reach: 1.1, radius: 1.25, power: 1.5 } as const;
/**
 * Custard Pie: thrown forward at `speed` and up at `up` (m/s), a ball of radius `r` (m); it stuns the creature it splats
 * for `stun` s and adds a dab of damage. The throw winds up `windup` steps (the pie leaves the hand then) and recovers
 * `cool` steps.
 */
export const PIE = { speed: 10, up: 5, r: 0.25, stun: 1.2, damage: 2, windup: 7, cool: 12 } as const;
/** The pie leaves the hand this far in front of the box and this share of its height up. */
export const PIE_HAND = 0.15, PIE_HIGH = 0.7;
/** Bubble Shield: how many hits it stops. */
export const SHIELD_HITS = 3;

/** Power-ups that last a while (and make the creature sparkle). */
export const TIMED_ITEMS: ReadonlySet<ItemName> = new Set<ItemName>(['growJuice', 'zoomSneakers']);
/** Power-ups held in the hand. */
export const HELD_ITEMS: ReadonlySet<ItemName> = new Set<ItemName>(['poolNoodle', 'custardPie']);

/**
 * A present on the level: what is inside, its box's bottom centre, and once it has landed, the platform it sits on
 * (riding along with a moving one, `dx` from its centre) and when it landed (level time, s).
 */
export type Present = { id: number; item: ItemName; x: number; y: number; on: string | null; dx: number; landT: number };

/** A custard pie in flight: who threw it, its centre and speed, and whether its thrower had kid power as it threw. */
export type Pie = { from: string; x: number; y: number; vx: number; vy: number; kid?: boolean };

/** Slack for "the time has come" (s) and for tops (m), far below a step. */
const T_EPS = 1e-9, EPS = 1e-6;

const grown = new WeakMap<BodyStats, BodyStats>();
const zoomed = new WeakMap<BodyStats, BodyStats>();
const noodles = new WeakMap<BodyStats, Record<AttackDir, Attack>>();
const pies = new WeakMap<BodyStats, Attack>();

/**
 * `base` on Grow Juice: box, reach and height ×GROW.size, weight ×GROW.weight; the same movement. A new object, made
 * once per body (the same one every call), never `base` changed (ruling R27).
 */
export function grownStats(base: BodyStats): BodyStats {
  let s = grown.get(base);
  if (!s) {
    const k = GROW.size;
    grown.set(base, (s = { ...base, height: base.height * k, w: base.w * k, h: base.h * k, reach: base.reach * k, weight: base.weight * GROW.weight }));
  }
  return s;
}

/**
 * `base` in Zoom Sneakers: run and its speeding up ×ZOOM.run, ZOOM.airJumps more air jumps. New BodyStats and
 * MoveStats objects, made once per body, never `base` changed (the brains' route graphs are cached by the MoveStats
 * object: ruling R27).
 */
export function zoomStats(base: BodyStats): BodyStats {
  let s = zoomed.get(base);
  if (!s) {
    const m = base.moves, k = ZOOM.run;
    zoomed.set(base, (s = { ...base, moves: { ...m, run: m.run * k, accel: m.accel * k, airAccel: m.airAccel * k, airJumps: m.airJumps + ZOOM.airJumps } }));
  }
  return s;
}

/** The body's four attacks as Pool Noodle swings: reaching NOODLE.reach further, NOODLE.power as hard (once per body). */
export function noodleSet(stats: BodyStats): Record<AttackDir, Attack> {
  let set = noodles.get(stats);
  if (!set) {
    const base = attackSet(stats);
    const bonk = (a: Attack): Attack => ({
      ...a,
      power: a.power * NOODLE.power,
      area: a.around
        ? { dx: 0, dy: a.area.dy, r: a.area.r * NOODLE.radius + NOODLE.reach }
        : { dx: a.area.dx + NOODLE.reach, dy: a.area.dy, r: a.area.r * NOODLE.radius },
    });
    noodles.set(stats, (set = { forward: bonk(base.forward), up: bonk(base.up), down: bonk(base.down), air: bonk(base.air) }));
  }
  return set;
}

/**
 * The custard pie throw as an attack with no blow of its own (no active steps: it never hits), so it is posed as a
 * forward swing: PIE.windup steps winding up, PIE.cool recovering. Once per body.
 */
export function pieThrow(stats: BodyStats): Attack {
  let a = pies.get(stats);
  if (!a) {
    const f = attackSet(stats).forward;
    pies.set(stats, (a = { ...f, windup: PIE.windup, active: 0, cool: PIE.cool, power: 0, damage: 0, around: false, area: { dx: stats.reach, dy: stats.h * PIE_HIGH, r: f.area.r } }));
  }
  return a;
}

/**
 * The presents and power-ups of a fight: the drop timer (when the fight's `rng` is given: `null` drops none unless
 * asked with `drop`), the presents on the level, the pies in flight, and every fighter's power-up running on and
 * ending. The sim steps it after everyone has moved (`step`).
 */
export class ItemDrops {
  /** The presents on the level, oldest first. */
  readonly presents: Present[] = [];
  /** The custard pies in flight. */
  readonly pies: Pie[] = [];
  /** What a present can hold (all six; tests and the dev page may narrow it). */
  kinds: ItemName[] = [...ITEM_NAMES];
  /** When the next present drops (level time, s): never without the fight's random numbers. */
  nextT = Infinity;

  private readonly rng: Rng | null;
  private nextId = 0;
  private lastX = NaN;
  private readonly pending: ItemCue[] = [];

  /** The presents of a fight on `level`, timed and filled by `rng` (null: none drop on their own). */
  constructor(level: Level, rng: Rng | null) {
    this.rng = rng;
    if (rng && level.drops.length) this.nextT = this.gap();
  }

  /**
   * Drops a present now (level time `t`) above `x` (default: one of the level's drop spots, not the last one again),
   * holding `item` (default: one of `kinds`). Without the fight's random numbers both must be given.
   */
  drop(t: number, level: Level, item?: ItemName, x?: number): Present {
    const r = this.rng;
    if ((item === undefined || x === undefined) && !r) throw new Error('ItemDrops.drop: give the item and the spot (no random numbers)');
    if (x === undefined) {
      const spots = level.drops.length > 1 ? level.drops.filter((d) => d !== this.lastX) : level.drops;
      x = spots[Math.floor(r!() * spots.length)] ?? 0;
    }
    item ??= this.kinds[Math.floor(r!() * this.kinds.length)];
    this.lastX = x;
    const p: Present = { id: this.nextId++, item, x, y: level.camera.top + PRESENT_ABOVE, on: null, dx: 0, landT: 0 };
    this.presents.push(p);
    this.pending.push({ phase: 'drop', item, at: { x: p.x, y: p.y } });
    return p;
  }

  /**
   * One fight step at level time `t` on `level` (as it is now), after everyone has moved: `fs` in play (those just gone
   * out too), `plats` the platforms now. The drop timer; presents fall, land, ride their platform, are opened by the
   * first creature touching them, or wrap themselves up; every power-up runs on (Grow Juice grows once there is room,
   * a thrown pie leaves the hand) and ends when its time is up, its last swing is done, or its creature went out; pies fly
   * and splat.
   */
  step(t: number, level: Level, fs: readonly StageFighter[], plats: readonly Platform[]): void {
    if (t >= this.nextT - T_EPS) {
      if (this.presents.length < MAX_PRESENTS) this.drop(t, level);
      this.nextT = t + this.gap();
    }
    for (const f of fs) this.powerUp(f, t, plats);
    this.fall(t, level, fs, plats);
    this.fly(level, fs, plats);
  }

  /** Takes every present and pie off the level at once and drops no more (the crowning). */
  clear(): void {
    this.presents.length = 0;
    this.pies.length = 0;
    this.nextT = Infinity;
  }

  /** Hands over the cues not yet passed on: the presents' and pies' own, then each fighter's. */
  takeCues(fs: readonly StageFighter[], out: ItemCue[]): void {
    if (this.pending.length) out.push(...this.pending.splice(0));
    for (const f of fs) {
      if (!f.itemCues.length) continue;
      out.push(...f.itemCues);
      f.itemCues.length = 0;
    }
  }

  /** The next drop's wait: PRESENT_GAP.mean ± PRESENT_GAP.spread (s). */
  private gap(): number {
    return PRESENT_GAP.mean + (this.rng!() * 2 - 1) * PRESENT_GAP.spread;
  }

  /** Fighter `f`'s power-up this step: out, it is lost; a timed one runs out; the noodle's last swing ends it; growing; a pie thrown. */
  private powerUp(f: StageFighter, t: number, plats: readonly Platform[]): void {
    if (f.pieThrown) {
      f.pieThrown = false;
      const m = f.mover, at = { x: m.pos.x + f.facing * (m.w / 2 + PIE_HAND), y: m.pos.y + m.h * PIE_HIGH };
      this.pies.push({ from: f.id, x: at.x, y: at.y, vx: f.facing * PIE.speed, vy: PIE.up, kid: f.kid });
      f.itemCues.push({ phase: 'use', item: 'custardPie', id: f.id, at });
    }
    const it = f.item;
    if (!it) return;
    if (f.action === 'out') f.endItem();
    else if (TIMED_ITEMS.has(it) && t >= f.itemUntil - T_EPS) f.endItem();
    else if (it === 'poolNoodle' && f.itemUses <= 0 && f.action !== 'attack') f.endItem();
    else if (it === 'growJuice' && !f.grown) f.tryGrow(plats);
  }

  /** Presents falling, landing, riding, opened, or wrapping up. */
  private fall(t: number, level: Level, fs: readonly StageFighter[], plats: readonly Platform[]): void {
    const half = PRESENT_SIZE / 2;
    for (let i = 0; i < this.presents.length; i++) {
      const p = this.presents[i];
      if (p.on === null) {
        const y0 = p.y;
        p.y -= PRESENT_FALL * DT;
        // the highest top it crossed on the way down
        let land: Platform | null = null;
        for (const q of plats) {
          if (Math.abs(p.x - q.x) >= q.w / 2 + half || y0 < q.y - EPS || p.y > q.y) continue;
          if (!land || q.y > land.y) land = q;
        }
        if (land) {
          p.y = land.y;
          p.on = land.id;
          p.dx = p.x - land.x;
          p.landT = t;
          this.pending.push({ phase: 'land', item: p.item, at: { x: p.x, y: p.y } });
        } else if (p.y < level.bounds.bottom) {
          this.gone(i--, { phase: 'end', item: p.item, at: { x: p.x, y: p.y } });
          continue;
        }
      } else {
        let q: Platform | null = null;
        for (const o of plats) if (o.id === p.on) q = o;
        if (q) {
          p.x = q.x + p.dx;
          p.y = q.y;
        }
        if (t - p.landT >= PRESENT_LIFE - T_EPS) {
          this.gone(i--, { phase: 'end', item: p.item, at: { x: p.x, y: p.y } });
          continue;
        }
      }
      for (const f of fs) {
        if (!canOpen(f) || !touchesBox(f, p.x, p.y, PRESENT_SIZE, PRESENT_SIZE)) continue;
        // (the fighter sends the `open` cue)
        this.presents.splice(i--, 1);
        f.giveItem(p.item, t, p);
        break;
      }
    }
  }

  /** Takes present `i` off the level with `cue`. */
  private gone(i: number, cue: ItemCue): void {
    this.presents.splice(i, 1);
    this.pending.push(cue);
  }

  /** Pies in flight: an arc under the level's gravity; one splats on the first creature it touches (not its thrower) or a platform, or is gone past the bounds. */
  private fly(level: Level, fs: readonly StageFighter[], plats: readonly Platform[]): void {
    const g = level.gravity, b = level.bounds;
    for (let i = 0; i < this.pies.length; i++) {
      const p = this.pies[i];
      const y0 = p.y;
      p.x += p.vx * DT;
      p.y += (p.vy - (g * DT) / 2) * DT;
      p.vy -= g * DT;
      // the first creature it touches that it can hit: a splat (named on the cue), or a shield that stops it (no target)
      let spent = false;
      for (const f of fs) {
        if (f.id === p.from || !touchesCircle(f, p.x, p.y, PIE.r)) continue;
        const how = f.splat(p.kid);
        if (how === 'missed') continue;
        this.splat(i--, p, how === 'splat' ? f.id : null);
        spent = true;
        break;
      }
      if (spent) continue;
      let hit = solidAt(plats, p.x, p.y - PIE.r, PIE.r * 2, PIE.r * 2) !== null;
      for (const q of plats) if (!hit && Math.abs(p.x - q.x) <= q.w / 2 && y0 - PIE.r >= q.y - EPS && p.y - PIE.r < q.y) hit = true;
      if (hit || p.x < b.left || p.x > b.right || p.y < b.bottom || p.y > b.top) this.splat(i--, p, null);
    }
  }

  /** Pie `i` is gone: splatted on creature `target`, or (null) stopped by a shield, on a platform or past the bounds. */
  private splat(i: number, p: Pie, target: string | null): void {
    this.pies.splice(i, 1);
    const cue: ItemCue = { phase: 'end', item: 'custardPie', id: p.from, at: { x: p.x, y: p.y } };
    if (target) cue.target = target;
    this.pending.push(cue);
  }
}

/** Whether `f` can open a present: in play and free to grab it (not held, out or frozen). */
function canOpen(f: StageFighter): boolean {
  const a = f.action;
  return a !== 'held' && a !== 'out' && a !== 'frozen';
}

/** Whether `f`'s box overlaps a box w × h standing on (x, y). */
function touchesBox(f: StageFighter, x: number, y: number, w: number, h: number): boolean {
  const m = f.mover;
  return Math.abs(m.pos.x - x) < (m.w + w) / 2 && m.pos.y < y + h && m.pos.y + m.h > y;
}

/** Whether a circle touches `f`'s box. */
function touchesCircle(f: StageFighter, x: number, y: number, r: number): boolean {
  const m = f.mover, hw = m.w / 2;
  const nx = Math.max(m.pos.x - hw, Math.min(x, m.pos.x + hw)), ny = Math.max(m.pos.y, Math.min(y, m.pos.y + m.h));
  return (nx - x) ** 2 + (ny - y) ** 2 <= r * r;
}
