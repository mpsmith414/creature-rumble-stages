import { Quaternion, Vector3 } from 'three/webgpu';
import type { RagdollLayout } from '../physics/layout';
import type { Ragdoll } from '../physics/ragdoll';
import type { Fighter, Hit } from './fighter';
import type { Muscles } from './muscles';
import { MOVE_POWER, type Tune } from './tune';
import type { Move } from './types';

/**
 * Stunts (design 2026-11-14 §3): the scripted moves that make a fighter jump around the ring — leap, dash, dodge,
 * rope spring, air chase, grab and throw, and the pad jump (a spring pad fires it). A stunt owns its fighter while it runs, as a
 * special does: the brain does not steer, the attack clock only cools down, and a hit that pops or launches the
 * fighter ends it. Every move of the whole body is a velocity set on every piece at once (`setComVel`), so it flies true
 * and its limbs keep their own swing.
 */

export type StuntName = 'leap' | 'dash' | 'dodge' | 'ropeSpring' | 'airChase' | 'padJump' | 'grab' | 'throw';
/**
 * For the show and the camera: a stunt began (`start`, from where it took off), landed (`land`: a leap's or a chase's
 * touch-down; a rope spring's touch on the bumper, where it springs off) or is over (`end`, every stunt, also when cut
 * short). `other` is who it is aimed at, when it is aimed at someone.
 */
export type StuntCue = { id: string; stunt: StuntName; phase: 'start' | 'land' | 'end'; at: Vector3; other?: string };

/** What a fighter is told to do (by its brain, or by a test). `F` is the fighter type (the brain is generic). */
export type StuntOrder<F = Fighter> =
  /** A jump to the ground point `to`; with `foe`, a jump attack if it lands in reach. `T` overrides the flight time. */
  | { name: 'leap'; to: Vector3; foe?: F | null; T?: number }
  /** A ground burst along `dir`; with `foe` and `side` ±1, a side-step round the foe (0: straight in at it). */
  | { name: 'dash'; dir: Vector3; foe?: F | null; side?: number }
  /** A hop back `dist` m from `from` (its attack is winding up). */
  | { name: 'dodge'; from: F; dist: number }
  /** Onto the bumper's top and springing off it at `foe`. */
  | { name: 'ropeSpring'; foe: F }
  /** A leap after `foe`, flying, to strike it again in the air. */
  | { name: 'airChase'; foe: F }
  /** A grab of `foe`: lifted overhead, carried `steps` steps toward the nearest edge and thrown (design §4). */
  | { name: 'grab'; foe: F; steps?: number };

/** A leap's flight time: `dist / LEAP_PACE` s, kept in [LEAP_MIN_T, LEAP_MAX_T]. */
export const LEAP_PACE = 7, LEAP_MIN_T = 0.45, LEAP_MAX_T = 0.95;
/** A leap that lands within reach of its foe strikes at once with this × the move's power (a jump attack). */
export const JUMP_ATTACK = 1.3;
/** A dash runs at this × the fighter's walking speed for `DASH_S` s. */
export const DASH_SPEED = 2.4, DASH_S = 0.3;
/** A dodge is a small leap of `DODGE_T` s, back `DODGE_MIN`–`DODGE_MAX` m. */
export const DODGE_T = 0.3, DODGE_MIN = 1.5, DODGE_MAX = 2.5;
/**
 * The rope spring: off the bumper's top at up to `SPRING_OUT` m/s level (less when its foe is nearer: it comes down on
 * it, not over it) and `SPRING_UP` m/s up, a flying body attack (torso and head, radius × `SPRING_R`) of power
 * `SPRING_POWER` × `knock`.
 */
export const SPRING_OUT = 9, SPRING_UP = 6, SPRING_POWER = 2.4, SPRING_R = 1.2;
/**
 * The air chase: an air hit's `up` is × `CHASE_UP` (nobody is juggled to the roof) and its `out` × `CHASE_OUT` (a
 * flier struck again is not sent straight out of the ring: tuned with npm run balance); at most `CHASES_PER_FLIGHT`
 * per flight.
 */
