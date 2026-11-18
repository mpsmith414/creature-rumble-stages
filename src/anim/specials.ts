import { SPECIAL_FOR } from '../fight/special';
import { GRAB_ACTIVE, GRAB_WINDUP, LIFT_STEPS, THROW_RELEASE } from '../stage/grab';
import {
  HELI_TO, JAB_EVERY, JABS, METEOR_RISE_STEPS, ROCKET_STEPS, SLAM_REST, SPECIAL_STEPS, TORNADO_STEPS,
} from '../stage/specials';
import {
  air, arms, body, clamp01, crouch, easeOut, frac, grounded, head, HEAD_TO_CAMERA, legs, smooth, stand, tail, TAU, wings,
  type Frame,
} from './layers';
import type { AnimState, BodyInfo } from './pose';
import { attack, moveLayer, striker } from './strikes';

/*
 * The big moves' clips: the seven specials, the grab, the throw and being held. Big, readable and slapstick, and as
 * every clip, built only from joint turns and whole-body moves, so the body stays in one piece (a held creature is
 * carried lying flat, held together; a thrown one tumbles as one). The specials follow their scripts' beats in
 * `src/stage/specials.ts` (a wind-up of `charge` steps, then the move).
 */

/** A special's wind-up trembles with power: this fast (Hz) and this far (rad). */
const TREMBLE_HZ = 9, TREMBLE = 0.04;
/** Turns of the Helicopter Kick and the Tornado Tail (whole turns, so each ends facing its way again). */
const HELI_TURNS = 3, TORNADO_TURNS = 4;
/** The Tornado Tail's wind-up turn back (rad). */
const TORNADO_WIND = 0.7;
/** Forward lean (rad) of a body lying face down (Belly Bomb's flop) and of the Meteor Dive and the Rocket Headbutt. */
const FLOP_LEAN = 1.3, DIVE_LEAN = 1.2, ROCKET_LEAN = 1.25;
/** Falling this fast (m/s) the Belly Bomb lies fully flat. */
const FLOP_SPEED = 8;
/** Steps the Rocket Headbutt and the Tornado Tail take to settle back after their move. */
const SETTLE = 12;
/** Wing beats a second rising into the Meteor Dive. */
const METEOR_FLAP_HZ = 5;
/** The held one's legs kick and arms wave this fast (Hz). */
const KICK_HZ = 3;

/** A state to hand on to the attack clip (reused; the special's own state with a direction). */
const as: AnimState = {
  action: 'attack', t: 0, len: 0, facing: 1, pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, move: 'punch', spin: 0, land: 0, ground: true,
};

/** The stance on the ground, or the air pose. */
function base(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  if (a.ground) {
    grounded(f, true);
    stand(f, info, a, sec);
  } else air(f, info, a, sec);
}

/** A wind-up's tremble with power, `k` 0…1. */
function tremble(f: Frame, k: number, sec: number): void {
  body(f, 0, TREMBLE * k * Math.sin(TAU * TREMBLE_HZ * sec), TREMBLE * 0.5 * k * Math.cos(TAU * TREMBLE_HZ * 1.3 * sec));
}

