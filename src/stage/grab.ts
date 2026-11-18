import type { AttackDir } from './attacks';
import type { StageFighter } from './fighter';
import type { V2 } from './types';

/**
 * Grab and throw (spec §5.2): a fighter on the ground reaches out (`grab`); a foe it touches during the reach is caught,
 * lifted overhead and carried (`held`: it cannot act); a press of attack or grab throws it left, right (the stick, else
 * the facing) or up (stick up), launching it like a hit, so at high damage a throw can knock it out. A hold that goes on
 * too long ends in a throw the way the holder faces. Nothing is ever left stuck: a hit on either, either going out or
 * leaving the stage lets go (`release`). The sim links the two and carries the held one; the fighters keep the links.
 */

/** A grab, throw or let-go for the show: `id` holds (or held) `other`; a throw says which way (`forward` or `up`). */
export type GrabCue = { id: string; other: string; phase: 'grab' | 'throw' | 'release'; dir?: AttackDir };

/** The reach: steps before the hands can catch, steps they can, then the steps a miss takes to recover. */
export const GRAB_WINDUP = 4, GRAB_ACTIVE = 6, GRAB_MISS = 18;
/** The hands' circle: this far (m) past the front of the box, at half its height, of this radius (m). */
export const GRAB_AHEAD = 0.2, GRAB_R = 0.4;
/** Steps the lift overhead takes; a throw press counts only after it (so the grab press is never also the throw). */
export const LIFT_STEPS = 8;
/** A hold lasts at most this many steps (2 s), then the holder throws the way it faces. */
export const HOLD_MAX = 120;
/** A throw takes this many steps; the held one leaves the hands on step THROW_RELEASE. */
export const THROW_STEPS = 22, THROW_RELEASE = 8;
/** A throw launches like a hit of this power and damage, at this angle (degrees from the throw's way), or nearly straight up. */
export const THROW_POWER = 1.3, THROW_DAMAGE = 4, THROW_ANGLE = 40, THROW_UP_ANGLE = 88;
/** Overhead, the held body (lying flat) rests this far (m) above the holder's box. */
const CARRY_GAP = 0.05;
/** In front, at the catch, the held box's bottom is lifted this share of the holder's height. */
const FRONT_LIFT = 0.6;
/** Winding up a throw, the held one is swung back this far (m) behind the head, or dipped this far for a throw up. */
const SWING_BACK = 0.35, DIP = 0.15;

/** Whether `b` can be caught: in play and hittable, not already held or holding, and not mid-special or mid-tumble. */
export function grabbable(b: StageFighter): boolean {
  const a = b.action;
  return b.canBeHit() && !b.heldBy && !b.holding && a !== 'special' && a !== 'tumble' && a !== 'held' && a !== 'throw';
}

/** The hands' circle while the grab can catch, else null (into `out`). */
export function grabReach(f: StageFighter, out: { x: number; y: number; r: number }): { x: number; y: number; r: number } | null {
  if (f.action !== 'grab' || f.holding || f.actionT < GRAB_WINDUP || f.actionT >= GRAB_WINDUP + GRAB_ACTIVE) return null;
  const m = f.mover;
  out.x = m.pos.x + f.facing * (m.w / 2 + GRAB_AHEAD);
  out.y = m.pos.y + m.h / 2;
  out.r = GRAB_R;
  return out;
}

const smooth = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : p * p * (3 - 2 * p));

/**
 * Where `holder` carries `held` now (the held box's bottom centre, into `out`): snatched up in front at the catch,
 * lifted overhead over LIFT_STEPS (lying flat, resting just above the holder's head), then, winding up a throw, swung
 * back behind the head (or dipped, for a throw up). `front`: the spot in front at the holder's height instead (when the
 * space overhead is blocked).
 */
export function carrySpot(holder: StageFighter, held: StageFighter, front: boolean, out: V2): V2 {
  const a = holder.mover, b = held.mover, side = holder.facing;
  const fx = a.pos.x + side * (a.w / 2 + b.w / 2), fy = a.pos.y + a.h * FRONT_LIFT;
  if (front) {
    out.x = fx;
    out.y = a.pos.y + a.h * FRONT_LIFT * 0.5;
    return out;
  }
  // lying flat over the head: its middle at the head's top plus half its thickness (its box width)
  const ox = a.pos.x, oy = a.pos.y + a.h + CARRY_GAP + b.w / 2 - b.h / 2;
  if (holder.action === 'grab') {
    const k = smooth(holder.actionT / LIFT_STEPS);
    out.x = fx + (ox - fx) * k;
    out.y = fy + (oy - fy) * k;
    return out;
  }
  // winding up a throw
  const k = smooth(holder.actionT / THROW_RELEASE);
  out.x = ox - (holder.throwDir === 'up' ? 0 : side * SWING_BACK * k);
  out.y = oy - (holder.throwDir === 'up' ? DIP * k : 0);
  return out;
}
