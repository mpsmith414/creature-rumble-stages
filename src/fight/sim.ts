import type RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three/webgpu';
import { addArenaColliders } from '../arena/colliders';
import { RingFeatures } from '../arena/features';
import { buildSkeleton } from '../builder/skeleton';
import blob from '../fixtures/fighters/blob.json';
import fists from '../fixtures/fighters/fists.json';
import horns from '../fixtures/fighters/horns.json';
import legs from '../fixtures/fighters/legs.json';
import tail from '../fixtures/fighters/tail.json';
import tiny from '../fixtures/fighters/tiny.json';
import wings from '../fixtures/fighters/wings.json';
import { isOut } from '../match/rules';
import { ragdollLayout } from '../physics/layout';
import { createWorld } from '../physics/world';
import type { Recipe } from '../recipe/schema';
import { mulberry32 } from '../util/rng';
import { danger, STARS_DANGER } from './danger';
import { Fighter, type FightCtx, type Reaction } from './fighter';
import type { StuntName } from './stunts';
import { planFor } from './moves';
import { TUNE, type Tune } from './tune';

/**
 * Headless bouts for balancing (no rendering): fixture fighters round the ring, each fighter thinks then the world
 * steps at 1/60 s, a fighter that `isOut` is ringed out and removed. All randomness comes from the seed.
 */

/** The seven body kinds with a fighter fixture (one per row of the spec's moves table). */
export const BODY_KINDS = ['fists', 'legs', 'tiny', 'blob', 'wings', 'tail', 'horns'] as const;
const FIXTURES: Record<string, unknown> = { fists, legs, tiny, blob, wings, tail, horns };

const DT = 1 / 60;
/** Mixed into a bout's seed for the ring features' own random stream. */
const FEATURES_SEED = 0x5eed;
/** Fighters start on a circle this far (m) from the middle, facing in (the spike's quick fill). */
const START_R = 3;

export type BoutResult = {
  /** Who left the ring, when (s), in order. */
  ringOuts: { id: string; t: number }[];
  /** The last one standing; null when the bout ran out of time with 2+ left, or the last ones fell out together. */
  winner: string | null;
  /** Longest stretch (s) without a landed hit while 2+ fight. */
  longestQuiet: number;
  /** Hits landed, by fighter id. */
  hits: Record<string, number>;
  /** When (s) one or none was left, or `seconds` if time ran out first. */
  end: number;
  /** Time ran out with 2+ still fighting. */
  timedOut: boolean;
  /**
   * Every landed hit's flight: how high (m above the ring top) the target's torso got, how long it was up (s), how it
   * took the hit and how far it was carried.
   */
  launches: Launch[];
  /** Specials started, by fighter id. */
  specials: Record<string, number>;
  /** Fighter-seconds spent fighting with at least one opponent (the specials rate's time base). */
  fightSeconds: number;
  /** Each fighter's `danger` (src/fight/danger.ts) at the moment it was rung out, by kind. */
  outDanger: { kind: string; danger: number }[];
  /** Every fighting fighter's `danger`, sampled every `DANGER_EVERY` s while 2+ fight (its share of fighting time). */
  dangerSamples: number[];
  /** How lively the fighting was (design 2026-11-14 §3). */
  lively: Lively;
  /** Throws (grab and throw, design §4), and ring-outs straight from a throw (rung out on the throw's flight). */
  throws: number;
  throwOuts: number;
  /**
   * The wild ring (§5.1): pad jumps, ring events started, beach-ball bonks and pinball-post kicks. (All 0 with
   * `features: false`.)
   */
  padJumps: number;
  events: number;
  bonks: number;
  bumps: number;
};

/**
 * How much the fighters moved (wild ring §3), per fighter-minute of fighting (2+ fighting): stunts started (`leaps`,
 * `dashes`, `dodges`, `ropeSprings`, `airChases`), `metres` its torso travelled (level), and `still`, the share of its
 * unstunned time (not stunned, not flying) its torso moved slower than `STILL_V` m/s. `unstunned` is that time (s, all
 * fighters): the weight of `still` when bouts are pooled. (Speed counts up and down too: a fighter rising in a chase is
 * not standing still.)
 */
