import { SPECIAL_FOR, type SpecialName } from '../fight/special';
import { attackFor, type Attack } from './attacks';
import type { BodyStats } from './body';
import type { StageFighter, Strike } from './fighter';
import { platformsAt, type Level, type Platform } from './level';
import { DT, type V2 } from './types';

/**
 * The seven specials in 2D (spec §5.2, §12): each body's big move, let go when its meter is full. Each keeps its idea
 * and name and runs as a little script on the fight's steps: a wind-up (`charge`, the show glows and shouts), then the
 * move itself (`release`), an `impact` when it first lands a blow (or slams the floor), and always an `end` — when the
 * script is done, when a tumble-strength blow knocks it out of it, when its fighter goes out or leaves the stage. Weaker
 * blows only rock a fighter in a special (it shrugs them off). The main blow is SPECIAL_MULT × the body's forward swing:
 * about twice a normal hit. Pace and balance are Task 10's.
 * - Mega Punch: a long glowing wind-up, then a lunging haymaker.
 * - Jab Flurry: six quick jabs that pin the foe, then an uppercut that pops it up.
 * - Helicopter Kick: a hop into a rising spin, legs out, kicking all around.
 * - Belly Bomb: a big leap and a belly-flop that hits what is below, then a slam that throws up everyone standing near.
 * - Rocket Headbutt: reared back, then a head-first dash straight across.
 * - Tornado Tail: a spin that travels forward, the tail sweeping all around, ending in a big fling.
 * - Meteor Dive: a rise and a hover, then a dive down at 45° and a slam where it lands.
 */

/** A special's moment for the show: who, which special, which moment, where (the fighter's feet, or the blow). */
export type StageSpecialCue = { id: string; special: SpecialName; phase: 'charge' | 'release' | 'impact' | 'end'; at: V2 };

/** The meter fills by this per hit landed, per hit taken, and per second in play (not during its own special). */
export const METER_LAND = 0.02, METER_TAKEN = 0.01, METER_PER_S = 1 / 90;
/** A special's main blow is this × the body's forward swing (its power and damage). */
export const SPECIAL_MULT = 2;
/** Steps of getting up after a slam (Belly Bomb, Meteor Dive). */
export const SLAM_REST = 22;

/** Each special's wind-up and the longest its release may run (steps). */
export const SPECIAL_STEPS: Readonly<Record<SpecialName, { charge: number; release: number }>> = {
  megaPunch: { charge: 24, release: 30 },
  jabFlurry: { charge: 18, release: 60 },
  helicopterKick: { charge: 14, release: 48 },
  bellyBomb: { charge: 16, release: 100 },
  rocketHeadbutt: { charge: 30, release: 34 },
  tornadoTail: { charge: 18, release: 66 },
  meteorDive: { charge: 28, release: 70 },
};

// The scripts' timings (release steps) and speeds (m/s).
/** Mega Punch: the lunge's speed and steps; the fist hits on release steps [2, 10). */
const PUNCH_LUNGE = 9, PUNCH_LUNGE_STEPS = 9, PUNCH_FROM = 2, PUNCH_TO = 10;
/** Jab Flurry: six jabs, one every JAB_EVERY steps, each live JAB_LIVE steps, creeping in at JAB_CREEP; the pop on [40, 44). */
export const JABS = 6, JAB_EVERY = 6, JAB_LIVE = 3, JAB_CREEP = 3, POP_FROM = 40, POP_TO = 44;
/**
 * Jab Flurry: each jab's power (× the forward swing): a light tap that pins, so even a battered foe is still in reach of
 * the uppercut (at 0.25 the jabs pushed a foe with any damage out of its reach).
 */
