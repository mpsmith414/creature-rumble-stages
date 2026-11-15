import { Vector3 } from 'three/webgpu';
import { fnv1a } from '../util/hash';
import type { StuntOrder } from './stunts';

/**
 * A fighter's brain (the spike's Creature.think, spike/creature.ts, with the pace of design 2026-11-14 §3): pick a
 * target, go at it, circle it in reach (never standing still), attack, steer back from the edge; choose stunts (leap,
 * dash, dodge, rope spring, grab) to jump around the ring; alone (or as champion) strut and hop round the ring showing off.
 */

export type AttackPhase = 'none' | 'windup' | 'strike' | 'cool';

/** What the brain needs to know about another fighter. */
export type Rival = {
  readonly state: string;
  readonly ragdoll: { pos(): Vector3 };
  /** Launched and not down yet. */
  readonly flying?: boolean;
  /** Where its attack is (a wind-up is a chance to dodge). */
  readonly attack?: AttackPhase;
  /** How far (m) its attack reaches. */
  readonly reach?: number;
  /** Held over someone's head (grab and throw): nobody's target. */
  readonly held?: boolean;
  /** It could be grabbed now (on its feet, not in a special, not held or holding). */
  readonly grabbable?: boolean;
  /** Hit power taken, healing slowly. */
  readonly wobble?: number;
};

/** What the brain knows of its own fighter when it chooses a stunt (`grab`: its grab's cool-down is over). */
export type Self = { reach: number; ringHeight: number; grab?: boolean };

/** A breath (s) before a fighter's first strut or boast hop. */
const BREATH_S = 1.5;
/** Strut circle radius (× ring radius) and speed (rad/s) when showing off. */
const STRUT_R = 0.42, STRUT_RATE = 0.6;
/** Pushed back from the edge this hard (per metre past `edgeMargin`). */
const EDGE_PUSH = 1.8;
/** Turn toward the wanted facing by this fraction each tick. */
const TURN = 0.2;
/**
 * The pace (design §3): in reach a fighter goes in at its target as the spike did (full speed, then creeping in at
 * `CREEP` × once within `SWING_CLOSE` × its reach) and circles it, strafing at `CIRCLE` × its speed (× `CIRCLE_SWING`
 * while it swings, or once it is eager); it never stands still. (Measured against 0.3 on 210 bouts, seeds 17–19: at
 * 0.6, 14% of bouts had a 3 s stretch without a blow, at 0.3, 18%; lengths and win rates alike: the design's 0.6.)
 */
const CIRCLE = 0.6, CIRCLE_SWING = 0.2;
const SWING_CLOSE = 0.75, CREEP = 0.15;
/**
 * Eager: once `EAGER_S` s have gone by since it last landed or took a blow, a fighter stops side-stepping, hopping for
 * flair and dodging, and goes in to swing (no waiting beat, only a little strafe), so a duel never goes quiet. (Without
 * it 5 of 12 independent 20-bout samples, seeds 20–31, had more than 3 bouts with a 3 s stretch without a blow; with it
 * 1 of 12, and the longest stretch ≤ 4.55 s: npm run balance.)
 */
