import type { Move } from '../fight/types';
import type { AttackDir } from '../stage/attacks';
import {
  air, arms, body, CAMERA_TURN, crouch, easeOut, frac, grounded, head, legs, smooth, stand, tail, TAU, wings, type Frame,
} from './layers';
import type { AnimState, BodyInfo } from './pose';

/*
 * The attacks: a wind-up, a strike that snaps in and aims the weapon through the hit area, a recovery; each move with
 * its own wind-up and strike layer (`moveLayer`), which the specials reuse.
 */

// ---- attacks ----
/** The strike snaps in: half way on its first step, all the way half a step later. */
const STRIKE_START = 0.5, STRIKE_SNAP = 0.5;
/** The weapon sweeps this far (rad) either side of the hit area across the strike. */
const SWEEP = 0.35;
/** A spin attack's wind-up turn (rad), and how far round it is at the middle of the strike: facing the camera. */
const SPIN_WIND = 0.7, SPIN_HIT = TAU - (Math.PI / 2 - CAMERA_TURN);

/** Which weapon segment strikes: an end of a weapon (no weapon below it), on the near side if it has one, else the move's usual part. */
export function striker(info: BodyInfo, move: Move, near: number): number {
  let best = -1, score = -Infinity;
  for (let s = 0; s < info.n; s++) {
    const g = info.segments[s];
    let ok = g.weapon;
    if (ok) for (let c = s + 1; c < info.n; c++) if (info.parent[c] === s && info.segments[c].weapon) ok = false;
    if (!ok) continue;
    const sc = (info.side[s] === near ? 2 : info.side[s] === 0 ? 1 : 0) + s / 1000;
    if (sc > score) { score = sc; best = s; }
  }
  if (best >= 0) return best;
  // no weapon marked: the part the move strikes with, the near one, at the end of its limb
  for (let s = info.n - 1; s >= 0; s--) {
    const k = info.segments[s].kind;
    const fits = move === 'punch' || move === 'jab' ? k === 'hand' || k === 'arm'
      : move === 'kick' ? k === 'foot' || k === 'leg'
        : move === 'headbutt' || move === 'divebomb' ? k === 'head'
          : move === 'spin' ? k === 'tail' : false;
    if (!fits) continue;
    const sc = (info.side[s] === near ? 2 : info.side[s] === 0 ? 1 : 0) + s / 1000;
    if (sc > score) { score = sc; best = s; }
  }
  return best >= 0 ? best : 0;
}

/**
 * An attack: the stance (or the air pose) under a wind-up that eases in, then a strike that snaps in, aims the weapon
 * through the hit area and holds, then a recovery easing back. Around-the-body attacks (spins, bumps) turn the whole body.
 */
export function attack(f: Frame, info: BodyInfo, a: AnimState, sec: number): void {
  const atk = a.attack, dir: AttackDir = a.attackDir ?? 'forward';
  const W = atk ? atk.windup : 6, A = atk ? atk.active : 4, C = atk ? atk.cool : 12;
  const t = a.t;
  const strike = t < W ? 0 : t < W + A ? Math.min(1, STRIKE_START + (t - W) / STRIKE_SNAP) : 1 - smooth(frac(t - W - A, C));
  const wind = t < W ? easeOut(frac(t, W)) : 0;
  const onGround = a.ground && dir !== 'air';
  if (onGround) {
    grounded(f, true);
    stand(f, info, a, sec);
  } else air(f, info, a, sec);

  const near = -a.facing;
  const w = striker(info, a.move, near), side = info.side[w] === 0 ? near : info.side[w];
  if (atk && !atk.around) {
    f.aim = w;
    f.aimW = strike;
    f.lunge = true;
    const s = frac(t - W, A) * 2 - 1;
    f.sweep = (dir === 'up' ? -SWEEP : SWEEP) * s;
  }
  moveLayer(f, info, a, dir, side, wind, strike, W, A, C);
}