const JAB_PIN = 0.1;
/** Helicopter Kick: rises at HELI_RISE for HELI_RISE_STEPS, drifting forward at HELI_DRIFT; kicks on [2, 40). */
const HELI_RISE = 5.5, HELI_RISE_STEPS = 22, HELI_DRIFT = 2.5, HELI_FROM = 2;
/**
 * Helicopter Kick: the spinning legs reach this share of the body's weapon reach past its side. (A long-legged body's
 * full reach all round, 1.65 m for 38 steps, out-hit every other special.)
 */
const HELI_REACH = 0.25;
export const HELI_TO = 40;
/** Belly Bomb: the leap's speeds. */
const BELLY_UP = 12, BELLY_FWD = 5;
/** Rocket Headbutt: the dash's speed and steps; what is kept of the speed when it ends. */
const ROCKET_SPEED = 15, ROCKET_KEEP = 0.2;
export const ROCKET_STEPS = 16;
/** Tornado Tail: travels at this speed for this many steps; three sweeps of SWEEP_LIVE steps every SWEEP_EVERY, the fling on [48, 56). */
const TORNADO_SPEED = 5;
export const TORNADO_STEPS = 56;
const SWEEPS = 3, SWEEP_EVERY = 16, SWEEP_LIVE = 8, FLING_FROM = 48, FLING_TO = 56;
/** Meteor Dive: rises at METEOR_RISE (drifting at METEOR_DRIFT) for METEOR_RISE_STEPS, hovers to the release, dives at DIVE each way. */
const METEOR_RISE = 8, METEOR_DRIFT = 2, DIVE = 11;
export const METEOR_RISE_STEPS = 18;
/** A special travelling along the ground stops this far (m, its centre) short of its platform's edge: never off the level. */
const EDGE_KEEP = 0.3;

/** One blow of a special, sized for a body: power, damage, angle (°), hit circle (as an attack's), all around, standing foes only. */
export type SpecialBlow = {
  power: number; damage: number; angle: number; dx: number; dy: number; r: number; around: boolean; ground: boolean;
};

/**
 * A body's special worked out once: its name and steps, its main blow, its small blows (jabs, sweeps) and its slam, if
 * it has them, and its main blow as an `Attack` (the timing and hit area the poses aim at, and what a brain reads).
 */
export type SpecialKit = {
  name: SpecialName; charge: number; release: number;
  main: SpecialBlow; small: SpecialBlow | null; slam: SpecialBlow | null; attack: Attack;
};

/** This body's special. */
export function specialKit(stats: BodyStats): SpecialKit {
  const name = SPECIAL_FOR[stats.move], steps = SPECIAL_STEPS[name];
  const fwd = attackFor(stats.move, 'forward', stats);
  const R = stats.reach, h = stats.h, w = stats.w, S = Math.max(h, R);
  const blow = (power: number, damage: number, angle: number, dx: number, dy: number, r: number, around = false, ground = false): SpecialBlow =>
    ({ power: power * fwd.power, damage: damage * fwd.damage, angle, dx, dy, r, around, ground });
  const M = SPECIAL_MULT;
  let main: SpecialBlow, small: SpecialBlow | null = null, slam: SpecialBlow | null = null;
  let from: number, live: number;
  switch (name) {
    case 'megaPunch':
      main = blow(M, M, 35, 0.9 * R + 0.1, 0.55 * h, Math.max(0.35, 0.45 * S));
      [from, live] = [PUNCH_FROM, PUNCH_TO - PUNCH_FROM];
      break;
    case 'jabFlurry':
      small = blow(JAB_PIN, 0.15, 15, 0.7 * R + 0.1, 0.55 * h, Math.max(0.3, 0.35 * S));
      main = blow(M, 1.1, 65, 0.5 * R + 0.1, 0.75 * h, Math.max(0.32, 0.4 * S));
      [from, live] = [POP_FROM, POP_TO - POP_FROM];
      break;
    case 'helicopterKick':
      main = blow(M, M, 55, 0, 0.5 * h, HELI_REACH * R + w / 2 + 0.2, true);
      [from, live] = [HELI_FROM, HELI_TO - HELI_FROM];
      break;
    case 'bellyBomb':
      main = blow(M, M, 70, 0, 0.2 * h, Math.max(0.4, 0.5 * S), true);
      slam = blow(1.4, 1, 75, 0, 0, 1.6 + w / 2, true, true);
      [from, live] = [20, 20];
      break;
    case 'rocketHeadbutt':
      main = blow(M, M, 30, 0.6 * R, 0.75 * h, Math.max(0.3, 0.35 * S));
      [from, live] = [0, ROCKET_STEPS];
      break;
    case 'tornadoTail':
      small = blow(0.3, 0.2, 40, 0, 0.45 * h, Math.max(0.45, 0.6 * S), true);
      main = blow(M, 1.4, 50, 0, 0.45 * h, Math.max(0.45, 0.6 * S), true);
      [from, live] = [FLING_FROM, FLING_TO - FLING_FROM];
      break;
    case 'meteorDive':
      main = blow(M, M, 45, 0.3 * R, 0.35 * h, Math.max(0.35, 0.45 * S));
      slam = blow(1.2, 0.8, 70, 0, 0, 1.2 + w / 2, true, true);
      [from, live] = [0, 20];
      break;
  }
  const attack: Attack = {
    windup: steps.charge + from, active: live, cool: Math.max(1, steps.release - from - live),
    power: main.power, damage: main.damage, angle: main.angle,
    area: { dx: main.dx, dy: main.dy, r: main.r }, around: main.around,
  };
  return { name, charge: steps.charge, release: steps.release, main, small, slam, attack };
}