const EAGER_S = 1;
/** In reach of a foe that is not attacking either, the chance a tick that it swings now. */
const IDLE_SWING = 0.1;
/** For a stunt, in reach means closer than this × its reach (a side-step; a dodge of a foe's wind-up). */
const IN_REACH = 1.1;
/** Attacks' cool-downs are × this (a livelier back and forth). */
export const COOL_PACE = 0.75;
/** It picks a target again every `RETARGET_MIN`–`RETARGET_MAX` s, and at once when its target is launched farther than `LAUNCHED_FAR` m. */
const RETARGET_MIN = 3, RETARGET_MAX = 6, LAUNCHED_FAR = 3;
/** It looks for a stunt every `LOOK_S` s, and starts none sooner than `STUNT_GAP` s after the last one ended. */
const LOOK_S = 0.25, STUNT_GAP = 0.3;
/** A target farther than this × its reach is closed on with a leap (`LEAP_CHANCE` a look). */
const LEAP_FAR = 2.2, LEAP_CHANCE = 0.6;
/** A leap at a foe lands this × its reach short of it (so it lands in reach for its jump attack). */
const LEAP_SHORT = 0.7;
/** In reach it dashes round its target every `DASH_MIN`–`DASH_MAX` s; just out of reach it dashes in (`DASH_IN_CHANCE` a look). */
const DASH_MIN = 1.2, DASH_MAX = 2.5, DASH_IN_CHANCE = 0.4;
/**
 * A flair leap (a hop round its target, landing in reach) every `FLAIR_MIN`–`FLAIR_MAX` s. (Every 5–9 s, the last two
 * fighters spent more of their duel hopping round each other than hitting: 18% of bouts had a 3 s stretch without a
 * blow on 120 bouts of seeds 12–14 (knock 0.22), 12% at 9–14 s; leaps stay well over the 6 a minute: npm run balance.)
 */
const FLAIR_MIN = 9, FLAIR_MAX = 14;
/** A flair hop goes this far (rad) round its target. */
const FLAIR_TURN = 1.6;
/**
 * In a corner (within `edgeMargin` of the edge) with a foe inward closer than `CORNER_FOE` m: a leap over it toward the
 * middle (`CORNER_CHANCE` a look), landing `CORNER_OVER` m + half its reach past it, in at least `CORNER_T` s (high
 * enough to go over).
 */
const CORNER_FOE = 2.5, CORNER_CHANCE = 0.5, CORNER_OVER = 1.2, CORNER_T = 0.7;
/**
 * The rope spring: within `ROPE_EDGE` m of the edge with its target more than `ROPE_IN` m inward (along the line to
 * the middle), `ROPE_CHANCE` a look; then not again for `ROPE_COOL` s. (At 0.35 a look, 0.50–0.61 rope springs a
 * fighter-minute on seeds 12–16, at the design's floor of 0.5; at 0.5, 0.73–0.83: npm run balance.)
 */
const ROPE_EDGE = 3, ROPE_IN = 2.5, ROPE_CHANCE = 0.5, ROPE_COOL = 4;
/** The chance to dodge a target's wind-up in reach: small fighters (ring height under `DODGE_SMALL_H` m) dodge more. */
const DODGE_SMALL = 0.35, DODGE_BIG = 0.2, DODGE_SMALL_H = 1;
/** A dodge is followed by a leap back at the foe (a counter) once its blow has gone by, within this long (s). */
const COUNTER_S = 2;
/** A dodge hops back this far (m): `DODGE_MIN` + up to `DODGE_RANGE`. */
const DODGE_MIN = 1.5, DODGE_RANGE = 1;
/** Alone (boasting): a hop round the strut circle every `BOAST_MIN`–`BOAST_MAX` s, `BOAST_AHEAD` rad ahead; a dash `BOAST_DASH` of the time. */
const BOAST_MIN = 2, BOAST_MAX = 3.5, BOAST_AHEAD = 0.9, BOAST_DASH = 0.3;

/**
 * Grab and throw (design §4): a target within `GRAB_REACH` × its reach (and never farther than `GRAB_MAX` m), on its
 * feet, at least `GRAB_WOBBLE` wobbly, is grabbed `GRAB_CHANCE` a look (every `LOOK_S` s; its own grab's cool-down
 * over); the carry takes 2 or 3 steps. Measured on 40-bout samples (seeds 40–42; npm run balance):
 * - the design's 0.5 a look grabbed as soon as it could: 8–9 throws a bout, the blob won 0.52–0.59 and tiny 0–0.13
 *   (fair 0.25), and stretches without a blow grew (quiet > 3 s in up to 25% of bouts); 0.1 a look, 3 throws a bout,
 *   blob 0.45–0.55; 0.05, 1.8–2.3 a bout;
 * - grab range by reach alone lets the long-reach bodies grab from far off (blob 2.3 m, horns 3 m; tiny 0.6 m): the
 *   blob made 91 of 310 throws in 30 bouts (seed 43). Capped at 1.5 m: 1.2–1.7 throws a bout (the median bout 1).
 */