export const CHASE_UP = 0.6, CHASE_OUT = 0.6, CHASES_PER_FLIGHT = 2;
/** An air chase's flight time to its flier: `dist / CHASE_PACE` s in [CHASE_MIN_T, CHASE_MAX_T]; its speed's limits (m/s). */
const CHASE_PACE = 8, CHASE_MIN_T = 0.3, CHASE_MAX_T = 0.6, CHASE_MAX_V = 11, CHASE_MAX_UP = 11;
/** Once it has struck (or missed) an air chase keeps this share of its level speed. */
const CHASE_DROP = 0.25;
/** An air chase strikes with its weapons and its torso, each × this radius. */
const CHASE_R = 1.2;
/** A side-step keeps at least this far (m) between its torso's side and its foe's. */
const DASH_CLEAR = 0.25;
/** Where on the bumper's top a rope spring lands (m out from the ring's edge: the bumper's inner half). */
const BUMPER_SPOT = 0.05;
/** A leap lands at least this far (m) in from the ring's edge. */
export const LEAP_EDGE = 1;
/** A leap steers to its landing spot (an ever smaller correction) until this long (s) before it lands. */
const HOME_UNTIL = 0.08;
/** A leap's steering is held under this × its first level speed (plus 1 m/s): a bump in the air is not undone at once. */
const HOME_MAX = 1.3;
/** On landing a leap keeps this share of its level speed (it sticks the landing). */
const STICK = 0.15;
/** A stunt in the air is down once its torso falls back to this × its stand height over the ground under it. */
const DOWN_AT = 1.05;
/** Whatever happens, an airborne stunt is over this long (s) after it should have landed. */
const LATE_S = 0.6;
/** A chase or a rope spring's flight is over after this long (s), whatever happens. */
const FLIGHT_MAX_S = 2;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** A leap's flight time for a jump of `dist` m. */
export const leapTime = (dist: number) => clamp(dist / LEAP_PACE, LEAP_MIN_T, LEAP_MAX_T);

/** What a stunt drives: its fighter's body and muscles, and how it lands blows. */
export interface StuntBody {
  readonly id: string;
  readonly ragdoll: Ragdoll;
  readonly muscles: Muscles;
  readonly layout: RagdollLayout;
  readonly tune: Tune;
  readonly reach: number;
  readonly move: Move;
  /** Lands a stunt's blow on `o` at `at`: a normal hit of `power` (its launch's parts × `how`), counted as this fighter's. */
  hit(o: Fighter, at: Vector3, power: number, how: { up?: number; out?: number }): Hit | null;
  /** Whether this body touches `o`: its torso and head (and, with `weapons`, its weapons), each radius × `scale`. */
  touches(o: Fighter, weapons: boolean, scale: number): boolean;
  /** The fighter itself (a grab holds its foe: `o.heldBy === me.self`). */
  readonly self: Fighter;
  /** Throws `o`, which it holds, along `dir` (level unit, at most `maxOut` m/s): a hit of `power`, counted as this fighter's. */
  throwHit(o: Fighter, dir: Vector3, power: number, maxOut?: number): Hit | null;
  /**
   * √ the ring's gravity scale (Moon Jump): a jump's fixed speed up (a pad jump's, a rope spring's) is × this and a
   * leap's flight time ÷ this, so under Moon Jump's gravity it goes as high as ever, only floatier (`Fighter`).
   */
  readonly carry: number;
}

/** One tick of a stunt: its fighter, the foes it may hit, where its hits and cues go. */
export type StuntTickCtx = {
  dt: number;
  me: StuntBody;
  foes: readonly Fighter[];
  hits: Hit[];
  cue(phase: 'start' | 'land', at: Vector3, other?: Fighter | null): void;
};

/** Scratch (stunts allocate little per tick). */
const _v = new Vector3(), _p = new Vector3(), _f = new Vector3();

/** The whole body's velocity (mass-weighted), into `out`. */
export function comVel(rag: Ragdoll, out: Vector3): Vector3 {
  out.set(0, 0, 0);
  let m = 0;
  for (const p of rag.pieces) {
    const v = p.body.linvel();
    out.x += v.x * p.mass; out.y += v.y * p.mass; out.z += v.z * p.mass;
    m += p.mass;
  }
  return m > 0 ? out.divideScalar(m) : out;
}

/**
 * The whole body moves at (`x`, `y`, `z`) m/s: the same change goes on every piece, so its limbs keep their own swing
 * about it. `y` null keeps its up/down speed.
 */
export function setComVel(rag: Ragdoll, x: number, y: number | null, z: number): void {
  const c = comVel(rag, _v);
  const dx = x - c.x, dy = y === null ? 0 : y - c.y, dz = z - c.z;
  for (const p of rag.pieces) {
    const v = p.body.linvel();
    p.body.setLinvel({ x: v.x + dx, y: v.y + dy, z: v.z + dz }, true);
  }
}

/**
 * A running stunt. `t` counts from its start. The fighter calls `begin` once, then `tick` every physics step until it
 * returns true (then sends `end`). `attackOn` is set when it ends with a jump attack due on that foe.
 */
export abstract class StuntRun {
  t = 0;
  done = false;
  attackOn: Fighter | null = null;
  constructor(readonly name: StuntName, readonly foe: Fighter | null) {}
  /** A stunt that runs straight on into another when it is over (a grab into its throw); the fighter starts it. */
  next: StuntRun | null = null;
  abstract begin(c: StuntTickCtx): void;
  protected abstract step(c: StuntTickCtx): void;
  /** It is ended before it is over (a hit, a crowning, out of the ring): whatever it holds is let go. */
  cut(_me: StuntBody): void {}
  tick(c: StuntTickCtx): boolean {
    this.t += c.dt;
    this.step(c);
    return this.done;
  }
}

/** In the air under its own control: legs held in full, upright, turned to `face`, limbs braced. */
function airPose(c: StuntTickCtx, face: Vector3): void {
  const m = c.me.muscles;
  m.offFeet();
  m.stand(c.dt, 1, face, c.me.tune.gravity);
  m.brace(c.dt, 1, null, c.me.tune);
}