/** A special under way: when it slammed the floor (its step, −1 not yet), the blow group under way, whether it has hit. */
export class SpecialRun {
  slamAt = -1;
  group = -1;
  impacted = false;

  reset(): void {
    this.slamAt = -1;
    this.group = -1;
    this.impacted = false;
  }
}

/** Platforms now (reused). */
const plats: Platform[] = [];

/**
 * Moves a fighter in a special one step, before its box moves: sets its speeds as the script says. Returns whether the
 * box coasts (no steering, no friction: the script's speed is kept), else it moves as normal with the stick centred (a
 * planted wind-up). In the air a special always coasts, so a leap or a launch keeps its arc.
 */
export function specialMove(f: StageFighter, kit: SpecialKit, run: SpecialRun, level: Level, t: number): boolean {
  const m = f.mover, v = m.vel, side = f.facing, T = f.actionT, k = T - kit.charge, g = level.gravity;
  const grounded = m.ground !== null;
  /** A speed held level in the air for this step (gravity's pull cancels over the step). */
  const level0 = (g * DT) / 2;
  let drive = false;
  switch (kit.name) {
    case 'megaPunch':
      if (k >= 0 && k < PUNCH_LUNGE_STEPS) {
        v.x = side * PUNCH_LUNGE;
        drive = true;
      }
      break;
    case 'jabFlurry':
      if (k >= 0 && k < JABS * JAB_EVERY && grounded) {
        v.x = side * JAB_CREEP;
        drive = true;
      }
      break;
    case 'helicopterKick':
      if (k >= 0 && k < HELI_TO) {
        if (k < HELI_RISE_STEPS) v.y = HELI_RISE;
        v.x = side * HELI_DRIFT;
        drive = true;
      }
      break;
    case 'bellyBomb':
      if (k === 0) {
        v.y = BELLY_UP;
        v.x = side * BELLY_FWD;
        drive = true;
      }
      break;
    case 'rocketHeadbutt':
      if (k >= 0 && k < ROCKET_STEPS) {
        v.x = side * ROCKET_SPEED;
        if (!grounded) v.y = level0;
        drive = true;
      } else if (k === ROCKET_STEPS) v.x *= ROCKET_KEEP;
      break;
    case 'tornadoTail':
      if (k >= 0 && k < TORNADO_STEPS) {
        v.x = side * TORNADO_SPEED;
        drive = true;
      }
      break;
    case 'meteorDive':
      if (k < 0) {
        if (T < METEOR_RISE_STEPS) {
          v.y = METEOR_RISE;
          v.x = side * METEOR_DRIFT;
        } else {
          v.y = level0;
          v.x = 0;
        }
        drive = true;
      } else if (run.slamAt < 0) {
        v.x = side * DIVE;
        v.y = -DIVE + level0;
        drive = true;
      }
      break;
  }
  if (drive && grounded && v.x !== 0) brakeAtEdge(f, level, t);
  return drive || !grounded;
}