const GRAB_REACH = 0.9, GRAB_MAX = 1.5, GRAB_WOBBLE = 8, GRAB_CHANCE = 0.05;

/**
 * Spring pads (wild ring §5.1): with an armed pad within `PAD_SEEK` m and its target farther than `PAD_TARGET` m, it
 * walks onto the pad (`PAD_CHANCE`, rolled once for each pad it comes near, and again only once that pad has fired),
 * and leaps for nothing else on the way; it gives up after `PAD_GIVE_UP` s (something keeps it off).
 */
const PAD_SEEK = 2.5, PAD_TARGET = 3, PAD_CHANCE = 0.5, PAD_GIVE_UP = 3;
/**
 * A spring pad waits while its fighter's target is within this × the longer reach of the two (`Fighter.padJump`: it
 * fights on the pad; 1.3 → 1 in Task 8, see there), so the brain seeks a pad only for a target farther than this × its
 * own reach too. A pad it rolled for is rolled for again once it has fired, or `PAD_REROLL_S` s on (a pad re-armed by
 * Clear the ring or Again! without firing).
 */
export const PAD_DUEL = 1, PAD_REROLL_S = 6;

/** Leaps land at least this × the edge margin in from the edge (where a blow would knock it out). */
const LEAP_IN = 1;

const flat = (p: Vector3) => new Vector3(p.x, 0, p.z);
/** `p` (a ground point), pulled in to radius `lim` if it is farther out. */
const inside = (p: Vector3, lim: number) => (p.length() > lim ? p.setLength(lim) : p);

export class Brain<F extends Rival> {
  target: F | null = null;
  /** Unit, horizontal: the way it is turning to face (smoothed). */
  readonly face = new Vector3(0, 0, 1);
  readonly atk = {
    phase: 'none' as AttackPhase,
    t: 0,
    dir: new Vector3(0, 0, 1),
    side: 0,
    coolMul: 1,
    /** × this attack's power (a jump attack hits harder). */
    power: 1,
    /** Who this attack already hit (once each). */
    hit: new Set<F>(),
    /** A show-off: no hit checks. */
    harmless: false,
  };
  /** Just entered the fight: its first act is a leap at the nearest foe. */
  fresh = false;
  private retargetAt = 0;
  boastAt = 0;
  /** Which way (±1) it circles its target; turns about with every side-step. */
  private circle = 1;
  /** When (s) it may look for a stunt again, dash again, hop for flair again, rope-spring again. */
  private lookAt = 0;
  private stuntAfter = 0;
  private dashAt = 0;
  private flairAt = 0;
  private ropeAt = 0;
  /** After a dodge: the foe it dodged, to leap back at (a counter) until then (s). */
  private counter: { on: F; until: number } | null = null;
  /** Its target's current wind-up has had its dodge roll. */
  private dodgeRolled = false;
  /** When (s) it last landed or took a blow (`blow`). */
  private blowAt = 0;
  /** Where on the strut circle this fighter walks (the spike used its numeric id). */
  private readonly strutPhase: number;
  /** The spring pad it is walking onto, since when (s), and the pads it has rolled for (until each fires). */
  private pad: { at: Vector3; armed: boolean } | null = null;
  private padSince = 0;
  private readonly padRolled = new Map<{ at: Vector3; armed: boolean }, number>();

  constructor(id: string, private readonly weaponCount: number) {
    this.strutPhase = (parseInt(fnv1a(id), 16) / 0x100000000) * Math.PI * 2;
  }