/** The level unit vector from `a` to `b` into `out` (`fallback` when they stand on top of each other). */
function towards(a: Vector3, b: Vector3, out: Vector3, fallback: Vector3): Vector3 {
  out.set(b.x - a.x, 0, b.z - a.z);
  const d = out.length();
  return d > 1e-6 ? out.divideScalar(d) : out.copy(fallback);
}

/**
 * A ballistic jump of the whole body from where it is to the ground point `to` (its torso coming down to its stand
 * height over `groundY`), in `T` s: up `(Δy)/T + g·T/2`, across `dist / T`. While it flies it steers gently onto its
 * spot (damping and bumps), braced and upright, facing where it lands (or its foe). Shared by the leap, the dodge and
 * the rope spring's way up.
 */
class Jump {
  readonly to = new Vector3();
  T = 0;
  private level = 0;
  constructor(to: Vector3, private readonly groundY: number) { this.to.copy(to); }
  launch(me: StuntBody, T: number): void {
    const p = me.ragdoll.pos(), g = me.tune.gravity;
    this.T = T;
    const y1 = this.groundY + me.layout.standHeight;
    const vy = (y1 - p.y) / T + (g * T) / 2;
    const vx = (this.to.x - p.x) / T, vz = (this.to.z - p.z) / T;
    this.level = Math.hypot(vx, vz);
    setComVel(me.ragdoll, vx, vy, vz);
  }
  /** One tick at `t` s into the jump; true once it is down. */
  fly(c: StuntTickCtx, t: number, face: Vector3): boolean {
    const me = c.me, p = me.ragdoll.pos(), v = comVel(me.ragdoll, _p);
    const left = this.T - t;
    if (left > HOME_UNTIL) {
      let vx = (this.to.x - p.x) / left, vz = (this.to.z - p.z) / left;
      const sp = Math.hypot(vx, vz), cap = this.level * HOME_MAX + 1;
      if (sp > cap) { vx *= cap / sp; vz *= cap / sp; }
      setComVel(me.ragdoll, vx, null, vz);
    }
    airPose(c, face);
    const down = t >= this.T * 0.5 && v.y <= 0 && p.y <= this.groundY + me.layout.standHeight * DOWN_AT;
    return down || t > this.T + LATE_S;
  }
}

/** A leap (to a ground point; with a foe, a jump attack if it lands in reach), or a dodge (a small leap back). */
export class Leap extends StuntRun {
  private readonly jump: Jump;
  private readonly fixedT: number | undefined;
  private readonly face = new Vector3(0, 0, 1);
  constructor(name: 'leap' | 'dodge', to: Vector3, foe: Fighter | null, T?: number) {
    super(name, foe);
    this.jump = new Jump(new Vector3(to.x, 0, to.z), 0);
    this.fixedT = T;
  }
  /** Where it lands (ground point). */
  get to(): Vector3 { return this.jump.to; }
  begin(c: StuntTickCtx): void {
    const p = c.me.ragdoll.pos(), to = this.jump.to, lim = c.me.tune.ringRadius - LEAP_EDGE;
    // a leap never lands out of the ring, whatever it was aimed at
    if (Math.hypot(to.x, to.z) > lim) to.setLength(lim);
    const d = Math.hypot(to.x - p.x, to.z - p.z);
    // a dodge keeps its eyes on whoever it dodged; a leap looks where it lands
    if (this.name === 'dodge' && this.foe?.ragdoll.pieces.length) towards(p, this.foe.ragdoll.pos(), this.face, c.me.muscles.facing());
    else towards(p, this.jump.to, this.face, c.me.muscles.facing());
    // (in Moon Jump, as high as ever and slower: `carry`)
    this.jump.launch(c.me, (this.fixedT ?? leapTime(d)) / c.me.carry);
    c.cue('start', p, this.foe);
  }
  protected step(c: StuntTickCtx): void {
    if (!this.jump.fly(c, this.t, this.face)) return;
    const me = c.me, p = me.ragdoll.pos(), v = comVel(me.ragdoll, _v);
    setComVel(me.ragdoll, v.x * STICK, null, v.z * STICK);
    c.cue('land', p, this.foe);
    const o = this.foe;
    if (this.name === 'leap' && o && o.state === 'fighting' && o.ragdoll.pieces.length && !o.flying) {
      const q = o.ragdoll.pos();
      if (Math.hypot(q.x - p.x, q.z - p.z) < me.reach) this.attackOn = o;
    }
    this.done = true;
  }
}