export type Lively = {
  leaps: number; dashes: number; dodges: number; ropeSprings: number; airChases: number; metres: number; still: number; unstunned: number;
};

/** Slower than this (m/s) is standing still. */
export const STILL_V = 0.5;

/** How often (s) the fighters' danger is sampled. */
const DANGER_EVERY = 0.5;

/**
 * One landed hit's flight, watched for `WATCH_S` after it: `peak` is the highest the target's torso got (m above the
 * ring top); `air` is how long (s) until the torso came back down to the height it was hit at (0 when it never rose);
 * `launch` is the hit's launch speed (m/s, `Hit.launch`); `reaction` how the target took it (`Hit.reaction`);
 * `travel` how far (m, level) its torso was carried from where it was hit before it was steady again (its reaction
 * over), hit again, out of the ring or `WATCH_S` was up.
 */
export type Launch = { peak: number; air: number; special: boolean; launch: number; reaction: Reaction; travel: number };

/** A flight being watched: where and when it began, and which parts of it are still followed. */
type Watch = Launch & { f: Fighter; t0: number; y0: number; x0: number; z0: number; rose: boolean; flown: boolean; carried: boolean };

/** How long (s) a hit's flight is watched. */
const WATCH_S = 3;
/** A torso that rose less than this (m) over where it was hit was not launched. */
const ROSE = 0.05;

/** A fighter's id in a bout: its kind and its place, e.g. `blob-2`. */
export const kindOf = (id: string) => id.replace(/-\d+$/, '');

/**
 * Runs one bout of `kinds` (fixture names, repeats allowed) for at most `seconds`, ending early once one or none is
 * left. Call `await initPhysics()` first.
 */