/** A special: each body's own big move, its wind-up then the move (see the file's note). */
export function specialClip(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  const name = SPECIAL_FOR[a.move], C = SPECIAL_STEPS[name].charge, t = a.t, k = t - C;
  const c = frac(t, C), near = -a.facing;
  switch (name) {
    case 'megaPunch': {
      // the punch's own swing, with its wind-up stretched over the long glowing charge, wound much further
      Object.assign(as, a);
      as.action = 'attack';
      as.attackDir = 'forward';
      attack(f, info, as, sec);
      if (k < 0) {
        const w = easeOut(c), side = sideOf(info, a, near);
        body(f, -0.1 * w, side * 0.4 * w, 0);
        arms(f, info, side, -0.6 * w, 0.2 * w, 0.4 * w);
        crouch(f, info, 0.2 * w);
        tremble(f, c, sec);
      }
      break;
    }
    case 'jabFlurry':
      jabFlurry(f, info, a, sec, C);
      break;
    case 'helicopterKick': {
      base(f, info, a, sec);
      if (k < 0) {
        crouch(f, info, 0.45 * easeOut(c));
        arms(f, info, 0, 0.3 * c, 0.6 * c, 0);
        tremble(f, c, sec);
        break;
      }
      // a spin with the legs straight out to the sides, arms out, whole turns so it ends facing its way
      const p = frac(k, HELI_TO), out = 1 - smooth(frac(k - HELI_TO, SPECIAL_STEPS[name].release - HELI_TO));
      f.twirl += a.facing * TAU * HELI_TURNS * smooth(p);
      legs(f, info, 0, 0.35 * out, -0.2 * out, 1.2 * out);
      arms(f, info, 0, 0, 1.3 * out, 0);
      tail(f, info, 0.6 * out, 0, 0);
      wings(f, info, 0.8 * out, 0);
      break;
    }
    case 'bellyBomb':
      bellyBomb(f, info, a, sec, C);
      break;
    case 'rocketHeadbutt': {
      base(f, info, a, sec);
      if (k < 0) {
        // reared back, head down, a foot pawing the floor like a bull
        moveLayer(f, info, a, 'forward', sideOf(info, a, near), easeOut(c), 0, C, 1, 1);
        if (a.ground) legs(f, info, near, 0.35 * Math.sin(TAU * 3 * sec) * c, 0.4 * c, 0);
        tremble(f, c, sec);
        break;
      }
      // head-first and flat out, legs trailing, then back on its feet
      const on = k < ROCKET_STEPS ? 1 : 1 - smooth(frac(k - ROCKET_STEPS, SETTLE));
      f.plant = f.flat = false;
      body(f, ROCKET_LEAN * on, 0, 0);
      head(f, info, -0.45 * on, 0, 0);
      legs(f, info, 0, -0.7 * on, 0.2 * on, 0);
      arms(f, info, 0, -0.9 * on, 0.3 * on, 0);
      tail(f, info, -0.4 * on, 0, 0);
      wings(f, info, 0.2 * on, 0.9 * on);
      break;
    }
    case 'tornadoTail': {
      base(f, info, a, sec);
      if (k < 0) {
        f.twirl -= a.facing * TORNADO_WIND * easeOut(c);
        crouch(f, info, 0.3 * c);
        tail(f, info, 0.5 * c, 0, 0);
        arms(f, info, 0, 0, 0.8 * c, 0);
        tremble(f, c, sec);
        break;
      }
      // a steady whirl, tail and arms flung out, whole turns from the wound-back start
      const p = frac(k, TORNADO_STEPS), out = 1 - smooth(frac(k - TORNADO_STEPS, SETTLE));
      f.twirl += a.facing * (-TORNADO_WIND + (TAU * TORNADO_TURNS + TORNADO_WIND) * p);
      arms(f, info, 0, 0, 1.3 * out, 0);
      tail(f, info, 0.7 * out, 0, 0);
      crouch(f, info, 0.2 * out);
      wings(f, info, 0.9 * out, 0);
      break;
    }
    case 'meteorDive':
      meteorDive(f, info, a, sec, C);
      break;
  }
}

/** The striking weapon's side (as the attack clip picks it): its own side, or the near side for one in the middle. */
function sideOf(info: BodyInfo, a: AnimState, near: number): number {
  const w = striker(info, a.move, near);
  return info.side[w] === 0 ? near : info.side[w];
}

/** Jab Flurry: guard up and bouncing, six jabs from alternate fists, each aimed at the jab's spot, then an uppercut. */
function jabFlurry(f: Frame, info: BodyInfo, a: AnimState, sec: number, C: number): void {
  const t = a.t, k = t - C, near = -a.facing;
  base(f, info, a, sec);
  if (k < 0) {
    const c = frac(t, C);
    arms(f, info, 0, 0.9 * c, 0, 1.2 * c);
    crouch(f, info, 0.12 * c * (0.5 - 0.5 * Math.cos(TAU * 6 * sec)));
    tremble(f, c, sec);
    return;
  }
  if (k < JABS * JAB_EVERY) {
    const j = Math.floor(k / JAB_EVERY), u = k - j * JAB_EVERY;
    const pulse = u < JAB_EVERY / 2 ? 1 : 1 - smooth(frac(u - JAB_EVERY / 2, JAB_EVERY / 2));
    const hand = j % 2 === 0 ? near : -near, w = striker(info, a.move, hand), side = info.side[w] === 0 ? hand : info.side[w];
    moveLayer(f, info, a, 'forward', side, 0, pulse, 0, 1, 1);
    const atk = a.attack;
    if (atk) {
      // the jab's spot: a little lower and nearer than the uppercut's
      f.aim = w;
      f.aimW = pulse;
      f.aimDx = atk.area.dx * 1.2;
      f.aimDy = atk.area.dy * 0.75;
      f.aimR = atk.area.r;
      f.lunge = true;
    }
    return;
  }
  // the uppercut, aimed at its own spot overhead
  const W = JABS * JAB_EVERY, atk = a.attack;
  const pop = atk ? atk.windup - C : W + 4;
  const wind = k < pop ? easeOut(frac(k - W, pop - W)) : 0;
  const strike = k < pop ? 0 : 1 - smooth(frac(k - pop - (atk ? atk.active : 4), atk ? atk.cool : 12));
  const side = sideOf(info, a, near);
  moveLayer(f, info, a, 'up', side, wind, strike, 0, 1, 1);
  if (atk && strike > 0) {
    f.aim = striker(info, a.move, near);
    f.aimW = strike;
    f.lunge = true;
  }
}

