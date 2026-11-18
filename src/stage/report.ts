import blob from '../fixtures/fighters/blob.json';
import fists from '../fixtures/fighters/fists.json';
import horns from '../fixtures/fighters/horns.json';
import legs from '../fixtures/fighters/legs.json';
import tail from '../fixtures/fighters/tail.json';
import tiny from '../fixtures/fighters/tiny.json';
import wings from '../fixtures/fighters/wings.json';
import { LEVELS as THEMED } from '../levels';
import { TEST_LEVEL } from '../levels/test';
import type { Recipe } from '../recipe/schema';
import { mulberry32, type Rng } from '../util/rng';
import { bodyStats } from './body';
import { newBrainMemory, think, type BrainMemory } from './brain';
import type { StageFighter } from './fighter';
import type { Level, LevelId } from './level';
import { StageSim, type StageEvents } from './sim';
import { DT, type Intent, type V2 } from './types';

/** A headless bout's cap (s): four minutes. */
export const BOUT_SECONDS = 240;
/** A fighter moving toward its nearest foe at least this fast (m/s) counts as something happening. */
const APPROACH_SPEED = 1;
/** A fighter on the ground moving slower than this (m/s), idle, landing or attacking where it stands, is standing still. */
export const STILL_SPEED = 0.5;
/** Standing still for longer than this (s) at a stretch counts against a bout (spec §5.4: "nobody stands still for long"). */
export const STILL_LONG = 3;

/**
 * How a headless bout went. Fighter ids are `f0`, `f1`… in the order of the recipes.
 * - `winner`: the one left standing, or null (time ran out with several left, or the last ones went out together).
 * - `seconds`: how long the bout ran (s of fight time).
 * - `firstOut`: when the first fighter went out (s), or null if nobody did.
 * - `quiet`: the longest stretch (s) in which no hit landed and nobody was moving toward anyone (no fighter's speed
 *   toward its nearest foe reached APPROACH_SPEED) — the "dead air" the pace targets keep rare.
 * - `outs`: who went out, in order.
 * - `still`: fighter-seconds spent standing still (`standingStill`) in stretches longer than STILL_LONG, and
 *   `fighterTime`: fighter-seconds in play (the two make the share of time spent standing about).
 */
export type BoutResult = {
  winner: string | null; seconds: number; firstOut: number | null; quiet: number; outs: string[]; still: number; fighterTime: number;
};

/** Whether `f` is standing still: on the ground, slower than STILL_SPEED, idle, landing or attacking where it stands. */
export function standingStill(f: Pick<StageFighter, 'action' | 'mover'>): boolean {
  const a = f.action, v = f.mover.vel;
  return (a === 'idle' || a === 'land' || a === 'attack') && f.mover.ground !== null && Math.hypot(v.x, v.y) < STILL_SPEED;
}

/**
 * Times how long fighters stand still (`standingStill`): `total` is the fighter-seconds spent in stretches longer than
 * STILL_LONG (the whole stretch counts once it is that long). Feed it every step; `end` closes the open stretches.
 */
export class StillClock {
  total = 0;
  /** Since when (s) each fighter has stood still, while it does. */
  private readonly since = new Map<string, number>();
  private readonly seen = new Set<string>();

  /** The fighters in play `fs` at fight time `t` (one who is gone ends its stretch). */
  step(fs: readonly Pick<StageFighter, 'id' | 'action' | 'mover'>[], t: number): void {
    this.seen.clear();
    for (const f of fs) {
      this.seen.add(f.id);
      if (standingStill(f)) {
        if (!this.since.has(f.id)) this.since.set(f.id, t);
      } else this.close(f.id, t);
    }
    for (const id of this.since.keys()) if (!this.seen.has(id)) this.close(id, t);
  }

  /** The bout is over at `t`: every stretch still open ends. */
  end(t: number): void {
    for (const id of [...this.since.keys()]) this.close(id, t);
  }

  private close(id: string, t: number): void {
    const from = this.since.get(id);
    if (from === undefined) return;
    this.since.delete(id);
    if (t - from > STILL_LONG) this.total += t - from;
  }
}