  /**
   * Decide this tick: returns `want` (horizontal, length ≤ 1 before edge steering: where to walk, × walking speed)
   * and `face` (the facing the torso turns to this tick). May start an attack.
   */
  steer(pos: Vector3, t: number, live: readonly F[], boast: boolean, reach: number,
    R: number, edgeMargin: number, rng: () => number, pads?: readonly { at: Vector3; armed: boolean }[]): { want: Vector3; face: Vector3 } {
    const p = pos, fl = flat(p), r = fl.length();
    this.retarget(p, t, live, reach, rng);

    const want = new Vector3();
    let face = this.face.clone();
    if (boast || !this.target) {
      const a = t * STRUT_RATE + this.strutPhase;
      want.set(Math.sin(a) * R * STRUT_R - fl.x, 0, Math.cos(a) * R * STRUT_R - fl.z);
      if (want.lengthSq() > 0.01) face = want.clone().normalize();
      if (t > this.boastAt && this.atk.phase === 'none') {
        this.boastAt = t + 3 + rng() * 2;
        this.startAttack(r > 1e-6 ? fl.clone().negate() : this.face, rng, true); // the move, toward the ring's middle
      }
    } else {
      const to = this.target.ragdoll.pos().sub(p).setY(0);
      const dist = to.length();
      if (dist > 1e-6) face = to.clone().divideScalar(dist);
      const pad = this.seekPad(fl, t, dist, Math.max(PAD_TARGET, reach * PAD_DUEL), pads, rng);
      // onto a spring pad (it springs off it at its target)
      if (pad) want.set(pad.at.x - fl.x, 0, pad.at.z - fl.z);
      // out of its reach: straight in (circling just outside its reach, it never swung)
      else if (dist >= reach) want.copy(face);
      else {
        // in reach: circle it, holding a little inside its reach; never standing still
        const side = new Vector3(-face.z, 0, face.x).multiplyScalar(this.circle);
        // circling into the edge: turn about
        if (r > R - edgeMargin && side.dot(fl) > 0) { this.circle = -this.circle; side.negate(); }
        const swinging = this.atk.phase === 'windup' || this.atk.phase === 'strike';
        // in at it as the spike did (full speed, then creeping once close), and round it: strafing at `CIRCLE` × its
        // speed between blows, a little while it swings (a blow thrown while circling hard misses)
        want.copy(face).multiplyScalar(dist > reach * SWING_CLOSE ? 1 : CREEP).addScaledVector(side, CIRCLE * (swinging || t - this.blowAt > EAGER_S ? CIRCLE_SWING : 1));
      }
      // a flier is out of reach until it comes down: wait for it rather than swing under it
      // (two foes both idle do not swing on the same tick: each waits a random beat, `IDLE_SWING` a tick, so their
      // rhythms do not lock together — a hop and a charge in step went under and over each other for seconds)
      const both = this.target.attack === 'none' && rng() >= IDLE_SWING && t - this.blowAt <= EAGER_S;
      if (dist < reach && this.atk.phase === 'none' && !this.target.flying && !both) this.startAttack(face, rng, false);
      // a wind-up follows its target round (it is circling): the blow goes where the target is
      else if (this.atk.phase === 'windup' && !this.atk.harmless && dist > 1e-6) this.atk.dir.copy(face);
    }
    if (want.lengthSq() > 1) want.normalize();
    // don't wander off the edge on purpose
    const edge = R - edgeMargin;
    if (r > edge) want.add(fl.clone().normalize().multiplyScalar(-(r - edge) * EDGE_PUSH));
    this.face.lerp(face, TURN).setY(0).normalize();
    return { want, face };
  }