/** Along the ground a special never carries its fighter's centre past EDGE_KEEP from its platform's edge. */
function brakeAtEdge(f: StageFighter, level: Level, t: number): void {
  const m = f.mover;
  platformsAt(level, t, plats);
  let g: Platform | null = null;
  for (const p of plats) if (p.id === m.ground) g = p;
  if (!g) return;
  const dir = Math.sign(m.vel.x), edge = g.x + dir * (g.w / 2 - EDGE_KEEP);
  const room = Math.max(0, dir * (edge - m.pos.x));
  if (Math.abs(m.vel.x) * DT > room) m.vel.x = (dir * room) / DT;
}

/**
 * After the box moved: a special that comes down (Belly Bomb's flop, Meteor Dive's dive) slams on touching the floor:
 * it stops dead, the slam's blow is live this step, and it gets up after SLAM_REST steps. Returns whether it slammed
 * (the fighter sends `impact`). Also moves the blow groups on: each new jab or sweep may hit everyone again.
 */
export function specialAfterMove(f: StageFighter, kit: SpecialKit, run: SpecialRun): boolean {
  const T = f.actionT, k = T - kit.charge;
  const g = group(kit, k);
  if (g !== run.group) {
    run.group = g;
    f.attackHits.clear();
  }
  if (!kit.slam || run.slamAt >= 0 || k < 1 || f.mover.ground === null) return false;
  run.slamAt = T;
  f.mover.vel.x = 0;
  f.actionLen = T + SLAM_REST;
  return true;
}

/** Which blow group a release step is in (−1 in the wind-up): a new group may hit everyone again. */
function group(kit: SpecialKit, k: number): number {
  if (k < 0) return -1;
  if (kit.name === 'jabFlurry') return k < JABS * JAB_EVERY ? Math.floor(k / JAB_EVERY) : JABS;
  if (kit.name === 'tornadoTail') return k < SWEEPS * SWEEP_EVERY ? Math.floor(k / SWEEP_EVERY) : SWEEPS;
  return 0;
}

/** The blow live this step, or null. */
function liveBlow(f: StageFighter, kit: SpecialKit, run: SpecialRun): SpecialBlow | null {
  const T = f.actionT, k = T - kit.charge;
  if (k < 0) return null;
  switch (kit.name) {
    case 'megaPunch':
      return k >= PUNCH_FROM && k < PUNCH_TO ? kit.main : null;
    case 'jabFlurry':
      if (k < JABS * JAB_EVERY) return k % JAB_EVERY < JAB_LIVE ? kit.small : null;
      return k >= POP_FROM && k < POP_TO ? kit.main : null;
    case 'helicopterKick':
      return k >= HELI_FROM && k < HELI_TO ? kit.main : null;
    case 'bellyBomb':
      if (run.slamAt >= 0) return T === run.slamAt ? kit.slam : null;
      return k > 0 && f.mover.vel.y < 0 ? kit.main : null;
    case 'rocketHeadbutt':
      return k < ROCKET_STEPS ? kit.main : null;
    case 'tornadoTail':
      if (k < SWEEPS * SWEEP_EVERY) return k % SWEEP_EVERY < SWEEP_LIVE ? kit.small : null;
      return k >= FLING_FROM && k < FLING_TO ? kit.main : null;
    case 'meteorDive':
      if (run.slamAt >= 0) return T === run.slamAt ? kit.slam : null;
      return kit.main;
  }
}