/**
 * One headless bout: the recipes' creatures on `level` (the test level by default), each with the simple brain, until
 * one or none is left or `seconds` (default BOUT_SECONDS) run out. They start on the level's entries, spread evenly
 * and dealt out in an order from the seed. Presents drop as on the TV (`items: false` for a bout without). Everything
 * random comes from the seed, so a bout replays exactly. `watch`, if given, sees the sim after every step and that
 * step's events (for tuning probes; it must not change anything).
 */
export function simulateBout(recipes: Recipe[], o: { seed: number; level?: Level; seconds?: number; items?: boolean;
  watch?: (sim: StageSim, ev: StageEvents) => void; }): BoutResult {
  const level = o.level ?? TEST_LEVEL;
  const rng = mulberry32(o.seed);
  const sim = new StageSim({ level, rng, items: o.items ?? true });
  const spots = startSpots(level, recipes.length, rng);
  recipes.forEach((r, i) => sim.add(`f${i}`, bodyStats(r), spots[i]));

  const memory = new Map<string, BrainMemory>(sim.fighters().map((f) => [f.id, newBrainMemory()]));
  const intents = new Map<string, Intent>();
  const others: StageFighter[] = [];
  const outs: string[] = [];
  const steps = Math.round((o.seconds ?? BOUT_SECONDS) / DT);
  const still = new StillClock();
  let firstOut: number | null = null, lastAction = 0, quiet = 0, fighterTime = 0;
  for (let s = 0; s < steps && sim.fighters().length >= 2; s++) {
    const fs = sim.fighters();
    intents.clear();
    for (const f of fs) {
      others.length = 0;
      for (const g of fs) if (g !== f) others.push(g);
      intents.set(f.id, think({ self: f, others, level: sim.level, t: sim.t, mischief: sim.mischief, items: sim.items }, rng, memory.get(f.id)!));
    }
    const ev = sim.step(intents);
    o.watch?.(sim, ev);
    if (ev.outs.length > 0) {
      firstOut ??= sim.t;
      outs.push(...ev.outs);
    }
    if (ev.hits.length > 0 || ev.bumps.length > 0 || anyoneApproaching(sim.fighters())) lastAction = sim.t;
    quiet = Math.max(quiet, sim.t - lastAction);
    still.step(sim.fighters(), sim.t);
    fighterTime += sim.fighters().length * DT;
  }
  still.end(sim.t);
  const left = sim.fighters();
  return { winner: left.length === 1 ? left[0].id : null, seconds: sim.t, firstOut, quiet, outs, still: still.total, fighterTime };
}

/** `n` of the level's entries spread evenly across them, in an order dealt from `rng`. */
function startSpots(level: Level, n: number, rng: Rng): (V2 | undefined)[] {
  const e = level.entries;
  const spots = Array.from({ length: n }, (_, i) => (e.length ? e[Math.floor(((i + 0.5) * e.length) / n) % e.length] : undefined));
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }
  return spots;
}