  /**
   * The spring pad it walks onto now, or null: kept while it stays armed and its target farther than `far` m (`PAD_TARGET`,
   * or `PAD_DUEL` × its reach if more)
   * (for at most `PAD_GIVE_UP` s); else the nearest armed pad within `PAD_SEEK` m it has not rolled for yet,
   * `PAD_CHANCE` of the time.
   */
  private seekPad(p: Vector3, t: number, dist: number, far: number, pads: readonly { at: Vector3; armed: boolean }[] | undefined,
    rng: () => number) {
    // (no pads seen, a fighter in danger: whatever pad it was walking to is forgotten, so its stunts come back)
    if (!pads) { this.pad = null; return null; }
    if (this.pad && (!this.pad.armed || dist <= far || t - this.padSince > PAD_GIVE_UP)) this.pad = null;
    for (const [pad, at] of this.padRolled) if (!pad.armed || t - at > PAD_REROLL_S) this.padRolled.delete(pad);
    if (this.pad || dist <= far) return this.pad;
    let best: { at: Vector3; armed: boolean } | null = null, bd = PAD_SEEK;
    for (const pad of pads) {
      const d = Math.hypot(pad.at.x - p.x, pad.at.z - p.z);
      if (pad.armed && d < bd && !this.padRolled.has(pad)) { bd = d; best = pad; }
    }
    if (!best) return null;
    this.padRolled.set(best, t);
    if (rng() < PAD_CHANCE) { this.pad = best; this.padSince = t; }
    return this.pad;
  }

  /** A target, kept for a few seconds: dropped for another at once when it is launched far off. */
  private retarget(p: Vector3, t: number, live: readonly F[], reach: number, rng: () => number): void {
    const tg = this.target;
    // (a target out of the fight may have no body left to look at)
    const far = !!tg && tg.state === 'fighting' && tg.flying === true && tg.ragdoll.pos().distanceTo(p) > Math.max(LAUNCHED_FAR, reach * 1.5);
    // (a target held over someone's head is out of the fight until it is thrown)
    if (tg && tg.state === 'fighting' && !tg.held && t <= this.retargetAt && !far) return;
    let best: F | null = null, bd = Infinity;
    for (const o of live) {
      // a launched target is dropped for someone else, if there is anyone
      if (far && o === tg && live.length > 1) continue;
      if (o.held) continue;
      const d = o.ragdoll.pos().distanceTo(p) * (0.7 + rng() * 0.6);
      if (d < bd) { bd = d; best = o; }
    }
    this.target = best;
    this.retargetAt = t + RETARGET_MIN + rng() * (RETARGET_MAX - RETARGET_MIN);
  }