/** A ground burst: straight along `dir` (or in at its foe), or a side-step round its foe, at `DASH_SPEED` × its speed. */
export class Dash extends StuntRun {
  private readonly dir = new Vector3();
  /** The distance (m) it keeps from its foe while it side-steps round it. */
  private hold = 0;
  constructor(dir: Vector3, foe: Fighter | null, private readonly side: number) {
    super('dash', foe);
    this.dir.set(dir.x, 0, dir.z);
    if (this.dir.lengthSq() < 1e-9) this.dir.set(0, 0, 1);
    this.dir.normalize();
  }
  begin(c: StuntTickCtx): void {
    const p = c.me.ragdoll.pos();
    if (this.foe && this.side !== 0) {
      const q = this.foe.ragdoll.pos();
      // (never closer than their bodies' sides: a small fighter whirling under a big one would toss it up)
      const touch = c.me.ragdoll.torso.seg.radius + this.foe.ragdoll.torso.seg.radius + DASH_CLEAR;
      this.hold = Math.max(Math.hypot(p.x - q.x, p.z - q.z), 0.6 * c.me.reach, touch);
    }
    c.cue('start', p, this.foe);
  }
  protected step(c: StuntTickCtx): void {
    const me = c.me, m = me.muscles, g = me.tune.gravity, R = me.tune.ringRadius, p = me.ragdoll.pos();
    const o = this.foe && this.foe.ragdoll.pieces.length && this.foe.state === 'fighting' ? this.foe : null;
    const face = _f.copy(this.dir);
    if (o) {
      const q = o.ragdoll.pos();
      towards(p, q, face, this.dir);
      if (this.side !== 0) {
        // round the foe: along the circle it stands on, pulled back onto it
        const r = Math.hypot(p.x - q.x, p.z - q.z);
        this.dir.set(-face.z * this.side, 0, face.x * this.side).addScaledVector(face, clamp((r - this.hold) * 2, -1, 1)).normalize();
      } else {
        this.dir.copy(face);
        if (Math.hypot(p.x - q.x, p.z - q.z) < me.reach * 0.7) this.done = true; // in: done
      }
    }
    // never dash out toward the edge (past where the brain steers back from it)
    const r = Math.hypot(p.x, p.z);
    if (r > R - me.tune.edgeMargin && (p.x * this.dir.x + p.z * this.dir.z) > 0) this.done = true;
    const sp = (this.done || this.t >= DASH_S ? 1 : DASH_SPEED) * m.speed;
    setComVel(me.ragdoll, this.dir.x * sp, null, this.dir.z * sp);
    if (this.t >= DASH_S) this.done = true;
    if (m.grounded(R)) m.hover(c.dt, 1, null, g);
    m.stand(c.dt, 1, face, g);
    m.waddle(c.dt, 1, face, m.grounded(R));
    m.brace(c.dt, 1, null, me.tune);
  }
}

/**
 * The rope spring: a leap onto the bumper's top (the spot on it nearest the fighter), and on touching down there a
 * spring off it at its foe: a flying body attack (torso and head) that lasts until it lands.
 */
export class RopeSpring extends StuntRun {
  private jump: Jump | null = null;
  private sprung = -1;
  private readonly face = new Vector3();
  constructor(foe: Fighter) { super('ropeSpring', foe); }
  begin(c: StuntTickCtx): void {
    const me = c.me, p = me.ragdoll.pos(), R = me.tune.ringRadius;
    const out = towards(_v.set(0, 0, 0), p, _p, me.muscles.facing().negate());
    const spot = out.clone().multiplyScalar(R + BUMPER_SPOT);
    this.jump = new Jump(spot, me.tune.bumper);
    this.jump.launch(me, leapTime(Math.hypot(spot.x - p.x, spot.z - p.z)));
    if (this.foe?.ragdoll.pieces.length) towards(p, this.foe.ragdoll.pos(), this.face, out);
    else this.face.copy(out).negate();
    c.cue('start', p, this.foe);
  }
  protected step(c: StuntTickCtx): void {
    const me = c.me, g = me.tune.gravity, p = me.ragdoll.pos();
    if (this.sprung < 0) {
      if (this.jump!.fly(c, this.t, this.face)) this.spring(c, p, g);
      return;
    }
    airPose(c, this.face);
    const ft = this.t - this.sprung;
    const knock = me.tune.knock;
    for (const o of c.foes) {
      if (this.struck.has(o) || o.state !== 'fighting' || !o.ragdoll.pieces.length || !me.touches(o, false, SPRING_R)) continue;
      const h = me.hit(o, o.ragdoll.pos(), SPRING_POWER * knock, {});
      this.struck.add(o);
      if (h) c.hits.push(h);
    }
    const v = comVel(me.ragdoll, _v), inside = Math.hypot(p.x, p.z) < me.tune.ringRadius;
    if ((ft > 0.2 && v.y <= 0 && inside && p.y <= me.layout.standHeight * DOWN_AT) || ft > FLIGHT_MAX_S) {
      setComVel(me.ragdoll, v.x * 0.3, null, v.z * 0.3);
      this.done = true;
    }
  }
  /** Who the flying body already struck (once each). */
  private readonly struck = new Set<Fighter>();
  /** Off the bumper at its foe (or the ring's middle): level fast enough to come down on it, at most `SPRING_OUT`. */
  private spring(c: StuntTickCtx, p: Vector3, g: number): void {
    const me = c.me, o = this.foe && this.foe.ragdoll.pieces.length && this.foe.state === 'fighting' ? this.foe : null;
    const aim = o ? o.ragdoll.pos() : _f.set(0, me.layout.standHeight, 0);
    const dir = towards(p, aim, this.face, _v.set(-p.x, 0, -p.z).normalize());
    const d = Math.hypot(aim.x - p.x, aim.z - p.z);
    // when its torso comes back down to the height of the foe's: up SPRING_UP, falling under g
    const dy = p.y - aim.y;
    const up = SPRING_UP * me.carry;
    const tDown = (up + Math.sqrt(up * up + 2 * g * Math.max(0, dy))) / g;
    const level = Math.min(SPRING_OUT, d / tDown);
    setComVel(me.ragdoll, dir.x * level, up, dir.z * level);
    this.sprung = this.t;
    c.cue('land', p, o);
  }
}

