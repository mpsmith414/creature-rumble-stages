import { DT } from '../stage/types';
import {
  air, arms, body, clamp01, crouch, flatFeet, grounded, head, HEAD_TO_CAMERA, legs, RUN_FULL, smooth, stand, tail, TAU, wings,
  type Frame,
} from './layers';
import type { AnimState, BodyInfo } from './pose';
import { grabClip, heldClip, specialClip, throwClip } from './specials';
import { attack } from './strikes';

export { CAMERA_TURN, newFrame, type Frame } from './layers';
export { striker } from './strikes';

/**
 * The clips: for a body and a moment, the pose as a `Frame` (see `layers.ts`): a stance under everything, an action
 * over it. Everything is a function of the state alone, so a bout replays the same and a frozen fighter holds still.
 * The attacks are in `strikes.ts`; the specials, grabs and throws in `specials.ts`.
 */

// ---- running ----
/** Strides a second for a 1.4 m body (smaller bodies scamper faster: × √(1.4 / height)). */
const RUN_HZ = 2.2, AVERAGE_HEIGHT = 1.4;
/** Leg swing, knee lift, arm swing and lean at full speed (rad). */
const RUN_LEG = 0.65, RUN_KNEE = 1.1, RUN_ARM = 0.7, RUN_LEAN = 0.22;
/** The share of the full swing at a walk. */
const RUN_MIN = 0.4;
/** A legless body waddles: its rock side to side and its twist (rad). */
const WADDLE_TILT = 0.2, WADDLE_TWIST = 0.15;

// ---- landing, hits, dodges ----
const LAND_CROUCH = 0.55, LAND_SQUASH = 0.16;
/** A dodge rolls when moving faster than this (m/s); the roll takes this share of the dodge. */
const ROLL_FROM = 2, ROLL_SHARE = 0.6;
/** A sidestep's slide toward the camera (m). */
const SIDESTEP_SLIDE = 0.35;

// ---- hanging from a vine (the jungle's mischief) ----
/** Arms raised overhead to the grip (rad: nearly straight up, the shoulders' limit is 2.9), a little apart, elbows soft. */
const HANG_ARMS = 2.75, HANG_SPREAD = 0.12, HANG_ELBOW = 0.12;
/** The legs trail the swing by up to this much (rad) at HANG_SWING m/s, and kick gently this often (Hz). */
const HANG_TRAIL = 0.35, HANG_SWING = 6, HANG_KICK_HZ = 1.4;

/** A show-off twirl's turns a second. */
const SHOW_TWIRL_HZ = 0.8;

/** Fills `f` with the pose for state `a` of the body `info`. */
export function fillFrame(info: BodyInfo, a: AnimState, f: Frame): void {
  reset(f);
  const sec = a.t * DT;
  switch (a.action) {
    case 'idle':
      grounded(f, a.ground);
      if (a.ground) stand(f, info, a, sec);
      else air(f, info, a, sec);
      break;
    case 'run':
      grounded(f, a.ground);
      if (a.ground) run(f, info, a, sec);
      else air(f, info, a, sec);
      break;
    case 'air':
      if (a.hang) hang(f, info, a, sec);
      else air(f, info, a, sec);
      break;
    case 'land':
      grounded(f, true);
      stand(f, info, a, sec);
      land(f, info, a.land);
      break;
    case 'attack':
      attack(f, info, a, sec);
      break;
    case 'special':
      specialClip(f, info, a, sec);
      break;
    case 'hitstun':
      hitstun(f, info, a, sec);
      break;
    case 'tumble': case 'out':
      // one rigid spin: no joint turns at all, so the body keeps its shape exactly
      f.spin = a.spin;
      break;
    case 'held':
      heldClip(f, info, a, sec);
      break;
    case 'dodge':
      dodge(f, info, a, sec);
      break;
    case 'grab':
      grabClip(f, info, a, sec);
      break;
    case 'throw':
      throwClip(f, info, a, sec);
      break;
    case 'showoff':
      grounded(f, a.ground);
      stand(f, info, a, sec);
      showOff(f, info, a, sec);
      break;
    case 'frozen':
      grounded(f, a.ground);
      stand(f, info, a, 0);
      break;
  }
  if (f.flat) flatFeet(f, info);
}

