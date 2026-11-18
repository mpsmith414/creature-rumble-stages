import { MAX_SEGMENTS } from './layout';
import type { AnimState, BodyInfo } from './pose';

/*
 * The building blocks of every clip: the `Frame` a clip fills, the layers that add turns to it (body, head, legs, arms,
 * wings, tail) and the two base poses most clips stand on (the stance and the air pose).
 */

/**
 * The clips: for a body and a moment, how far each segment turns about its joint, plus whole-body moves (a lift, a
 * twirl about the vertical, a spin in the stage's plane, a squash, a slide toward the camera) and, in a strike, which
 * weapon to aim. Layers add up: a stance under everything, an action over it. Angles are radians in the segment's
 * parent's frame (creature space: x to the side, y up, z forward): `pitch` about x (a hanging limb swings back, the
 * upright body leans forward), `yaw` about y, `roll` about z (a limb on the +x side lifts outward). Everything is a
 * function of the state alone, so a bout replays the same and a frozen fighter holds still.
 */
export type Frame = {
  pitch: Float64Array;
  yaw: Float64Array;
  roll: Float64Array;
  /** The root's offset (m, creature space): a lunge forward is +z. */
  liftX: number;
  liftY: number;
  liftZ: number;
  /** A turn of the whole body about the vertical (rad, added to its facing turn). */
  twirl: number;
  /** A turn of the whole body in the stage's plane, about the box's middle (rad). */
  spin: number;
  /** Squash (+) or stretch (−) of the whole body: its height × (1 − squash), its width × (1 + squash / 2). */
  squash: number;
  /** A sidestep toward the camera (m, world z; looks only). */
  slide: number;
  /** Keep the lowest point on the box bottom (standing on something). */
  ground: boolean;
  /** Hips hang straight down whatever the body does (legs stay under a leaning body). */
  plant: boolean;
  /** Feet stay level with the floor (an ankle undoes its leg's swing). */
  flat: boolean;
  /** The weapon segment to aim at the attack's hit area (−1: none), how much (0–1), the sweep through it (rad), and whether the body may lunge. */
  aim: number;
  aimW: number;
  sweep: number;
  lunge: boolean;
  /** Aim here instead of the attack's hit area when `aimR` > 0: ahead along the facing, up from the box bottom, its radius (m). */
  aimDx: number;
  aimDy: number;
  aimR: number;
};

export function newFrame(): Frame {
  return {
    pitch: new Float64Array(MAX_SEGMENTS), yaw: new Float64Array(MAX_SEGMENTS), roll: new Float64Array(MAX_SEGMENTS),
    liftX: 0, liftY: 0, liftZ: 0, twirl: 0, spin: 0, squash: 0, slide: 0, ground: false, plant: false, flat: false,
    aim: -1, aimW: 0, sweep: 0, lunge: false, aimDx: 0, aimDy: 0, aimR: 0,
  };
}

export const TAU = Math.PI * 2;
/** How far the creature is turned from side-on toward the camera (rad): 25°, so its face and near side show. */
export const CAMERA_TURN = (25 * Math.PI) / 180;
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (p: number) => p * p * (3 - 2 * p);
export const easeOut = (p: number) => 1 - (1 - p) * (1 - p);
/** How much of a span of `len` steps is done `t` steps in (0…1); an empty span is done at once (never 0 / 0). */
export const frac = (t: number, len: number) => (len > 0 ? clamp01(t / len) : t >= 0 ? 1 : 0);

// ---- the stance (idle) ----
/** Breaths a second, and the knee bob and body sway that go with them. */
const BREATH_HZ = 0.9, SWAY_HZ = 0.45;
/** A ready stance: knees a little bent, leaning in; the bob deepens the bend (rad). */
const STAND_CROUCH = 0.1, STAND_BOB = 0.07, STAND_LEAN = 0.05, STAND_SWAY = 0.03;
/** How far the head turns to the camera (rad). */
export const HEAD_TO_CAMERA = 0.25;
/** A tail's slow swish (Hz) and how far each piece down it lags behind (rad). */
const TAIL_HZ = 0.7, TAIL_LAG = 0.7;
/** A body without legs crouches by squashing: this much squash per radian of knee bend it would have made. */
const LEGLESS_SQUASH = 0.25;

// ---- in the air ----
/** Rising or falling at this speed (m/s) is a full tuck or a full reach for the ground. */
const AIR_SPEED = 10;
/** Wing beats a second in the air. */
const FLAP_HZ = 3.2;
/** The running speed (m/s) counted as full: leaning into a flight, striding. */
export const RUN_FULL = 6;

/** Standing on something: feet on the floor, legs under the body, soles level. */
export function grounded(f: Frame, on: boolean): void {
  f.ground = f.plant = f.flat = on;
}

// ---- layers: each adds its turns to what is there ----

export function body(f: Frame, lean: number, twist: number, tilt: number): void {
  f.pitch[0] += lean;
  f.yaw[0] += twist;
  f.roll[0] += tilt;
}

/** Nods (+ forward), turns (+ toward the body's +x side) and tilts the head; a head piece on a head piece takes half. */
export function head(f: Frame, info: BodyInfo, nod: number, turn: number, tilt: number): void {
  for (let s = 1; s < info.n; s++) {
    if (info.joint[s] !== 'head') continue;
    const k = info.joint[info.parent[s]] === 'head' ? 0.5 : 1;
    f.pitch[s] += nod * k;
    f.yaw[s] += turn * k;
    f.roll[s] += tilt * k;
  }
}