/** The air chase: a leap after a flier (where it will be), striking it once in the air with its weapons or its body. */
export class AirChase extends StuntRun {
  private T = 0;
  private struckIt = false;
  private dropping = false;
  private readonly face = new Vector3();
  constructor(foe: Fighter) { super('airChase', foe); }
  begin(c: StuntTickCtx): void {
    const me = c.me, o = this.foe!, g = me.tune.gravity, p = me.ragdoll.pos();
    const q = o.ragdoll.pos(), qv = comVel(o.ragdoll, _p);
    this.T = clamp(Math.hypot(q.x - p.x, q.z - p.z) / CHASE_PACE, CHASE_MIN_T, CHASE_MAX_T);
    const T = this.T;
    // where the flier will be in T s (it falls; never under its own stand height)
    const aim = new Vector3(q.x + qv.x * T, Math.max(o.layout.standHeight, q.y + qv.y * T - (g * T * T) / 2), q.z + qv.z * T);
    // never out over the edge after it
    const lim = me.tune.ringRadius - LEAP_EDGE, ar = Math.hypot(aim.x, aim.z);
    if (ar > lim) { aim.x *= lim / ar; aim.z *= lim / ar; }
    let vx = (aim.x - p.x) / T, vz = (aim.z - p.z) / T;
    const sp = Math.hypot(vx, vz);
    if (sp > CHASE_MAX_V) { vx *= CHASE_MAX_V / sp; vz *= CHASE_MAX_V / sp; }
    const vy = Math.min(CHASE_MAX_UP, (aim.y - p.y) / T + (g * T) / 2);
    setComVel(me.ragdoll, vx, vy, vz);
    towards(p, aim, this.face, me.muscles.facing());
    c.cue('start', p, o);
  }
  protected step(c: StuntTickCtx): void {
    const me = c.me, o = this.foe!, p = me.ragdoll.pos();
    const live = o.state === 'fighting' && o.ragdoll.pieces.length > 0;
    if (live) towards(p, o.ragdoll.pos(), this.face, this.face);
    airPose(c, this.face);
    if (!this.struckIt && live && o.flying && me.touches(o, true, CHASE_R)) {
      this.struckIt = true;
      const h = me.hit(o, o.ragdoll.pos(), MOVE_POWER[me.move] * me.tune.knock, { up: CHASE_UP, out: CHASE_OUT });
      if (h) c.hits.push(h);
    }
    // struck, or past where it meant to meet the flier: it drops straight down (it does not sail on over the edge)
    if ((this.struckIt || this.t > this.T) && !this.dropping) {
      this.dropping = true;
      const v = comVel(me.ragdoll, _v);
      setComVel(me.ragdoll, v.x * CHASE_DROP, null, v.z * CHASE_DROP);
    }
    const v = comVel(me.ragdoll, _v);
    if ((this.t > 0.25 && v.y <= 0 && p.y <= me.layout.standHeight * DOWN_AT) || this.t > FLIGHT_MAX_S) {
      setComVel(me.ragdoll, v.x * 0.3, null, v.z * 0.3);
      c.cue('land', p, o);
      this.done = true;
    }
  }
}

/**
 * The pad jump (wild ring §5.1): a spring pad fires its fighter up `PAD_UP` m/s and up to `PAD_ACROSS` m/s toward its
 * foe (else the ring's middle), never so fast that it flies past the foe or lands within `LEAP_EDGE` of the edge; in
 * control in the air (braced, upright, facing it). Its landing is a stomp: every foe within `STOMP_R` m (level) of
 * where it lands takes a hit of `STOMP_POWER` × knock, by the usual grades.
 */
export const PAD_UP = 9.5, PAD_ACROSS = 4, STOMP_R = 1.3, STOMP_POWER = 2;