function reset(f: Frame): void {
  f.pitch.fill(0);
  f.yaw.fill(0);
  f.roll.fill(0);
  f.liftX = f.liftY = f.liftZ = 0;
  f.twirl = f.spin = f.squash = f.slide = 0;
  f.ground = f.plant = f.flat = false;
  f.aim = -1;
  f.aimW = f.sweep = 0;
  f.lunge = false;
  f.aimDx = f.aimDy = f.aimR = 0;
}

// ---- clips ----

/** Running: legs stride with knees lifting, arms swing against them, leaning in; a legless body waddles. */
function run(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  const phi = TAU * RUN_HZ * (info.height > 0 ? Math.sqrt(AVERAGE_HEIGHT / info.height) : 1) * sec;
  const sp = Math.max(RUN_MIN, Math.min(1, Math.abs(a.vel.x) / RUN_FULL));
  for (let side = -1; side <= 1; side += 2) {
    const psi = phi + (side > 0 ? 0 : Math.PI);
    if (info.legs) legs(f, info, side, RUN_LEG * sp * Math.sin(psi), RUN_KNEE * sp * (0.5 + 0.5 * Math.cos(psi)) + 0.1, 0);
    else legs(f, info, side, 0.5 * sp * Math.sin(psi), 0, 0);
    arms(f, info, side, -RUN_ARM * sp * Math.sin(psi), 0.15, 0.9);
  }
  body(f, RUN_LEAN * sp, 0.12 * Math.sin(phi), info.legs ? 0 : WADDLE_TILT * sp * Math.sin(phi));
  if (!info.legs) f.yaw[0] += WADDLE_TWIST * sp * Math.sin(phi);
  head(f, info, -0.12, -a.facing * HEAD_TO_CAMERA * 0.4, 0);
  tail(f, info, 0.3, 0.3, 2 * phi);
  wings(f, info, 0.35 + 0.25 * Math.sin(2 * phi), 0);
}

/** A landing (`l`: 1 at touch-down, 0 when done) over the stance: a deep knee bend and a squash that ease off. */
function land(f: Frame, info: BodyInfo, l: number): void {
  crouch(f, info, LAND_CROUCH * l);
  body(f, 0.25 * l, 0, 0);
  arms(f, info, 0, -0.2 * l, 0.5 * l, 0);
  head(f, info, 0.2 * l, 0, 0);
  tail(f, info, -0.3 * l, 0, 0);
  wings(f, info, 0.5 * l, 0);
  f.squash += LAND_SQUASH * l;
}

/** A flinch: thrown back from the hit and easing back up (on the ground the feet stay down; in the air the legs fly forward). */
function hitstun(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  const p = a.len > 0 ? clamp01(a.t / a.len) : 1, k = (1 - p) * Math.sqrt(1 - p);
  if (a.ground) {
    grounded(f, true);
    stand(f, info, a, sec);
    crouch(f, info, 0.25 * k);
  } else legs(f, info, 0, 0.6 * k, 0.5, 0.1);
  body(f, -0.45 * k, 0.1 * k, 0);
  head(f, info, -0.4 * k, 0, 0.15 * k);
  arms(f, info, 0, 0.6 * k, 0.9 * k, 0.3);
  wings(f, info, 0.9 * k, 0);
  tail(f, info, 0.5 * k, 0, 0);
}

/**
 * Hanging from a vine: both arms straight up to the grip (the sim holds the hands, the box's top, on it), the legs
 * dangling together and trailing the swing with a little kick, the head tipped back to look up. A body without arms
 * hangs on by looking up at it.
 */
function hang(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  const swing = Math.max(-1, Math.min(1, (a.facing * a.vel.x) / HANG_SWING));
  const kick = 0.12 * Math.sin(TAU * HANG_KICK_HZ * sec);
  for (let side = -1; side <= 1; side += 2) legs(f, info, side, -HANG_TRAIL * swing + side * kick, 0.25, 0.04);
  arms(f, info, 0, HANG_ARMS, HANG_SPREAD, HANG_ELBOW);
  body(f, -0.08 * swing, 0, 0);
  head(f, info, info.joint.includes('shoulder') ? -0.25 : -0.45, -a.facing * HEAD_TO_CAMERA * 0.5, 0);
  tail(f, info, -0.5, 0.12, TAU * 0.6 * sec);
  wings(f, info, 0.25, 0.3);
}