/** Whether any fighter is moving toward its nearest foe at APPROACH_SPEED or faster. */
function anyoneApproaching(fs: readonly StageFighter[]): boolean {
  for (const f of fs) {
    const p = f.mover.pos;
    let best: StageFighter | null = null, bestD = Infinity;
    for (const g of fs) {
      if (g === f) continue;
      const d = Math.hypot(g.mover.pos.x - p.x, g.mover.pos.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    if (!best || bestD === 0) continue;
    const v = f.mover.vel;
    if ((v.x * (best.mover.pos.x - p.x) + v.y * (best.mover.pos.y - p.y)) / bestD >= APPROACH_SPEED) return true;
  }
  return false;
}

/** The seven body kinds with a fighter fixture (one per row of the spec's moves table): the balance samples' cast. */
export const BODY_KINDS = ['fists', 'legs', 'tiny', 'blob', 'wings', 'tail', 'horns'] as const;
export type BodyKind = (typeof BODY_KINDS)[number];
const FIXTURES: Record<BodyKind, unknown> = { fists, legs, tiny, blob, wings, tail, horns };

/** A fresh copy of a body kind's fixture recipe (JSON imports widen enums to strings, hence the cast). */
export const fixtureRecipe = (k: BodyKind): Recipe => structuredClone(FIXTURES[k]) as Recipe;

/** The levels a balance sample can run on, by id. */
const LEVELS: Record<LevelId, Level> = { test: TEST_LEVEL, ...THEMED };

/** The level with this id (only levels the balance tool knows). */
export function levelById(id: LevelId): Level {
  const l = LEVELS[id];
  if (!l) throw new Error(`no level "${id}" for headless bouts`);
  return l;
}

/**
 * One bout of a four-way sample: who fights (by kind; ids f0… in this order), its seed and level (by id, so a job can
 * cross to a helper process), its cap (s; default BOUT_SECONDS), and `items: false` for a bout without presents.
 */
export type BoutJob = { kinds: BodyKind[]; seed: number; level: LevelId; seconds?: number; items?: boolean };

/** Runs one sample bout. */
export function runJob(j: BoutJob): BoutResult {
  return simulateBout(j.kinds.map(fixtureRecipe), { seed: j.seed, level: levelById(j.level), seconds: j.seconds, items: j.items });
}

/** A quiet stretch longer than this (s) counts against a bout (spec §5.4: "over 3 s are rare"). */
export const QUIET_LONG = 3;

/**
 * A four-way sample's report: how many bouts; the median time (s) of the first knockout (a bout with none counts its
 * whole length) and of a bout's end; the share of bouts with a quiet stretch over QUIET_LONG; the share of all
 * fighter-time spent standing still in stretches over STILL_LONG (`still`); and per body kind how many
 * bouts it fought, won, and its win rate (a bout that ran out of time with 2+ left, or whose last ones went out
 * together, has no winner).
 */
export type StageReport = {
  bouts: number;
  firstOut: number;
  length: number;
  quiet: number;
  still: number;
  kinds: Record<BodyKind, { bouts: number; wins: number; winRate: number }>;
};

/**
 * Options for a four-way sample: its seed (default 1), level (default the test level), cap per bout (s), and `items:
 * false` for bouts without presents.
 */
export type FourWayOptions = { seed?: number; level?: LevelId; seconds?: number; items?: boolean };

/**
 * The `n` bouts of a four-way sample: four different kinds drawn at random for each (seeded by `seed`), each bout with
 * its own seed. Every bout is independent, so they may run in any order or side by side.
 */
export function fourWayBouts(n: number, o: FourWayOptions = {}): BoutJob[] {
  const seed = o.seed ?? 1, pick = mulberry32(seed), level = o.level ?? 'test';
  return Array.from({ length: n }, (_, i) => {
    const j: BoutJob = { kinds: drawFour(pick), seed: 1000 + i * 7919 + seed, level };
    if (o.seconds !== undefined) j.seconds = o.seconds;
    if (o.items === false) j.items = false;
    return j;
  });
}

/** Four different kinds drawn at random. */
function drawFour(rng: Rng): BodyKind[] {
  const pool: BodyKind[] = [...BODY_KINDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 4);
}

/** The report on finished bouts (`casts[i]` fought bout `i`, ids f0… in that order). */
export function summarize(results: readonly BoutResult[], casts: readonly (readonly BodyKind[])[]): StageReport {
  const kinds = {} as StageReport['kinds'];
  for (const k of BODY_KINDS) kinds[k] = { bouts: 0, wins: 0, winRate: 0 };
  results.forEach((r, i) => {
    for (const k of casts[i]) kinds[k].bouts++;
    if (r.winner) kinds[casts[i][Number(r.winner.slice(1))]].wins++;
  });
  for (const k of BODY_KINDS) kinds[k].winRate = kinds[k].bouts ? kinds[k].wins / kinds[k].bouts : 0;
  const n = results.length;
  const fighterTime = results.reduce((t, r) => t + r.fighterTime, 0);
  return {
    bouts: n,
    firstOut: median(results.map((r) => r.firstOut ?? r.seconds)),
    length: median(results.map((r) => r.seconds)),
    quiet: n ? results.filter((r) => r.quiet > QUIET_LONG).length / n : 0,
    still: fighterTime > 0 ? results.reduce((t, r) => t + r.still, 0) / fighterTime : 0,
    kinds,
  };
}

/** A four-way sample run here, one bout after another (`tools/bouts.ts` runs the same side by side). */
export function fourWayReport(n: number, o: FourWayOptions = {}): StageReport {
  const jobs = fourWayBouts(n, o);
  return summarize(jobs.map(runJob), jobs.map((j) => j.kinds));
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