export class PadJump extends StuntRun {
  private readonly face = new Vector3();
  private jump: Jump | null = null;
  /** Its foe is within its reach: it comes down on it. */
  private across = false;
  constructor(foe: Fighter | null) { super('padJump', foe); }
  begin(c: StuntTickCtx): void {
    const me = c.me, p = me.ragdoll.pos(), g = me.tune.gravity, lim = me.tune.ringRadius - LEAP_EDGE;
    const o = this.foe && this.foe.state === 'fighting' && this.foe.ragdoll.pieces.length ? this.foe : null;
    const aim = o ? o.ragdoll.pos().setY(0) : new Vector3();
    if (Math.hypot(aim.x, aim.z) > lim) aim.setLength(lim);
    towards(p, aim, this.face, me.muscles.facing());
    // a flight of 2·up/g: up PAD_UP (× `carry` in Moon Jump), and across as far as PAD_ACROSS carries it, no farther than its foe. (It steers
    // onto that spot as a leap does: a foe it pushes off from at take-off does not knock it off course.)
    const up = PAD_UP * me.carry, T = (2 * up) / g;
    const reach = PAD_ACROSS * T;
    // (a foe within its reach is followed through the flight; one beyond it, not)
    this.across = !!o && level(p, aim) <= reach;
    const to = p.clone().setY(0).addScaledVector(this.face, Math.min(reach, level(p, aim)));
    if (Math.hypot(to.x, to.z) > lim) to.setLength(lim);
    this.jump = new Jump(to, 0);
    this.jump.launch(me, T);
    c.cue('start', p, o);
  }
  protected step(c: StuntTickCtx): void {
    const me = c.me, o = this.foe;
    const p = me.ragdoll.pos();
    if (o && o.state === 'fighting' && o.ragdoll.pieces.length && !o.held) {
      const q = o.ragdoll.pos();
      towards(p, q, this.face, this.face);
      // it comes down on its foe where the foe is now (a foe that moved on is followed, within the leap's steering)
      if (this.across) {
        const lim = me.tune.ringRadius - LEAP_EDGE, to = this.jump!.to.set(q.x, 0, q.z);
        if (Math.hypot(to.x, to.z) > lim) to.setLength(lim);
      }
    }
    if (!this.jump!.fly(c, this.t, this.face)) return;
    const v = comVel(me.ragdoll, _v);
    setComVel(me.ragdoll, v.x * STICK, null, v.z * STICK);
    c.cue('land', p, o);
    // the stomp
    const power = STOMP_POWER * me.tune.knock;
    for (const f of c.foes) {
      if (f.state !== 'fighting' || !f.ragdoll.pieces.length) continue;
      if (level(f.ragdoll.pos(), p) > STOMP_R) continue;
      const h = me.hit(f, f.ragdoll.pos(), power, {});
      if (h) c.hits.push(h);
    }
    this.done = true;
  }
}

/** A grab reaches in and lifts its foe overhead in `GRAB_S` s, then carries it `CARRY_S` s (`QUICK_S` for a quick throw). */
export const GRAB_S = 0.25, CARRY_S = 0.9, QUICK_S = 0.4;
/** A carry takes its steps (2–3) of `CARRY_STEP` m (× size) toward the nearest edge, none once within `edgeMargin` of it. */
export const CARRY_STEP = 0.45;
/** Another foe closer than this (m) when the carry starts: no steps, a quick throw. */
export const QUICK_FOE = 2;
/**
 * The throw (design §4): out `THROW_OUT` + `THROW_WOBBLE` × the held fighter's wobble m/s (at most `THROW_MAX`), up
 * `THROW_UP` m/s, tumbling: a big hit, of the thrower's own move's power × knock (`MOVE_POWER`; the design's flat 2.6
 * was 1.7 × the blob's soft bump, tuned down for R6, and with it the blob won 0.33–0.45 of the 210 bouts of seeds
 * 43–45; own power and the out-or-across rule below: 0.24–0.33).
 */
export const THROW_OUT = 7, THROW_WOBBLE = 0.12, THROW_MAX = 13, THROW_UP = 6.5;
/**
 * Out or across: a fighter grabbed in the edge zone (within `edgeMargin` of the edge, where fighters steer back in) is
 * carried to the ropes and thrown out over them; one grabbed further in is tossed back across the ring, back over the
 * thrower's head as it backs up to the ropes, no faster than lands it `edgeMargin` in from the far edge. Measured (npm
 * run balance; seeds 40–45, 52–54), where the design throws every grabbed fighter out:
 * - a throw from overhead always clears the bumper: every grabbed fighter went out. Grabbed from wobble 8, the first
 *   ring-out came at 25 s and the end at 46 s (seed 40; 49 s and 109 s without grabs);
 * - thrown out only once dizzy (danger ≥ 0.85, src/fight/danger.ts) fights lasted, but fighters left in the danger
 *   phase where hits carry farthest (hits on fighters at danger ≥ 0.85: 768 → 162 in 20 bouts) and the median hit's
 *   travel fell 1.33 → 1.04 m, under its 1.18 m target; and only the blob found dizzy fighters on their feet to grab
 *   (its bump staggers rather than launches): all 7 throws out in 70 bouts were the blob's, and it won 0.44;
 * - out from the edge zone, else across: 9–14% of ring-outs straight from a throw, every kind ≤ 0.34 pooled.
 */
export const throwsOut = (from: { x: number; z: number }, tune: Pick<Tune, 'ringRadius' | 'edgeMargin'>) =>
  Math.hypot(from.x, from.z) >= tune.ringRadius - tune.edgeMargin;