export function simulateBout(kinds: string[], o: { seconds: number; seed: number; tune?: Partial<Tune>; features?: boolean }): BoutResult {
  const tune: Tune = { ...TUNE, ...o.tune };
  const rng = mulberry32(o.seed);
  const world = createWorld(tune.gravity);
  const { floor } = addArenaColliders(world, tune);
  // the wild ring's pads and events, on their own random stream (seeded by the bout's)
  const features = o.features === false ? null : new RingFeatures(world, tune, { rng: mulberry32(o.seed ^ FEATURES_SEED), floor });
  try {
    const fs = kinds.map((k, i) => {
      const a = (i / kinds.length) * Math.PI * 2;
      const f = spawn(world, k, `${k}-${i + 1}`, tune, rng);
      f.ragdoll.pose(new Vector3(Math.cos(a) * START_R, 0, Math.sin(a) * START_R), Math.atan2(-Math.cos(a), -Math.sin(a)));
      f.state = 'fighting';
      return f;
    });

    const ringOuts: BoutResult['ringOuts'] = [];
    let fighting = fs.slice();
    const ctx: FightCtx = { others: fighting, boast: false, tune, rng };
    let t = 0, lastHit = 0, longestQuiet = 0, fightSeconds = 0;
    const launches: Watch[] = [];
    const watching: Watch[] = [];
    const specials: Record<string, number> = Object.fromEntries(fs.map((f) => [f.id, 0]));
    const outDanger: BoutResult['outDanger'] = [], dangerSamples: number[] = [];
    const every = Math.round(DANGER_EVERY / DT);
    const stunts: Partial<Record<StuntName, number>> = {};
    let metres = 0, unstunned = 0, still = 0, throwOuts = 0, events = 0, bonks = 0, bumps = 0;
    const was = new Map(fs.map((f) => [f, f.ragdoll.pos()]));
    const steps = Math.round(o.seconds / DT);
    for (let s = 0; s < steps && fighting.length >= 2; s++) {
      let hit = false;
      if (features) {
        ctx.airTune = features.fightTune(tune);
        ctx.pads = features.pads;
        ctx.gravityScale = features.gravityScale;
      }
      for (const f of fighting) {
        for (const h of f.think(DT, t, ctx)) {
          hit = true;
          // a fresh hit ends how far the last one carried it
          for (const o of watching) if (o.f === h.target) o.carried = true;
          const p = h.target.ragdoll.pos();
          const w: Watch = {
            f: h.target, t0: t, y0: p.y, x0: p.x, z0: p.z, peak: p.y, air: 0, special: !!h.special, launch: h.launch,
            reaction: h.reaction, travel: 0, rose: false, flown: false, carried: false,
          };
          watching.push(w);
          launches.push(w);
        }
        for (const c of f.takeCues()) if (c.phase === 'charge') specials[f.id]++;
        for (const c of f.takeStuntCues()) if (c.phase === 'start') stunts[c.stunt] = (stunts[c.stunt] ?? 0) + 1;
      }
      if (features) {
        for (const c of features.update(DT, fighting, true)) {
          if (c.type === 'event' && c.phase === 'start') events++;
          else if (c.type === 'ball') bonks++;
          else if (c.type === 'bump') bumps++;
        }
        // (a pad jump starts in the update: its start cue is counted here)
        for (const f of fighting) for (const c of f.takeStuntCues()) if (c.phase === 'start') stunts[c.stunt] = (stunts[c.stunt] ?? 0) + 1;
      }
      world.step();
      t = (s + 1) * DT;
      fightSeconds += fighting.length * DT;
      if (hit) lastHit = t;
      longestQuiet = Math.max(longestQuiet, t - lastHit);
      watch(watching, t);
      if ((s + 1) % every === 0) for (const f of fighting) dangerSamples.push(danger(f.wobble, f.ragdoll.mass, tune));
      for (const f of fighting) {
        const p = f.ragdoll.torso.body.translation(), w = was.get(f)!;
        // (a held fighter is carried: it is not moving, nor standing still, itself)
        if (!f.held) metres += Math.hypot(p.x - w.x, p.z - w.z);
        w.set(p.x, p.y, p.z);
        if (f.stun > 0 || f.flying || f.held) continue;
        unstunned += DT;
        const v = f.ragdoll.torso.body.linvel();
        if (Math.hypot(v.x, v.y, v.z) < STILL_V) still += DT;
      }

      // (a held fighter is not ruled out until it is thrown)
      const outs = fighting.filter((f) => !f.held && isOut(f.ragdoll.pos(), tune.ringRadius));
      if (!outs.length) continue;
      for (const f of outs) {
        ringOuts.push({ id: f.id, t });
        if (f.thrown) throwOuts++;
        outDanger.push({ kind: kindOf(f.id), danger: danger(f.wobble, f.ragdoll.mass, tune) });
        f.state = 'out';
        // its flight ends where it fell out
        for (const w of watching) if (w.f === f && !w.flown) w.air = w.rose ? t - w.t0 : 0;
        for (let i = watching.length - 1; i >= 0; i--) if (watching[i].f === f) watching.splice(i, 1);
        f.dispose();
      }
      fighting = fighting.filter((f) => !outs.includes(f));
      ctx.others = fighting;
    }

    const timedOut = fighting.length >= 2;
    const perMin = (n: number) => (fightSeconds > 0 ? (60 * n) / fightSeconds : 0);
    const lively: Lively = {
      leaps: perMin(stunts.leap ?? 0), dashes: perMin(stunts.dash ?? 0), dodges: perMin(stunts.dodge ?? 0),
      ropeSprings: perMin(stunts.ropeSpring ?? 0), airChases: perMin(stunts.airChase ?? 0), metres: perMin(metres),
      still: unstunned > 0 ? still / unstunned : 0, unstunned,
    };
    return {
      ringOuts,
      winner: fighting.length === 1 ? fighting[0].id : null,
      longestQuiet,
      hits: Object.fromEntries(fs.map((f) => [f.id, f.hits])),
      end: timedOut ? o.seconds : (ringOuts.at(-1)?.t ?? 0),
      timedOut,
      launches: launches.map(({ peak, air, special, launch, reaction, travel }) => ({ peak, air, special, launch, reaction, travel })),
      specials,
      fightSeconds,
      outDanger,
      dangerSamples,
      lively,
      throws: stunts.throw ?? 0,
      throwOuts,
      padJumps: stunts.padJump ?? 0,
      events,
      bonks,
      bumps,
    };
  } finally {
    world.free();
  }
}