/** Whether a limb on side `sd` belongs to `which` (0: both sides; a limb in the middle belongs to either). */
export const onSide = (sd: number, which: number) => which === 0 || sd === 0 || sd === which;

/** Swings the legs on side `which` forward from the hip, bends their knees back and spreads them outward (rad). */
export function legs(f: Frame, info: BodyInfo, which: number, fwd: number, bend: number, spread: number): void {
  for (let s = 1; s < info.n; s++) {
    const sd = info.side[s];
    if (!onSide(sd, which)) continue;
    if (info.joint[s] === 'hip') {
      f.pitch[s] -= fwd;
      f.roll[s] += sd * spread;
    } else if (info.joint[s] === 'knee') f.pitch[s] += bend;
  }
}

/** Bends the knees (a body without legs squashes instead). */
export function crouch(f: Frame, info: BodyInfo, k: number): void {
  if (info.legs) legs(f, info, 0, k, 2 * k, 0);
  else f.squash += k * LEGLESS_SQUASH;
}

/** Swings the arms on side `which` forward from the shoulder, spreads them outward and bends the elbows forward (rad). */
export function arms(f: Frame, info: BodyInfo, which: number, fwd: number, spread: number, bend: number): void {
  for (let s = 1; s < info.n; s++) {
    const sd = info.side[s];
    if (!onSide(sd, which)) continue;
    if (info.joint[s] === 'shoulder') {
      f.pitch[s] -= fwd;
      f.roll[s] += sd * spread;
    } else if (info.joint[s] === 'elbow') f.pitch[s] -= bend;
  }
}

/** Raises the wings (rad; the tips follow a little) and sweeps them back. */
export function wings(f: Frame, info: BodyInfo, raise: number, fold: number): void {
  for (let s = 1; s < info.n; s++) {
    const sd = info.side[s];
    if (info.joint[s] === 'wing') {
      f.roll[s] += sd * raise;
      f.yaw[s] += sd * fold;
    } else if (info.joint[s] === 'wingTip') f.roll[s] += sd * raise * 0.6;
  }
}

/** Raises the tail (the first piece most, the rest curling on) and wags it side to side, each piece lagging the last. */
export function tail(f: Frame, info: BodyInfo, raise: number, wag: number, phase: number): void {
  for (let s = 1; s < info.n; s++) {
    if (info.joint[s] !== 'tail') continue;
    const c = info.chain[s];
    f.pitch[s] += raise * (c === 0 ? 1 : 0.35);
    if (wag !== 0) f.yaw[s] += wag * (c === 0 ? 1 : 0.7) * Math.sin(phase - c * TAIL_LAG);
  }
}

/** Each ankle undoes the swing of the leg above it, so a standing sole stays level. */
export function flatFeet(f: Frame, info: BodyInfo): void {
  for (let s = 1; s < info.n; s++) {
    if (info.joint[s] !== 'ankle') continue;
    let sum = 0;
    for (let p = info.parent[s]; p > 0 && (info.joint[p] === 'hip' || info.joint[p] === 'knee'); p = info.parent[p]) sum += f.pitch[p];
    f.pitch[s] -= sum;
  }
}

/** Standing: breathing, knees bobbing, a slow sway, the head turned to the camera, wings and tail at ease. */
export function stand(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  const br = Math.sin(TAU * BREATH_HZ * sec), bob = 0.5 - 0.5 * Math.cos(TAU * BREATH_HZ * sec);
  crouch(f, info, STAND_CROUCH + STAND_BOB * bob);
  body(f, STAND_LEAN + 0.02 * br, 0, STAND_SWAY * Math.sin(TAU * SWAY_HZ * sec));
  arms(f, info, 0, 0.15 + 0.06 * br, 0.18, 0.35);
  head(f, info, -0.04 * br, -a.facing * HEAD_TO_CAMERA, 0);
  wings(f, info, 0.15 + 0.08 * br, 0);
  tail(f, info, 0.15, 0.18, TAU * TAIL_HZ * sec);
}

/** In the air: tucked going up, reaching for the ground coming down, wings beating, leaning into the way it flies. */
export function air(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  const k = Math.max(-1, Math.min(1, a.vel.y / AIR_SPEED)), up = Math.max(0, k), down = Math.max(0, -k);
  const fwd = Math.max(-1, Math.min(1, (a.facing * a.vel.x) / RUN_FULL));
  for (let side = -1; side <= 1; side += 2) {
    const near = side === -a.facing ? 0.15 : -0.15; // the legs a little apart, like a leap
    legs(f, info, side, 0.5 + 0.5 * up - 0.3 * down + near, 0.9 + 0.6 * up - 0.6 * down, 0.05);
  }
  arms(f, info, 0, 0.6 + 1.4 * up + 0.2 * down, 0.35 + 0.8 * down, 0.4);
  body(f, 0.12 * fwd - 0.1 * up + 0.05, 0, 0);
  head(f, info, -0.15 * up + 0.1 * down, -a.facing * HEAD_TO_CAMERA * 0.5, 0);
  tail(f, info, -0.35 * up + 0.3 * down, 0.15, TAU * TAIL_HZ * 2 * sec);
  wings(f, info, 0.55 + 0.6 * Math.sin(TAU * FLAP_HZ * sec), 0);
}