/** After its throw the thrower follows through, standing, this long (s). */
export const THROW_S = 0.3;
/** A bump body (the blob) throws with a belly-bounce: a hop of this (m/s) up. */
const BELLY_UP = 3;
/** The held foe lies this far (m) over the thrower's head (plus its own torso's radius), turning at `HOLD_SPIN` rad/s. */
const HOLD_GAP = 0.1, HOLD_SPIN = 1.5;
/** A thrower this near (m) the very middle carries the way it faces (any way is the nearest edge). */
const NEAR_MIDDLE = 0.3;
const X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0);
/** Lying flat: turned a quarter about x (its up along the level). */
const FLAT = new Quaternion().setFromAxisAngle(X, Math.PI / 2);
const _q = new Quaternion(), _qs = new Quaternion();

/**
 * The fastest level speed (m/s) that tosses `o` (held, about to be let go) along `dir` (level unit) to land no farther
 * than `edgeMargin` in from the far edge: its torso up `THROW_UP` and falling under gravity back to its stand height.
 */
function acrossSpeed(o: Fighter, dir: Vector3, tune: Tune): number {
  const p = o.ragdoll.pos(), L = tune.ringRadius - tune.edgeMargin, g = tune.gravity;
  const along = p.x * dir.x + p.z * dir.z, rr = p.x * p.x + p.z * p.z;
  const s = -along + Math.sqrt(Math.max(0, along * along - rr + L * L));
  const T = (THROW_UP + Math.sqrt(THROW_UP * THROW_UP + 2 * g * Math.max(0, p.y - o.layout.standHeight))) / g;
  return s / T;
}

/** The level distance (m) between two points. */
const level = (a: Vector3, b: Vector3) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * The grab (design §4): the thrower reaches in and its foe (already `heldBy` it: the fighter takes hold as the grab
 * starts) is lifted in `GRAB_S` s to lie flat over its head, turning slowly; then the carry: it turns to the nearest
 * edge and takes its steps there (none, and a quick throw, with another foe close by); then its throw (`next`). The
 * held fighter is placed every tick. The grab ends at once, nothing thrown, if the hold is broken from the other side
 * (the held fighter let go of); cut short (a hit, a crowning, out of the ring) it drops the held fighter.
 */
export class Grab extends StuntRun {
  private readonly from = new Vector3();
  private readonly fromQ = new Quaternion();
  /** Where it carries and throws (level unit), and how fast (m/s) it walks there (0: it stays). */
  private readonly dir = new Vector3();
  private walk = 0;
  /** Thrown out over the ropes (else across the ring, back over the thrower's head). */
  private out = true;
  private carryS = CARRY_S;
  private carrying = false;
  private readonly face = new Vector3();
  constructor(foe: Fighter, private readonly steps: number) { super('grab', foe); }
  begin(c: StuntTickCtx): void {
    const o = this.foe!, me = c.me, p = me.ragdoll.pos();
    this.from.copy(o.ragdoll.pos());
    const r = o.ragdoll.torso.body.rotation();
    this.fromQ.set(r.x, r.y, r.z, r.w).multiply(_q.copy(o.ragdoll.torso.restQ).invert());
    towards(p, this.from, this.face, me.muscles.facing());
    c.cue('start', p, o);
  }
  protected step(c: StuntTickCtx): void {
    const o = this.foe!, me = c.me, m = me.muscles, g = me.tune.gravity, R = me.tune.ringRadius, p = me.ragdoll.pos();
    if (o.heldBy !== me.self || !o.ragdoll.pieces.length) { this.done = true; return; }
    if (!this.carrying && this.t >= GRAB_S) this.startCarry(c, p);
    // the thrower: on its feet, turning to where it goes, stepping there (or not)
    const want = _v.set(0, 0, 0);
    if (this.carrying) {
      // (tossing it across the ring, it backs up to the ropes facing in)
      this.face.copy(this.dir);
      if (!this.out) this.face.negate();
      if (this.walk > 0 && Math.hypot(p.x, p.z) < R - me.tune.edgeMargin) want.copy(this.dir).multiplyScalar(Math.min(1, this.walk / m.speed));
    }
    const grounded = m.grounded(R);
    if (grounded) m.hover(c.dt, 1, want, g);
    m.stand(c.dt, 1, this.face, g);
    m.waddle(c.dt, 1, this.face, grounded);
    m.brace(c.dt, 1, null, me.tune);
    this.hold(me, p);
    if (this.carrying && this.t >= GRAB_S + this.carryS) {
      this.done = true;
      this.next = new Throw(o, this.out ? this.dir : this.dir.negate(), this.out);
    }
  }
  /**
   * The carry starts: which way (the nearest edge), how far (its steps, or none for a quick throw), and whether the
   * throw goes out over the ropes (a foe grabbed near them) or back across the ring.
   */
  private startCarry(c: StuntTickCtx, p: Vector3): void {
    this.carrying = true;
    this.out = throwsOut(this.from, c.me.tune);
    const r = Math.hypot(p.x, p.z);
    if (r > NEAR_MIDDLE) this.dir.set(p.x / r, 0, p.z / r);
    else this.dir.copy(c.me.muscles.facing()).setY(0).normalize();
    const quick = c.foes.some((f) => f !== this.foe && f.ragdoll.pieces.length > 0 && level(f.ragdoll.pos(), p) < QUICK_FOE);
    this.carryS = quick ? QUICK_S : CARRY_S;
    this.walk = quick ? 0 : (this.steps * CARRY_STEP * c.me.muscles.k) / CARRY_S;
  }
  /** The held fighter, lifted from where it stood to lie flat over the thrower's head (eased in over `GRAB_S`). */
  private hold(me: StuntBody, p: Vector3): void {
    const rag = this.foe!.ragdoll;
    const top = p.y - me.layout.standHeight + me.layout.ringHeight + rag.torso.seg.radius + HOLD_GAP;
    const f = me.muscles.facing();
    _qs.setFromAxisAngle(Y, Math.atan2(f.x, f.z) + Math.PI / 2 + this.t * HOLD_SPIN).multiply(FLAT);
    const k = Math.min(1, this.t / GRAB_S), s = k * k * (3 - 2 * k);
    _q.copy(this.fromQ).slerp(_qs, s);
    _p.set(p.x, top, p.z).lerp(this.from, 1 - s);
    // the creature's origin, so that its torso comes where it should
    _f.copy(rag.torso.restP).applyQuaternion(_q);
    rag.place(_p.sub(_f), _q);
  }
  cut(me: StuntBody): void {
    const o = this.foe!;
    if (o.heldBy === me.self) o.dropped();
  }
}