/**
 * Follows each watched flight one step: its peak and when it came back down, and how far it was carried until it was
 * steady again; drops it once both are known, or after `WATCH_S`.
 */
function watch(ws: Watch[], t: number): void {
  for (let i = ws.length - 1; i >= 0; i--) {
    const w = ws[i], p = w.f.ragdoll.pos(), age = t - w.t0;
    if (!w.flown) {
      w.peak = Math.max(w.peak, p.y);
      if (p.y > w.y0 + ROSE) w.rose = true;
      const down = w.rose && p.y <= w.y0;
      if (down) { w.air = age; w.flown = true; }
      else if (age >= WATCH_S) { w.air = w.rose ? age : 0; w.flown = true; }
    }
    // grabbed: the hit's own flight and carry are over (it is being lifted and carried)
    if (w.f.held) {
      if (!w.flown) { w.air = w.rose ? age : 0; w.flown = true; }
      w.carried = true;
    }
    if (!w.carried) {
      w.travel = Math.max(w.travel, Math.hypot(p.x - w.x0, p.z - w.z0));
      if (w.f.reaction === 'none' || age >= WATCH_S) w.carried = true;
    }
    if (w.flown && w.carried) ws.splice(i, 1);
  }
}

function spawn(world: RAPIER.World, kind: string, id: string, tune: Tune, rng: () => number): Fighter {
  const raw = FIXTURES[kind];
  if (!raw) throw new Error(`no fighter fixture "${kind}"`);
  const recipe = structuredClone(raw) as Recipe;
  const sk = buildSkeleton(recipe);
  const plan = planFor(recipe, sk);
  return new Fighter(id, world, ragdollLayout(sk, plan), plan, { tune, rng });
}

// ---------- reports ----------

export type FourWayReport = {
  bouts: BoutResult[];
  /** The kinds in each bout, in order. */
  cast: string[][];
  medianFirstOut: number;
  medianEnd: number;
  maxQuiet: number;
  /** Bouts whose longest quiet was over 3 s. */
  quietOver3: number;
  timedOut: number;
  /** Per kind: bouts it took part in, bouts it won, and wins ÷ bouts. */
  kinds: Record<string, { bouts: number; wins: number; winRate: number }>;
  /** Normal (not special) landed hits: the median peak torso height (m above the ring top) of their targets. */
  medianPeak: number;
  /** Share of normal landed hits whose target's torso peaked at 1.5 m or higher. */
  highShare: number;
  /** Median air time (s) of normal landed hits that launched their target (rose at all). */
  medianAir: number;
  /** Normal landed hits: the median distance (m, level) the target was carried before it was steady again. */
  medianTravel: number;
  /** The same for the normal hits that launched their target (a pop or a big hit, not a stagger). */
  medianLaunchTravel: number;
  /**
   * Share of all landed hits (specials' too: their blows are the big rag-doll flights) taken as each reaction (`none`:
   * shrugged off by a special's armour).
   */
  reactions: Record<Reaction, number>;
  /** Specials each fighter performs per 45 s of fighting, on average. */
  specialsPer45: number;
  /** Dizzy stars (`STARS_DANGER`): share of ring-outs whose fighter showed them as it went out, and by kind. */
  starsAtOut: number;
  starsAtOutByKind: Record<string, number>;
  /** Share of fighting time (fighter-seconds, 2+ fighting) with stars showing. */
  starsTime: number;
  /** The bouts' liveliness pooled (rates weighted by fighting time; `still` by unstunned time). */
  lively: Lively;
  /** Grab and throw (design §4): the median bout's throws, throws per bout, and the share of ring-outs straight from a throw. */
  medianThrows: number;
  throwsPerBout: number;
  throwOutShare: number;
  /** The wild ring (§5.1), per bout: pad jumps, ring events, beach-ball bonks and pinball-post kicks. */
  ring: { padJumps: number; events: number; bonks: number; bumps: number };
};