/** The special's hit circle and blow this step (into `out`), or null. */
export function specialStrike(f: StageFighter, kit: SpecialKit, run: SpecialRun, out: Strike): Strike | null {
  const b = liveBlow(f, kit, run);
  if (!b) return null;
  const p = f.mover.pos;
  out.x = p.x + f.facing * b.dx;
  out.y = p.y + b.dy;
  out.r = b.r;
  out.power = b.power;
  out.damage = b.damage;
  out.angle = b.angle;
  out.around = b.around;
  out.ground = b.ground;
  out.special = kit.name;
  return out;
}

/**
 * Where a foe should be for a brain to let its special go, in metres from its box's bottom centre: ahead along the
 * facing from `near` to `far` (a negative `near` counts behind too), feet at most `up` above or `down` below its own;
 * `travel`: about how far the special carries it forward, where there must be floor.
 */
export type SpecialAim = { near: number; far: number; up: number; down: number; travel: number };

/** This kit's aim on a level with this gravity (into `out`; worked out from the scripts' speeds and the blows' circles). */
export function specialAim(kit: SpecialKit, stats: BodyStats, gravity: number, out: SpecialAim): SpecialAim {
  const b = kit.main, h = stats.h, reach = b.dx + b.r;
  const go = (speed: number, steps: number) => speed * steps * DT;
  let near = 0, far = 0, up = 0.5 * h, down = 0.5, travel = 0;
  switch (kit.name) {
    case 'megaPunch':
      [far, travel] = [reach + go(PUNCH_LUNGE, PUNCH_TO), go(PUNCH_LUNGE, PUNCH_LUNGE_STEPS)];
      break;
    case 'jabFlurry': {
      const s = kit.small!;
      [far, up, down, travel] = [s.dx + s.r + go(JAB_CREEP, JAB_EVERY * 2), 0.4 * h, 0.3, go(JAB_CREEP, JABS * JAB_EVERY)];
      break;
    }
    case 'helicopterKick': {
      // it drifts the whole time it is up: the rise, then the fall back from its top (longer than the kicks)
      const rise = HELI_RISE_STEPS * DT, top = HELI_RISE * rise;
      const air = Math.max(HELI_TO * DT, rise + (HELI_RISE + Math.sqrt(HELI_RISE * HELI_RISE + 2 * gravity * top)) / gravity);
      [near, far, up, travel] = [-b.r, b.r + go(HELI_DRIFT, HELI_TO) / 2, 2, HELI_DRIFT * air];
      break;
    }
    case 'bellyBomb': {
      // the leap comes back down to its own height after 2 × its rise time
      const air = (2 * BELLY_UP) / gravity;
      [near, far, up, down, travel] = [2, BELLY_FWD * air + 0.8, 0.6, 0.6, BELLY_FWD * air];
      break;
    }
    case 'rocketHeadbutt':
      [near, far, up, down, travel] = [0.3, go(ROCKET_SPEED, ROCKET_STEPS), 0.4 * h, 0.3, go(ROCKET_SPEED, ROCKET_STEPS)];
      break;
    case 'tornadoTail':
      [far, travel] = [go(TORNADO_SPEED, TORNADO_STEPS) * 0.7, go(TORNADO_SPEED, TORNADO_STEPS)];
      break;
    case 'meteorDive': {
      // a 45° dive from the top of the rise lands as far again ahead as it rose
      const rise = go(METEOR_RISE, METEOR_RISE_STEPS), drift = go(METEOR_DRIFT, METEOR_RISE_STEPS);
      [near, far, up, down, travel] = [drift + rise * 0.6, drift + rise + 1.2, 0.5, 0.5, drift + rise];
      break;
    }
  }
  out.near = near;
  out.far = far;
  out.up = up;
  out.down = down;
  out.travel = travel;
  return out;
}