/**
 * The throw: the held fighter is let go, flying along `dir` (a big hit): `out` over the ropes, else across the ring, no
 * faster than lands it `edgeMargin` in from the far edge. The thrower follows through on its feet.
 */
export class Throw extends StuntRun {
  private readonly dir = new Vector3();
  constructor(foe: Fighter, dir: Vector3, private readonly out = true) {
    super('throw', foe);
    this.dir.copy(dir);
  }
  begin(c: StuntTickCtx): void {
    const o = this.foe!, me = c.me;
    c.cue('start', me.ragdoll.pos(), o);
    if (o.heldBy !== me.self) return;
    const h = me.throwHit(o, this.dir, MOVE_POWER[me.move] * me.tune.knock, this.out ? Infinity : acrossSpeed(o, this.dir, me.tune));
    if (h) c.hits.push(h);
    // the blob throws with a belly-bounce
    if (me.move === 'bump') setComVel(me.ragdoll, 0, BELLY_UP, 0);
  }
  protected step(c: StuntTickCtx): void {
    const me = c.me, m = me.muscles, g = me.tune.gravity;
    if (m.grounded(me.tune.ringRadius)) m.hover(c.dt, 1, _v.set(0, 0, 0), g);
    m.stand(c.dt, 1, this.dir, g);
    m.brace(c.dt, 1, null, me.tune);
    if (this.t >= THROW_S) this.done = true;
  }
}


/**
 * A fresh run of an order (the fighter starts it with `begin`); `at` is where the fighter is, `inside` how far out (m
 * from the middle) a dodge may land.
 */
export function stuntFor(o: StuntOrder, at: Vector3, inside: number): StuntRun {
  switch (o.name) {
    case 'leap': return new Leap('leap', o.to, o.foe ?? null, o.T);
    case 'dash': return new Dash(o.dir, o.foe ?? null, o.side ?? 0);
    case 'dodge': return new Leap('dodge', dodgeSpot(at, o.from.ragdoll.pos(), o.dist, inside), o.from, DODGE_T);
    case 'ropeSpring': return new RopeSpring(o.foe);
    case 'airChase': return new AirChase(o.foe);
    case 'grab': return new Grab(o.foe, o.steps ?? 2);
  }
}

/**
 * Where a dodge lands: `dist` m straight back from `from`; if that is farther out than `limit` (m from the middle),
 * turned sideways (whichever way stays further in), so a dodge never hops itself toward the edge.
 */
export function dodgeSpot(me: Vector3, from: Vector3, dist: number, limit: number): Vector3 {
  const back = new Vector3(me.x - from.x, 0, me.z - from.z);
  if (back.lengthSq() < 1e-6) back.set(-me.x, 0, -me.z);
  if (back.lengthSq() < 1e-6) back.set(0, 0, 1);
  back.normalize();
  let best: Vector3 | null = null, bestR = Infinity;
  for (const turn of [0, 0.6, -0.6, 1.2, -1.2, 1.57, -1.57]) {
    const c = Math.cos(turn), s = Math.sin(turn);
    const spot = new Vector3(me.x + (back.x * c - back.z * s) * dist, 0, me.z + (back.x * s + back.z * c) * dist);
    const r = Math.hypot(spot.x, spot.z);
    if (r <= limit) return spot;
    if (r < bestR) { bestR = r; best = spot; }
  }
  return best!.setLength(Math.min(bestR, limit));
}