/**
 * Belly Bomb: a deep crouch, a leap stretched tall with the arms up, a flop face down with arms and legs spread wide,
 * the slam (a big squash) and getting back up.
 */
function bellyBomb(f: Frame, info: BodyInfo, a: AnimState, sec: number, C: number): void {
  const t = a.t, k = t - C;
  if (k < 0) {
    const c = frac(t, C);
    base(f, info, a, sec);
    crouch(f, info, 0.55 * easeOut(c));
    body(f, -0.2 * c, 0, 0);
    arms(f, info, 0, -0.6 * c, 0.4 * c, 0);
    tremble(f, c, sec);
    return;
  }
  if (a.ground && k > 0) {
    // slammed: lying face down, squashed, then up again over SLAM_REST
    const p = frac(t - (a.len - SLAM_REST), SLAM_REST), lie = 1 - smooth(p);
    grounded(f, true);
    stand(f, info, a, sec);
    f.plant = f.flat = false;
    body(f, FLOP_LEAN * lie, 0, 0);
    arms(f, info, 0, 0, 1.3 * lie, 0);
    legs(f, info, 0, -0.3 * lie, 0, 0.5 * lie);
    head(f, info, -0.5 * lie, 0, 0);
    wings(f, info, 1.0 * lie, 0);
    f.squash += 0.3 * lie * lie;
    return;
  }
  air(f, info, a, sec);
  const flop = clamp01(-a.vel.y / FLOP_SPEED), rise = 1 - flop;
  // rising: stretched tall, arms up; falling: tipping over face down, spread like a star
  f.squash -= 0.1 * rise;
  arms(f, info, 0, 2.4 * rise, 1.3 * flop, 0);
  body(f, FLOP_LEAN * smooth(flop), 0, 0);
  legs(f, info, 0, -0.5 * flop, -0.4 * flop, 0.6 * flop);
  head(f, info, -0.5 * flop, 0, 0);
  wings(f, info, 1.1 * flop, 0);
  tail(f, info, 0.4 * flop, 0, 0);
}

/**
 * Meteor Dive: rising with the wings beating hard, hovering as it tips forward, then a dive head first at 45° with the
 * wings swept back, the slam where it lands (a squash, wings spread) and getting back up.
 */
function meteorDive(f: Frame, info: BodyInfo, a: AnimState, sec: number, C: number): void {
  const t = a.t, k = t - C;
  if (a.ground && k > 0) {
    const p = frac(t - (a.len - SLAM_REST), SLAM_REST), hit = 1 - smooth(p);
    grounded(f, true);
    stand(f, info, a, sec);
    crouch(f, info, 0.5 * hit);
    body(f, 0.4 * hit, 0, 0);
    wings(f, info, 1.0 * hit, 0);
    arms(f, info, 0, 0, 1.0 * hit, 0);
    f.squash += 0.25 * hit * hit;
    return;
  }
  base(f, info, a, sec);
  if (k < 0) {
    const tip = smooth(frac(t - METEOR_RISE_STEPS, C - METEOR_RISE_STEPS));
    wings(f, info, 0.9 + 0.7 * Math.sin(TAU * METEOR_FLAP_HZ * sec), 0);
    legs(f, info, 0, 0.6, 1.0, 0);
    body(f, -0.2 + 0.8 * tip, 0, 0);
    arms(f, info, 0, -0.5 * tip, 0.4, 0);
    tremble(f, frac(t, C), sec);
    return;
  }
  body(f, DIVE_LEAN, 0, 0);
  head(f, info, -0.3, 0, 0);
  wings(f, info, 0.3, 0.9);
  legs(f, info, 0, -0.8, 0, 0);
  arms(f, info, 0, -0.8, 0.2, 0);
  tail(f, info, -0.3, 0, 0);
}