  /**
   * The stunt to do now, or null (design §3). `free`: whether its fighter may start one (steady, not attacking, …);
   * the dodge's once-per-wind-up roll is kept even when it may not. Its first act after its entrance is a leap at the
   * nearest foe (unless that foe is in reach already); a wind-up of its target in reach may be dodged; in a corner it leaps over its foe; near the edge it may
   * spring off the ropes; a far target is closed on with a leap, a near one with a dash; in reach it side-steps round
   * its target; now and then it hops round it for flair. Alone it hops and dashes round the ring.
   */
  pickStunt(pos: Vector3, t: number, live: readonly F[], boast: boolean, me: Self, R: number, edgeMargin: number,
    rng: () => number, free: boolean): StuntOrder<F> | null {
    // (its target may have gone out since it last steered: a fighter let go has no body to look at)
    this.retarget(pos, t, live, me.reach, rng);
    const tg = boast ? null : this.target;
    if (!tg || tg.attack !== 'windup') this.dodgeRolled = false;
    if (!free || t < this.stuntAfter) return null;
    const p = flat(pos), r = p.length();

    if (this.fresh) {
      this.fresh = false;
      let near: F | null = null, nd = Infinity;
      if (!boast) for (const o of live) {
        const d = flat(o.ragdoll.pos()).distanceTo(p);
        if (d < nd && !o.flying) { nd = d; near = o; }
      }
      // (already in reach of it, it simply fights)
      if (near && nd > me.reach) {
        this.target = near;
        return { name: 'leap', to: this.short(p, flat(near.ragdoll.pos()), me.reach, R, edgeMargin), foe: near };
      }
    }

    if (tg && !tg.flying) {
      const q = flat(tg.ragdoll.pos()), d = q.distanceTo(p);
      // a dodge: once per wind-up of its target, when that wind-up can reach it
      if (tg.attack === 'windup' && !this.dodgeRolled && d < (tg.reach ?? me.reach) * IN_REACH) {
        this.dodgeRolled = true;
        if (rng() < (me.ringHeight < DODGE_SMALL_H ? DODGE_SMALL : DODGE_BIG) && t - this.blowAt <= EAGER_S) {
          this.counter = { on: tg, until: t + COUNTER_S };
          return { name: 'dodge', from: tg, dist: DODGE_MIN + rng() * DODGE_RANGE };
        }
      }
      // dodged: once the blow has gone by, straight back in with a jump attack
      const ct = this.counter;
      if (ct && (ct.on !== tg || t > ct.until)) this.counter = null;
      else if (ct && tg.attack !== 'windup' && tg.attack !== 'strike' && d > me.reach) {
        this.counter = null;
        return { name: 'leap', to: this.short(p, q, me.reach, R, edgeMargin), foe: tg };
      }
    }

    if (t < this.lookAt) return null;
    this.lookAt = t + LOOK_S;
    // on its way onto a spring pad: no leap or dash takes it elsewhere
    if (this.pad && !boast) return null;

    if (!tg) return boast || !live.length ? this.boastStunt(p, t, R, rng) : null;
    if (tg.flying || tg.held) return null;
    const q = flat(tg.ragdoll.pos()), to = q.clone().sub(p), d = to.length();
    const inward = r > 1e-6 ? -to.dot(p) / r : 0;

    // a wobbly target close by, on its feet: grab it (lifted overhead, carried to the edge, thrown)
    if (me.grab && tg.grabbable && (tg.wobble ?? 0) >= GRAB_WOBBLE && d < Math.min(GRAB_REACH * me.reach, GRAB_MAX) && rng() < GRAB_CHANCE) {
      return { name: 'grab', foe: tg, steps: rng() < 0.5 ? 2 : 3 };
    }

    // cornered: over the foe toward the middle
    if (r > R - edgeMargin && d < CORNER_FOE && inward > 0 && rng() < CORNER_CHANCE) {
      const spot = d > 1e-6 ? q.clone().addScaledVector(to, (CORNER_OVER + me.reach * 0.5) / d) : q.clone().multiplyScalar(0.5);
      return { name: 'leap', to: inside(spot, R - edgeMargin), foe: tg, T: CORNER_T };
    }
    // near the ropes, its target well inward: spring off them at it
    if (r > R - ROPE_EDGE && inward > ROPE_IN && t > this.ropeAt && rng() < ROPE_CHANCE) {
      this.ropeAt = t + ROPE_COOL;
      return { name: 'ropeSpring', foe: tg };
    }
    // far off: a leap at it
    if (d > LEAP_FAR * me.reach) return rng() < LEAP_CHANCE ? { name: 'leap', to: this.short(p, q, me.reach, R, edgeMargin), foe: tg } : null;
    // in reach: a side-step round it, while its target is not swinging (a dodge is the answer to a swing; a side-step
    // through every blow left two fighters missing each other for seconds)
    const open = tg.attack !== 'windup' && tg.attack !== 'strike', eager = t - this.blowAt > EAGER_S;
    if (d <= me.reach * IN_REACH) {
      if (t > this.dashAt && open && !eager) {
        this.dashAt = t + DASH_MIN + rng() * (DASH_MAX - DASH_MIN);
        this.circle = -this.circle;
        return { name: 'dash', dir: new Vector3(-to.z, 0, to.x).multiplyScalar(this.circle), foe: tg, side: this.circle };
      }
    } else if (t > this.dashAt && rng() < DASH_IN_CHANCE) {
      // just out of reach: a dash in
      this.dashAt = t + DASH_MIN + rng() * (DASH_MAX - DASH_MIN);
      return { name: 'dash', dir: to, foe: tg, side: 0 };
    }
    // now and then, a hop round it for flair (landing in reach: a jump attack)
    if (t > this.flairAt && !eager) {
      this.flairAt = t + FLAIR_MIN + rng() * (FLAIR_MAX - FLAIR_MIN);
      const back = d > 1e-6 ? p.clone().sub(q).divideScalar(d) : new Vector3(1, 0, 0);
      const turn = (rng() < 0.5 ? -1 : 1) * FLAIR_TURN, c = Math.cos(turn), s = Math.sin(turn);
      const spot = q.clone().add(new Vector3(back.x * c - back.z * s, 0, back.x * s + back.z * c).multiplyScalar(me.reach * LEAP_SHORT));
      return { name: 'leap', to: inside(spot, R - edgeMargin * LEAP_IN), foe: tg };
    }
    return null;
  }