/** A dodge: a tucked roll along the ground, or in place a quick twirl (stepping toward the camera on the ground). */
function dodge(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  const len = a.len > 0 ? a.len : 1;
  const p = clamp01(a.t / (len * ROLL_SHARE)), tuck = Math.sin(Math.PI * p);
  f.ground = a.ground;
  if (a.ground && Math.abs(a.vel.x) > ROLL_FROM) {
    // a forward roll the way it moves: clockwise seen from the camera when moving right
    f.spin = -Math.sign(a.vel.x) * TAU * smooth(p);
  } else {
    if (a.ground) {
      grounded(f, true);
      stand(f, info, a, sec);
      f.slide = SIDESTEP_SLIDE * Math.sin(Math.PI * clamp01(a.t / len));
    }
    f.twirl = a.facing * TAU * smooth(p);
  }
  legs(f, info, 0, 1.2 * tuck, 1.8 * tuck, 0);
  arms(f, info, 0, 1.0 * tuck, 0.2 * tuck, 1.2 * tuck);
  head(f, info, 0.5 * tuck, 0, 0);
  body(f, 0.3 * tuck, 0, 0);
  tail(f, info, 0.6 * tuck, 0, 0);
  wings(f, info, -0.2 * tuck, 0.6 * tuck);
}

/** Each move's show-off, over the stance: what this body is proud of. */
function showOff(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  const bounce = 0.5 - 0.5 * Math.cos(TAU * 2 * sec);
  switch (a.move) {
    case 'punch':
      // fists pumped at the sky, one then the other
      for (let side = -1; side <= 1; side += 2) {
        const pump = Math.max(0, Math.sin(TAU * 1.6 * sec + (side > 0 ? 0 : Math.PI)));
        arms(f, info, side, 1.6 + 1.0 * pump, 0.5, 0.6 * (1 - pump));
      }
      crouch(f, info, 0.15 * bounce);
      head(f, info, -0.15, 0, 0);
      break;
    case 'jab':
      // shadow-boxing: quick jabs side by side, bouncing on its toes
      for (let side = -1; side <= 1; side += 2) {
        const j = Math.max(0, Math.sin(TAU * 3 * sec + (side > 0 ? 0 : Math.PI))) ** 2;
        arms(f, info, side, 0.9 + 0.8 * j, 0, 1.2 - 1.0 * j);
      }
      crouch(f, info, 0.12 * (0.5 - 0.5 * Math.cos(TAU * 6 * sec)));
      body(f, 0.1, 0.25 * Math.sin(TAU * 3 * sec), 0);
      break;
    case 'kick': {
      // a high kick with the near leg, arms out for balance
      const c = (sec * 0.7) % 1, kick = Math.sin(Math.PI * clamp01(c * 2.5));
      legs(f, info, -a.facing, 1.7 * kick, 0.2 * kick, 0);
      arms(f, info, 0, 0.2, 0.9 * kick, 0);
      body(f, -0.3 * kick, 0, 0);
      crouch(f, info, 0.1 * bounce);
      break;
    }
    case 'bump':
      // a proud belly bounce, hands on hips
      f.squash += 0.08 * Math.sin(TAU * 2 * sec);
      body(f, -0.25, 0, 0.15 * Math.sin(TAU * sec));
      arms(f, info, 0, -0.1, 0.6, 1.2);
      break;
    case 'headbutt':
      // a big nodding stomp
      head(f, info, 0.35 * Math.sin(TAU * 2.2 * sec), 0, 0);
      body(f, 0.15 + 0.1 * Math.sin(TAU * 2.2 * sec), 0, 0);
      for (let side = -1; side <= 1; side += 2) {
        const st = Math.max(0, Math.sin(TAU * 1.1 * sec + (side > 0 ? 0 : Math.PI)));
        legs(f, info, side, 0.35 * st, 0.6 * st, 0);
      }
      break;
    case 'spin':
      // a twirl with arms out and tail up
      f.twirl += a.facing * TAU * SHOW_TWIRL_HZ * sec;
      arms(f, info, 0, 0, 1.3, 0);
      tail(f, info, 0.4, 0, 0);
      break;
    case 'divebomb':
      // wings spread and beating, arms out like a plane
      wings(f, info, 0.8 + 0.6 * Math.sin(TAU * 2.5 * sec), 0);
      arms(f, info, 0, 0, 1.3, 0);
      body(f, 0.3, 0, 0);
      crouch(f, info, 0.1 * bounce);
      break;
  }
}