/**
 * A grab: reaching out with both hands at chest height (and back if it missed), or, holding someone, lifting them
 * overhead and bracing under them, looking up.
 */
export function grabClip(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  const t = a.t;
  base(f, info, a, sec);
  if (!a.holding) {
    const reach = t < GRAB_WINDUP ? easeOut(frac(t, GRAB_WINDUP)) : 1 - smooth(frac(t - GRAB_WINDUP - GRAB_ACTIVE, a.len - GRAB_WINDUP - GRAB_ACTIVE));
    arms(f, info, 0, 1.45 * reach, -0.1 * reach, 0.1);
    body(f, 0.3 * reach, 0, 0);
    head(f, info, 0.1 * reach, 0, 0);
    legs(f, info, -a.facing, 0.3 * reach, 0.2 * reach, 0);
    wings(f, info, 0.6 * reach, 0);
    return;
  }
  const up = smooth(frac(t, LIFT_STEPS));
  arms(f, info, 0, 1.45 + 1.35 * up, 0.15 * up, 0.25);
  body(f, 0.3 - 0.45 * up, 0, 0);
  crouch(f, info, 0.25 * up + 0.05 * Math.sin(TAU * 2 * sec) * up);
  head(f, info, -0.35 * up, 0, 0);
  wings(f, info, 0.5 * up, 0);
  tail(f, info, 0.3 * up, 0, 0);
}

/**
 * A throw: forward, leaning back with the held one overhead, then hurling it with the whole body and a step; up, a
 * crouch under it and a pop straight up onto the toes. Then back to the stance.
 */
export function throwClip(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  const t = a.t, back = t < THROW_RELEASE ? smooth(frac(t, THROW_RELEASE)) : 0;
  const hurl = t < THROW_RELEASE ? 0 : 1 - smooth(frac(t - THROW_RELEASE - 3, a.len - THROW_RELEASE - 3));
  base(f, info, a, sec);
  const hold = t < THROW_RELEASE ? 1 : 0;
  if (a.throwUp) {
    arms(f, info, 0, 2.8 * hold + 2.9 * hurl, 0.15, 0.25 * hold);
    crouch(f, info, 0.4 * back);
    f.squash -= 0.12 * hurl;
    head(f, info, -0.4 * (back + hurl), 0, 0);
  } else {
    arms(f, info, 0, 2.8 * hold + 1.2 * hurl, 0.15, 0.25 * hold);
    body(f, -0.15 * hold - 0.25 * back + 0.45 * hurl, 0, 0);
    legs(f, info, -a.facing, 0.4 * hurl, 0.2 * hurl, 0);
    legs(f, info, a.facing, -0.25 * hurl, 0, 0);
    crouch(f, info, 0.2 * back);
    head(f, info, -0.3 * back + 0.15 * hurl, 0, 0);
  }
  wings(f, info, 0.5 * (hold + hurl), 0);
  tail(f, info, 0.3 * (hold + hurl), 0, 0);
}

/**
 * Held overhead: lying flat on its back, held together (one turn of the whole body), tail curled along its back,
 * legs kicking and arms waving in protest, head turned to the camera.
 */
export function heldClip(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  f.spin = (a.facing * Math.PI) / 2;
  const ph = TAU * KICK_HZ * sec;
  for (let side = -1; side <= 1; side += 2) {
    const s = Math.sin(ph + (side > 0 ? 0 : Math.PI));
    legs(f, info, side, 0.35 + 0.3 * s, 0.5 - 0.3 * s, 0.1);
    arms(f, info, side, 1.2 + 0.35 * s, 0.3, 0.4);
  }
  tail(f, info, 1.2, 0, 0);
  head(f, info, 0, -a.facing * HEAD_TO_CAMERA, 0);
  wings(f, info, 0.5 + 0.3 * Math.sin(ph * 1.5), 0);
}