  /** It landed or took a blow at `t`. */
  blow(t: number): void {
    this.blowAt = t;
  }

  /** Its first tick fighting at `t`: a breath before its first strut or boast hop. */
  breath(t: number): void {
    this.blowAt = t;
    this.boastAt = t + BREATH_S;
    this.flairAt = Math.max(this.flairAt, t + BREATH_S);
  }

  /** A stunt ended at `t`: the next may start `STUNT_GAP` s on. */
  stuntOver(t: number): void {
    this.stuntAfter = t + STUNT_GAP;
  }

  /**
   * The ground point `LEAP_SHORT` × reach short of `q`, coming from `p` (where it is when nearer than that), kept
   * `LEAP_IN` × the edge margin in from the edge (`R`).
   */
  private short(p: Vector3, q: Vector3, reach: number, R: number, edgeMargin: number): Vector3 {
    const back = p.clone().sub(q);
    const d = back.length(), keep = Math.min(d, reach * LEAP_SHORT);
    const spot = d > 1e-6 ? q.clone().addScaledVector(back, keep / d) : q.clone();
    return inside(spot, R - edgeMargin * LEAP_IN);
  }

  /** Alone: a hop ahead round the strut circle, or now and then a dash along it. */
  private boastStunt(p: Vector3, t: number, R: number, rng: () => number): StuntOrder<F> | null {
    if (t < this.flairAt) return null;
    this.flairAt = t + BOAST_MIN + rng() * (BOAST_MAX - BOAST_MIN);
    const a = t * STRUT_RATE + this.strutPhase + BOAST_AHEAD;
    const spot = new Vector3(Math.sin(a) * R * STRUT_R, 0, Math.cos(a) * R * STRUT_R);
    if (rng() < BOAST_DASH) return { name: 'dash', dir: spot.clone().sub(p), side: 0 };
    return { name: 'leap', to: spot };
  }

  /** Begin a wind-up toward `dir` with the next weapon in turn. */
  startAttack(dir: Vector3, rng: () => number, harmless: boolean): void {
    const a = this.atk;
    a.phase = 'windup';
    a.t = 0;
    a.side = (a.side + 1) % this.weaponCount;
    a.coolMul = (0.7 + rng() * 0.6) * COOL_PACE;
    a.power = 1;
    a.harmless = harmless;
    a.dir.copy(dir).setY(0).normalize();
    a.hit.clear();
  }

  /** Knocked: the attack is lost, straight to cool-down. */
  interrupt(): void {
    this.atk.phase = 'cool';
    this.atk.t = 0;
  }

  /**
   * Advance the attack's clock, as the spike: `windup` while pulling back (and `burst` on the tick the strike window
   * opens: do the strike's push), `strike` on every tick of the strike window (check hits).
   */
  tick(dt: number, str: number, timing: readonly [number, number, number]): { windup: boolean; burst: boolean; strike: boolean } {
    const a = this.atk;
    const out = { windup: false, burst: false, strike: false };
    a.t += dt;
    if (a.phase === 'windup') {
      if (str < 0.3) this.interrupt();
      else {
        out.windup = true;
        if (a.t > timing[0]) { a.phase = 'strike'; a.t = 0; out.burst = true; }
      }
    } else if (a.phase === 'strike') {
      out.strike = true;
      if (a.t > timing[1]) { a.phase = 'cool'; a.t = 0; }
    } else if (a.phase === 'cool' && a.t > timing[2] * a.coolMul) a.phase = 'none';
    return out;
  }
}