/** Each move's wind-up and strike over the stance: `side` is the striking weapon's side; `wind` and `strike` the layers' weights. */
export function moveLayer(f: Frame, info: BodyInfo, a: AnimState, dir: AttackDir, side: number, wind: number, strike: number,
  W: number, A: number, C: number): void {
  const t = a.t;
  switch (a.move) {
    case 'punch': case 'jab': {
      const g = a.move === 'jab' ? 0.6 : 1;
      // wind-up: the punching shoulder drawn back, elbow cocked, the other fist up on guard
      body(f, (-0.1 + (dir === 'down' ? 0.3 : 0)) * wind * g, side * 0.5 * wind * g, 0);
      crouch(f, info, (dir === 'up' ? 0.45 : 0.2) * wind * g);
      arms(f, info, side, -0.5 * wind * g, 0, 1.3 * wind);
      arms(f, info, -side, 0.8 * wind, 0, 1.2 * wind);
      // strike: the shoulder drives through, the body leans in, the guard stays up
      const lean = dir === 'forward' ? 0.35 : dir === 'up' ? -0.15 : dir === 'down' ? 0.45 : 0.15;
      body(f, lean * strike * g, -side * 0.45 * strike * g, 0);
      arms(f, info, -side, 0.9 * strike, 0, 1.4 * strike);
      if (dir === 'forward') {
        legs(f, info, side, -0.25 * strike, 0, 0);
        legs(f, info, -side, 0.3 * strike, 0.2 * strike, 0);
      } else if (dir === 'up') f.squash -= 0.08 * strike;
      else if (dir === 'down') crouch(f, info, 0.4 * strike);
      head(f, info, 0.1 * strike, 0, 0);
      break;
    }
    case 'kick': {
      // wind-up: the knee chambered up, leaning back, arms out for balance
      body(f, (dir === 'up' ? -0.25 : dir === 'down' ? 0.2 : -0.15) * wind, 0, 0);
      legs(f, info, side, 1.0 * wind, 1.5 * wind, 0);
      legs(f, info, -side, 0.15 * wind, 0.3 * wind, 0);
      arms(f, info, 0, 0.3 * wind, 0.6 * wind, 0);
      // strike: the leg straight out (aimed), the body leaning away from it
      const lean = dir === 'forward' ? -0.3 : dir === 'up' ? -0.45 : dir === 'down' ? 0.1 : -0.2;
      body(f, lean * strike, 0, 0);
      legs(f, info, -side, 0.1 * strike, 0.25 * strike, 0);
      arms(f, info, side, -0.5 * strike, 0.9 * strike, 0);
      arms(f, info, -side, 0.8 * strike, 0.9 * strike, 0);
      break;
    }
    case 'bump': {
      // wind-up: reared back, crouched, arms back
      body(f, (dir === 'down' ? -0.4 : -0.3) * wind, 0, 0);
      crouch(f, info, (dir === 'up' ? 0.6 : 0.4) * wind);
      arms(f, info, 0, -0.6 * wind, 0.4 * wind, 0);
      if (dir === 'forward') {
        // the belly leads: a hop forward
        f.liftZ += 0.3 * info.boxH * strike;
        body(f, -0.15 * strike, 0, 0);
        arms(f, info, 0, -0.8 * strike, 0.6 * strike, 0);
      } else if (dir === 'up') {
        f.squash -= 0.18 * strike;
        body(f, -0.15 * strike, 0, 0);
        arms(f, info, 0, 2.6 * strike, 0.2 * strike, 0);
      } else if (dir === 'down') {
        f.squash += 0.22 * strike;
        body(f, 0.3 * strike, 0, 0);
        arms(f, info, 0, 0, 1.2 * strike, 0);
      } else {
        // a belly flop, face down
        body(f, 1.1 * strike, 0, 0);
        arms(f, info, 0, 0, 1.3 * strike, 0);
      }
      break;
    }
    case 'headbutt': {
      // wind-up: reared back, head drawn back
      body(f, (dir === 'down' ? -0.1 : -0.35) * wind, 0, 0);
      head(f, info, (dir === 'up' ? 0.4 : -0.35) * wind, 0, 0);
      crouch(f, info, (dir === 'up' ? 0.45 : 0.2) * wind);
      arms(f, info, 0, -0.4 * wind, 0.3 * wind, 0);
      if (dir === 'forward') {
        body(f, 0.5 * strike, 0, 0);
        f.liftZ += 0.12 * info.boxH * strike;
        arms(f, info, 0, -0.6 * strike, 0.5 * strike, 0);
      } else if (dir === 'up') {
        body(f, -0.25 * strike, 0, 0);
        f.squash -= 0.1 * strike;
        arms(f, info, 0, 0, 0.8 * strike, 0);
      } else if (dir === 'down') {
        body(f, 1.15 * strike, 0, 0); // a deep bow: the head stays on its neck, the body brings it down
        crouch(f, info, 0.3 * strike);
      } else {
        // flying head-first, legs trailing
        body(f, 1.0 * strike, 0, 0);
        legs(f, info, 0, -0.6 * strike, 0, 0);
        arms(f, info, 0, -0.8 * strike, 0, 0);
      }
      break;
    }
    case 'spin': {
      // the whole body twirls once, the way it faces: wound back, whipped round to face the camera at the middle of
      // the strike (the tail or arms sweeping past on either side), then settling a whole turn on, as it began
      const mid = W + A / 2;
      const turn = t < W ? -SPIN_WIND * easeOut(frac(t, W))
        : t < mid ? -SPIN_WIND + (SPIN_HIT + SPIN_WIND) * ((t - W) / (A / 2))
          : SPIN_HIT + (TAU - SPIN_HIT) * easeOut(frac(t - mid, A / 2 + C / 2));
      f.twirl += a.facing * turn;
      const out = Math.max(wind, strike);
      arms(f, info, 0, 0, 1.2 * out, 0);
      if (dir === 'up') {
        tail(f, info, 1.2 * out, 0, 0);
        arms(f, info, 0, 2.4 * out, 0, 0);
        f.squash -= 0.06 * strike;
      } else if (dir === 'down') {
        crouch(f, info, 0.4 * out);
        tail(f, info, -0.15 * out, 0, 0);
      } else tail(f, info, 0.15 * out, 0, 0);
      break;
    }
    case 'divebomb': {
      // wind-up: wings raised high, reared back
      body(f, (dir === 'air' ? -0.3 : -0.25) * wind, 0, 0);
      wings(f, info, 1.1 * wind, 0);
      head(f, info, -0.2 * wind, 0, 0);
      crouch(f, info, 0.3 * wind);
      if (dir === 'forward') {
        body(f, 0.6 * strike, 0, 0);
        f.liftZ += 0.1 * info.boxH * strike;
        wings(f, info, -0.2 * strike, 0.5 * strike);
      } else if (dir === 'up') {
        body(f, -0.2 * strike, 0, 0);
        f.squash -= 0.08 * strike;
        wings(f, info, -0.4 * strike, 0);
      } else if (dir === 'down') {
        body(f, 1.2 * strike, 0, 0);
        crouch(f, info, 0.3 * strike);
        wings(f, info, 0.6 * strike, 0);
      } else {
        // the dive: nose down, wings swept back, legs trailing
        body(f, 2.0 * strike, 0, 0);
        wings(f, info, 0.3 * strike, 0.9 * strike);
        legs(f, info, 0, -0.8 * strike, 0, 0);
      }
      break;
    }
  }
}