/** A torso peaking this high (m above the ring top) after a hit is a high launch. */
export const HIGH_LAUNCH = 1.5;

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The dizzy stars' measures over `bouts` (`FourWayReport.starsAtOut`, `starsAtOutByKind`, `starsTime`). */
export function starsOf(bouts: readonly BoutResult[], k = STARS_DANGER): Pick<FourWayReport, 'starsAtOut' | 'starsAtOutByKind' | 'starsTime'> {
  const outs = bouts.flatMap((b) => b.outDanger), samples = bouts.flatMap((b) => b.dangerSamples);
  const share = (xs: readonly { danger: number }[]) => (xs.length ? xs.filter((o) => o.danger >= k).length / xs.length : 0);
  const starsAtOutByKind: Record<string, number> = {};
  for (const kind of BODY_KINDS) starsAtOutByKind[kind] = share(outs.filter((o) => o.kind === kind));
  return {
    starsAtOut: share(outs),
    starsAtOutByKind,
    starsTime: samples.length ? samples.filter((d) => d >= k).length / samples.length : 0,
  };
}

/** How often each reaction comes up in `rs` (0 each when there are none). */
function shares(rs: Reaction[]): Record<Reaction, number> {
  const out: Record<Reaction, number> = { none: 0, stagger: 0, pop: 0, big: 0 };
  for (const r of rs) out[r]++;
  for (const k of Object.keys(out) as Reaction[]) out[k] = rs.length ? out[k] / rs.length : 0;
  return out;
}

/** Four different kinds drawn at random. */
export function drawFour(rng: () => number): string[] {
  const pool: string[] = [...BODY_KINDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 4);
}

/**
 * `n` four-way bouts of different kinds drawn at random (seeded by `seed`). A bout with no first ring-out counts its
 * first ring-out as `seconds` (as does a timed-out bout's end). `onBout` sees each bout as it finishes.
 */
export function fourWayReport(n: number, o: FourWayOptions & { onBout?: (i: number, cast: string[], r: BoutResult) => void } = {}): FourWayReport {
  const jobs = fourWayBouts(n, o), bouts: BoutResult[] = [];
  jobs.forEach((j, i) => {
    bouts.push(simulateBout(j.kinds, j));
    o.onBout?.(i, j.kinds, bouts[i]);
  });
  return summarize(bouts, jobs.map((j) => j.kinds), o.seconds ?? 240);
}

/** `features: false` runs bouts without the wild ring's pads and events (for comparisons). */
export type FourWayOptions = { seconds?: number; seed?: number; tune?: Partial<Tune>; features?: boolean };
/** One bout of a four-way sample: who fights, and `simulateBout`'s options. */
export type BoutJob = { kinds: string[]; seconds: number; seed: number; tune?: Partial<Tune>; features?: boolean };

/** The `n` bouts `fourWayReport` runs (each is independent: they may run in any order, or side by side). */
export function fourWayBouts(n: number, o: FourWayOptions = {}): BoutJob[] {
  const seconds = o.seconds ?? 240, pick = mulberry32(o.seed ?? 1);
  return Array.from({ length: n }, (_, i) => ({ kinds: drawFour(pick), seconds, seed: 1000 + i * 7919 + (o.seed ?? 1), tune: o.tune, features: o.features }));
}

/** The report on finished bouts (`cast[i]` fought bout `i`; `seconds` was each bout's cap). */
export function summarize(bouts: BoutResult[], cast: string[][], seconds: number): FourWayReport {
  const kinds: FourWayReport['kinds'] = {};
  for (const k of BODY_KINDS) kinds[k] = { bouts: 0, wins: 0, winRate: 0 };
  bouts.forEach((r, i) => {
    for (const k of cast[i]) kinds[k].bouts++;
    if (r.winner) kinds[kindOf(r.winner)].wins++;
  });
  for (const k of BODY_KINDS) kinds[k].winRate = kinds[k].bouts ? kinds[k].wins / kinds[k].bouts : 0;
  const normal = bouts.flatMap((r) => r.launches.filter((l) => !l.special));
  const flew = normal.filter((l) => l.air > 0);
  const launched = normal.filter((l) => l.reaction === 'pop' || l.reaction === 'big');
  const specials = bouts.reduce((n, r) => n + Object.values(r.specials).reduce((a, b) => a + b, 0), 0);
  const fightSeconds = bouts.reduce((n, r) => n + r.fightSeconds, 0);
  return {
    bouts, cast,
    medianFirstOut: median(bouts.map((r) => r.ringOuts[0]?.t ?? seconds)),
    medianEnd: median(bouts.map((r) => r.end)),
    maxQuiet: Math.max(...bouts.map((r) => r.longestQuiet)),
    quietOver3: bouts.filter((r) => r.longestQuiet > 3).length,
    timedOut: bouts.filter((r) => r.timedOut).length,
    kinds,
    medianPeak: normal.length ? median(normal.map((l) => l.peak)) : 0,
    highShare: normal.length ? normal.filter((l) => l.peak >= HIGH_LAUNCH).length / normal.length : 0,
    medianAir: flew.length ? median(flew.map((l) => l.air)) : 0,
    medianTravel: normal.length ? median(normal.map((l) => l.travel)) : 0,
    medianLaunchTravel: launched.length ? median(launched.map((l) => l.travel)) : 0,
    reactions: shares(bouts.flatMap((r) => r.launches.map((l) => l.reaction))),
    specialsPer45: fightSeconds > 0 ? (45 * specials) / fightSeconds : 0,
    ...starsOf(bouts),
    lively: livelyOf(bouts),
    medianThrows: bouts.length ? median(bouts.map((r) => r.throws)) : 0,
    throwsPerBout: bouts.length ? bouts.reduce((n, r) => n + r.throws, 0) / bouts.length : 0,
    throwOutShare: outsOf(bouts) ? bouts.reduce((n, r) => n + r.throwOuts, 0) / outsOf(bouts) : 0,
    ring: {
      padJumps: perBout(bouts, (r) => r.padJumps), events: perBout(bouts, (r) => r.events),
      bonks: perBout(bouts, (r) => r.bonks), bumps: perBout(bouts, (r) => r.bumps),
    },
  };
}

/** The mean of `of` over `bouts` (0 with none). */
const perBout = (bouts: readonly BoutResult[], of: (r: BoutResult) => number) => (bouts.length ? bouts.reduce((n, r) => n + of(r), 0) / bouts.length : 0);

/** All the ring-outs in `bouts`. */
const outsOf = (bouts: readonly BoutResult[]) => bouts.reduce((n, r) => n + r.ringOuts.length, 0);

/** `bouts`' liveliness pooled: each rate weighted by its bout's fighting time, `still` by its unstunned time. */
export function livelyOf(bouts: readonly BoutResult[]): Lively {
  const secs = bouts.reduce((n, b) => n + b.fightSeconds, 0), un = bouts.reduce((n, b) => n + b.lively.unstunned, 0);
  const rate = (k: Exclude<keyof Lively, 'still' | 'unstunned'>) => (secs > 0 ? bouts.reduce((n, b) => n + b.lively[k] * b.fightSeconds, 0) / secs : 0);
  return {
    leaps: rate('leaps'), dashes: rate('dashes'), dodges: rate('dodges'), ropeSprings: rate('ropeSprings'), airChases: rate('airChases'),
    metres: rate('metres'), still: un > 0 ? bouts.reduce((n, b) => n + b.lively.still * b.lively.unstunned, 0) / un : 0, unstunned: un,
  };
}
