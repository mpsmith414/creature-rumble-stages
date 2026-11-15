import { Quaternion, Vector3 } from 'three/webgpu';
import type { RagdollLayout } from '../physics/layout';
import type { Piece, Ragdoll } from '../physics/ragdoll';
import { TUNE, speedFor, type Tune } from './tune';
import type { Move } from './types';

/**
 * A fighter's muscles: the forces that hold its ragdoll up and move it (the spike's Creature.think/upright/strike,
 * spike/creature.ts). "Gang-Beasts style": the torso hovers at its stand height on a spring and is kept upright and
 * turned by PD torques; arms, legs, wings and tails are braced (`brace`): sprung toward their pose, arms up in a guard.
 * `str` (0–1) scales everything: 0 is a full ragdoll.
 */

const UP = new Vector3(0, 1, 0);
const FORWARD = new Vector3(0, 0, 1);
const v = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z);
/** The spike's fighters were about this tall (m): its sizes and reaches are scaled by ringHeight / this. */
const SPIKE_HEIGHT = 1.4;
/** The spike's gravity (m/s²): its hops and flaps were tuned under it. */
const SPIKE_G = 20;
/** A divebomb hops forward this fast (m/s): it lands on its foe, not past it (the spike had 5). */
const DIVE_FWD = 3;

/** Hover spring (per s²) and damping (per s) holding the torso at its stand height; it carries 0.9 × the weight. */
const HOVER_K = 60, HOVER_D = 9, HOVER_CARRY = 0.9, HOVER_MAX = 4;
/** How hard it pushes toward where it wants to go (per s). */
const DRIVE = 6;
/** Upright PD gains: torso (also turns to face). */
const TORSO_KP = 45, TORSO_KD = 7, YAW_KP = 18, YAW_KD = 4;
/**
 * The neck's PD gains (per s² and per s, on the head's inertia about its joint), on top of carrying the head's weight.
 * The spike's 25 / 4 left every head hanging upside down within half a second; these let a head bob on a punch or a
 * lunge and come back up within about a fifth of a second (balanced with npm run balance: 150 let heads hang, 200
 * favoured the tail).
 */
const HEAD_KP = 300, HEAD_KD = 20;
/**
 * The brace's PD gains (an angular acceleration, per s² and per s, before × `tune.stiff` × strength): about critically
 * damped, so a knocked limb springs back within about a quarter of a second without wobbling.
 */
const BRACE_KP = 400, BRACE_KD = 34;
/** The most (rad/s) a brace may change a limb's spin in one tick: a limb flung far off its pose is swung back, not snapped. */
const BRACE_MAX_DW = 8;
/** The arms' guard: turned this far (rad) forward-up from how they hang. */
export const GUARD_TURN = (35 * Math.PI) / 180;
/** While waddling, the legs are braced at this × the gain (they swing). */
const LEG_WALK = 0.5;

/**
 * One braced piece: the turn it is held at (in the creature's rest frame), its joint (in its own frame), the weight it
 * holds up (itself and everything hanging off it) and that load's inertia about the joint.
 */
type Brace = { p: Piece; rest: Quaternion; joint: Vector3; load: Piece[]; loadMass: number; inertia: number; leg: boolean };

/** `brace`'s scratch (it allocates nothing per tick). */
const _turn = new Quaternion(), _err = new Quaternion(), _cur = new Quaternion();
const _w = new Vector3(), _dw = new Vector3(), _dv = new Vector3(), _p = new Vector3(), _com = new Vector3(), _joint = new Vector3();
const _push = new Vector3();

export const pieceLength = (p: Piece) => v(p.seg.a).distanceTo(v(p.seg.b));
/** A point given in a piece's own frame, in the world. */
export function worldPoint(p: Piece, local: Vector3): Vector3 {
  const r = p.body.rotation();
  return local.clone().applyQuaternion(new Quaternion(r.x, r.y, r.z, r.w)).add(v(p.body.translation()));
}
/** The far end (`b`) of a piece's capsule, in the world. */
export const tipOf = (p: Piece) => worldPoint(p, new Vector3(0, pieceLength(p) / 2, 0));
/** Both ends of a piece's capsule, in the world. */
export const endsOf = (p: Piece): [Vector3, Vector3] => {
  const h = pieceLength(p) / 2;
  return [worldPoint(p, new Vector3(0, -h, 0)), worldPoint(p, new Vector3(0, h, 0))];
};

/** An impulse of `dir` × `k` at the piece's centre. */
export function push(p: Piece, dir: Vector3, k: number): void {
  p.body.applyImpulse({ x: dir.x * k, y: dir.y * k, z: dir.z * k }, true);
}

export class Muscles {
  /** ringHeight / 1.4: the spike's creature scale, for its sizes, reaches and spin. */
  readonly k: number;
  readonly speed: number;
  readonly standHeight: number;
  /** One chain of pieces per leg (thigh to foot), for the waddle. */
  readonly legs: Piece[][];
  readonly wings: Piece[];
  /** The pieces the signature move hits with (the plan's weapon parts); the torso if none. */
  readonly weapons: Piece[];
  /** Each weapon's limb (`limb`), in the same order: what the brace lets go of while it swings. */
  readonly weaponLimbs: Piece[][];
  walkPhase = 0;
  /** Waddling this tick (legs swinging): the brace holds the legs at half strength. */
  private walking = false;
  /** Every braced piece (all but the torso and the head, which the neck holds). */
  private readonly braces: Brace[];
  private readonly torsoRestInv: Quaternion;
  flapCd = 0;
  /** Where the head hangs from its parent (the neck joint), in the head piece's own frame. */
  private readonly neck = new Vector3();
  /** The head and every piece hanging off it: the weight the neck holds up. */
  private readonly headLoad: Piece[];

  constructor(readonly body: Ragdoll, layout: RagdollLayout) {
    this.k = layout.ringHeight / SPIKE_HEIGHT;
    this.speed = speedFor(layout.ringHeight);
    this.standHeight = layout.standHeight;
    const ps = body.pieces;
    const legLike = (p: Piece) => p.seg.kind === 'leg' || p.seg.kind === 'foot';
    this.legs = ps.filter((p) => legLike(p) && !(p.seg.parent >= 0 && legLike(ps[p.seg.parent]))).map((top) => {
      const chain = [top];
      for (let at = top; ;) {
        const next = ps.find((c) => c.seg.parent === at.seg.id && legLike(c));
        if (!next) break;
        chain.push((at = next));
      }
      return chain;
    });
    this.wings = ps.filter((p) => p.seg.kind === 'wing');
    const weapons = ps.filter((p) => p.seg.weapon);
    this.weapons = weapons.length ? weapons : [body.torso];
    this.weaponLimbs = this.weapons.map((w) => this.limb(w));
    this.torsoRestInv = body.torso.restQ.clone().invert();
    const guard = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -GUARD_TURN);
    const legSet = new Set(this.legs.flat());
    this.braces = ps.filter((p) => p !== body.torso && p !== body.head).map((p) => {
      const joint = v(p.seg.anchor).sub(p.restP).applyQuaternion(p.restQ.clone().invert());
      const load = ps.filter((c) => this.hangsOff(c, p));
      // the load's inertia about the joint (rest pose): each piece's own, plus its mass × its distance² from the joint
      const inertia = load.reduce((t, c) => {
        const L = pieceLength(c), r = c.seg.radius;
        return t + c.mass * ((L * L) / 12 + 0.4 * r * r + c.restP.distanceToSquared(v(p.seg.anchor)));
      }, 0);
      const arm = p.seg.kind === 'arm' || p.seg.kind === 'hand';
      return {
        p, joint, load, inertia, leg: legSet.has(p),
        rest: arm ? guard.clone().multiply(p.restQ) : p.restQ.clone(),
        loadMass: load.reduce((t, c) => t + c.mass, 0),
      };
    });
    const h = body.head;
    if (h) this.neck.copy(v(h.seg.anchor)).sub(h.restP).applyQuaternion(h.restQ.clone().invert());
    this.headLoad = h ? ps.filter((p) => this.hangsOff(p, h)) : [];
  }

  /** Whether `p` is `from` or hangs off it (through its parents). */
  private hangsOff(p: Piece, from: Piece): boolean {
    for (let at: Piece = p; ; at = this.body.pieces[at.seg.parent]) {
      if (at === from) return true;
      if (at.seg.parent < 0) return false;
    }
  }

  /** The weapon piece and its parents up to (not including) the torso: the limb a kick swings. */
  limb(w: Piece): Piece[] {
    const out: Piece[] = [];
    for (let p: Piece = w; p.seg.parent >= 0; p = this.body.pieces[p.seg.parent]) out.push(p);
    return out.length ? out : [w];
  }

  /** How long (m) a weapon's limb is, torso to tip. */
  limbLength(w: Piece): number {
    return w === this.body.torso ? 0 : this.limb(w).reduce((t, p) => t + pieceLength(p), 0);
  }

  /** The way the torso faces now (horizontal unit vector). */
  facing(): Vector3 {
    const r = this.body.torso.body.rotation();
    const q = new Quaternion(r.x, r.y, r.z, r.w).multiply(this.body.torso.restQ.clone().invert());
    const f = FORWARD.clone().applyQuaternion(q).setY(0);
    return f.lengthSq() > 1e-6 ? f.normalize() : FORWARD.clone();
  }

  /** Close enough to the floor to push off it (the spike's `grounded`). */
  grounded(R: number): boolean {
    const p = this.body.pos();
    return Math.hypot(p.x, p.z) < R + 0.15 && p.y > -0.4 && p.y < this.standHeight * 1.7 + 0.4;
  }

  /**
   * Hover the torso at stand height and push toward `want` (a horizontal vector up to length 1); `want` null holds the
   * height only and lets the body slide on (a landing's skid).
   */
  hover(dt: number, str: number, want: Vector3 | null, gravity: number): void {
    const M = this.body.mass, p = this.body.pos(), vel = this.body.vel();
    // at most HOVER_MAX g: a body slammed into the floor is caught, not catapulted back up
    const fy = Math.min(M * gravity * HOVER_MAX, Math.max(0, M * gravity * HOVER_CARRY + M * (HOVER_K * (this.standHeight - p.y) - HOVER_D * vel.y))) * str;
    this.body.torso.body.applyImpulse({ x: 0, y: fy * dt, z: 0 }, true);
    if (!want) return;
    const dv = want.clone().multiplyScalar(this.speed).sub(new Vector3(vel.x, 0, vel.z));
    push(this.body.torso, dv, M * DRIVE * dt * str);
  }

  /** Keep the torso upright and turned toward `face`, and the head up on its neck. */
  stand(dt: number, str: number, face: Vector3, gravity: number): void {
    const t = this.body.torso;
    upright(t, dt, str, face, this.body.mass, t.seg.radius + 0.35 * this.k, TORSO_KP, TORSO_KD);
    this.holdHead(dt, str, gravity);
  }

  /** Keep the torso upright without turning it (it may spin freely about up), and the head up on its neck. */
  keepUp(dt: number, str: number, gravity: number): void {
    const t = this.body.torso;
    upright(t, dt, str, null, this.body.mass, t.seg.radius + 0.35 * this.k, TORSO_KP, TORSO_KD);
    this.holdHead(dt, str, gravity);
  }

  /** Every piece moves at `vel` (m/s): a clean jump, dash or dive of the whole body. `keepY` keeps each piece's own up/down speed. */
  setVelocity(vel: Vector3, keepY = false): void {
    for (const p of this.body.pieces) {
      const y = keepY ? p.body.linvel().y : vel.y;
      p.body.setLinvel({ x: vel.x, y, z: vel.z }, true);
    }
  }

  /** Cancels gravity on every piece for `dt` (a hang in the air) and bleeds `bleed` of its speed. */
  float(dt: number, gravity: number, bleed: number): void {
    for (const p of this.body.pieces) {
      const lv = p.body.linvel();
      p.body.applyImpulse({ x: -lv.x * bleed * p.mass, y: (gravity * dt - lv.y * bleed) * p.mass, z: -lv.z * bleed * p.mass }, true);
    }
  }

  /**
   * The neck: the head is balanced on its joint like an upside-down pendulum, and gravity's pull about that joint
   * (weight × lever) is several times what the spike's head PD could give, so the head flipped and hung into the torso.
   * The neck carries the head's weight (and anything hanging off it) about the joint, then a PD on the tilt angle (not
   * its sine, so a head left upside down by a stun is pulled up hardest) holds it up, sized to the head's inertia about
   * the joint. Everything scales with `str`: a stunned head (str 0) flops freely.
   */
  private holdHead(dt: number, str: number, gravity: number): void {
    const h = this.body.head;
    if (!h || str <= 0) return;
    let m = 0;
    const com = new Vector3();
    for (const p of this.headLoad) {
      com.addScaledVector(v(p.body.translation()), p.mass);
      m += p.mass;
    }
    const lever = com.divideScalar(m).sub(worldPoint(h, this.neck));
    // lever × (m g up): cancels gravity's turn about the neck
    const tq = new Vector3(-lever.z, 0, lever.x).multiplyScalar(m * gravity);
    const r = h.body.rotation();
    const u = UP.clone().applyQuaternion(new Quaternion(r.x, r.y, r.z, r.w).multiply(h.restQ.clone().invert()));
    const axis = u.clone().cross(UP);
    const sin = axis.length(), angle = Math.atan2(sin, u.dot(UP));
    if (sin > 1e-6) axis.multiplyScalar(angle / sin);
    else if (u.y < 0) axis.set(Math.PI, 0, 0); // straight upside down: any level axis will do
    // damp the head's swing against the body's (not the world), and stiffen by the body's spin²: a twirling body
    // (the tail's spin) flings its head outward with a pull that grows as spin² (its centrifugal force); capped at
    // 50 rad/s (over any strike: the tail's reach ~37) so a wild tumble can't make the neck stiff enough to kick
    const wt = v(this.body.torso.body.angvel());
    const pd = axis.multiplyScalar(HEAD_KP + Math.min(wt.lengthSq(), 2500)).sub(v(h.body.angvel()).sub(wt).multiplyScalar(HEAD_KD));
    pd.y = 0;
    const inertia = 0.4 * h.mass * h.seg.radius * h.seg.radius + m * lever.lengthSq();
    tq.addScaledVector(pd, inertia).multiplyScalar(str * dt);
    // the torque goes on the head alone, with no equal and opposite twist on the torso: the torso's own upright PD
    // soaks up the reaction through the joint (a muscle, as the spike's upright torques are)
    h.body.applyTorqueImpulse({ x: tq.x, y: tq.y, z: tq.z }, true);
  }

  /**
   * The brace: every piece but the torso and head is sprung toward its rest turn carried by the torso's turn now
   * (`torsoNow × torsoRest⁻¹ × pieceRest`; the arms' rest is up in a guard, `GUARD_TURN`), damped against the torso's
   * spin, and carries the weight hanging off its joint (so a heavy fist on a thin arm does not sag); all × `tune.stiff`
   * × `str`. The PD is an angular acceleration, so its gains are in effect sized to the inertia about the joint of
   * everything the piece holds: each tick that load (the piece and what hangs off it) is turned about the joint as one
   * rigid lump, and the opposite push goes on the torso, so bracing never shoves the body along. (A torque on the piece
   * alone did not work: a few-gram arm holding a fist spun about its own middle faster than the joint could hold it.
   * Nor did an opposite turn on the torso: a light torso on long heavy legs, the legs fixture, was swung about until
   * it spun.) Pieces in `skip` (the limb throwing the current attack) swing free; the legs are held
   * at half while waddling. With `stiff` 0 the limbs dangle as before.
   */
  brace(dt: number, str: number, skip?: ReadonlySet<Piece> | null, tune: Pick<Tune, 'stiff' | 'gravity'> = TUNE): void {
    const s = tune.stiff * str;
    if (!(s > 0)) return;
    const torso = this.body.torso.body, tr = torso.rotation(), wt = torso.angvel();
    _turn.set(tr.x, tr.y, tr.z, tr.w).multiply(this.torsoRestInv);
    for (const b of this.braces) {
      if (skip?.has(b.p)) continue;
      const g = s * (b.leg && this.walking ? LEG_WALK : 1);
      const body = b.p.body, r = body.rotation(), t = body.translation();
      // the turn still to go, as an axis × angle (the short way round)
      _err.copy(_turn).multiply(b.rest).multiply(_cur.set(r.x, r.y, r.z, r.w).invert());
      if (_err.w < 0) _err.set(-_err.x, -_err.y, -_err.z, -_err.w);
      const sn = Math.hypot(_err.x, _err.y, _err.z);
      const k = sn > 1e-9 ? (2 * Math.atan2(sn, _err.w)) / sn : 2;
      const wp = body.angvel();
      _w.set(wp.x - wt.x, wp.y - wt.y, wp.z - wt.z);
      // this tick's change of spin (rad/s): the PD, capped
      _dw.set(_err.x * k, _err.y * k, _err.z * k).multiplyScalar(BRACE_KP).addScaledVector(_w, -BRACE_KD).multiplyScalar(g * dt);
      const dw = _dw.length();
      if (dw > BRACE_MAX_DW) _dw.multiplyScalar(BRACE_MAX_DW / dw);
      // plus carrying the weight: lever × (m g up), over the load's inertia about the joint
      _joint.copy(b.joint).applyQuaternion(_cur.set(r.x, r.y, r.z, r.w)).add(_p.set(t.x, t.y, t.z));
      _com.set(0, 0, 0);
      for (const c of b.load) {
        const ct = c.body.translation();
        _com.x += ct.x * c.mass; _com.y += ct.y * c.mass; _com.z += ct.z * c.mass;
      }
      _com.divideScalar(b.loadMass).sub(_joint);
      const carry = (b.loadMass * tune.gravity * g * dt) / b.inertia;
      _dw.x -= _com.z * carry;
      _dw.z += _com.x * carry;
      // turn the load about the joint by that much, and push the torso back the other way
      _push.set(0, 0, 0);
      for (const c of b.load) {
        const ct = c.body.translation(), lv = c.body.linvel(), av = c.body.angvel();
        _dv.set(ct.x - _joint.x, ct.y - _joint.y, ct.z - _joint.z).crossVectors(_dw, _dv);
        c.body.setLinvel({ x: lv.x + _dv.x, y: lv.y + _dv.y, z: lv.z + _dv.z }, true);
        c.body.setAngvel({ x: av.x + _dw.x, y: av.y + _dw.y, z: av.z + _dw.z }, true);
        _push.addScaledVector(_dv, -c.mass);
      }
      torso.applyImpulse(_push, true);
    }
  }

  /** Off its feet (launched): not waddling, so the brace holds the legs in full. */
  offFeet(): void {
    this.walking = false;
  }

  /** Swing the legs in turn while walking (and flutter wings). */
  waddle(dt: number, str: number, face: Vector3, grounded: boolean): void {
    const vel = this.body.vel();
    const sp = Math.hypot(vel.x, vel.z);
    this.walkPhase += dt * (3 + sp * 2.5);
    this.walking = grounded && str > 0.5 && sp > 0.4;
    if (this.walking) {
      this.legs.forEach((chain, i) => {
        const s = Math.sin(this.walkPhase + i * Math.PI);
        const dir = face.clone().multiplyScalar(s).add(UP.clone().multiplyScalar(Math.max(0, s) * 0.6));
        for (const p of chain) push(p, dir, p.mass * 9 * dt);
      });
    }
    if (this.wings.length && sp > 0.3) for (const w of this.wings) push(w, UP, w.mass * Math.sin(this.walkPhase * 3) * 14 * dt);
  }

  /**
   * Wings: a lucky flap back in off the edge (60% chance each time it is possible, then 1.1 s to recharge). Its lift is
   * the spike's at gravity 20, scaled so it climbs as high under any gravity.
   */
  flapSave(dt: number, R: number, rng: () => number, gravity = SPIKE_G): void {
    this.flapCd -= dt;
    if (!this.wings.length || this.flapCd > 0) return;
    const p = this.body.pos(), flat = new Vector3(p.x, 0, p.z);
    if (flat.length() > R - 0.2 && p.y > -2.2 && rng() < 0.6) {
      this.flapCd = 1.1;
      // up to the flap's lift, not on top of a climb already under way
      const lift = Math.max(0, 9 * Math.sqrt(gravity / SPIKE_G) - Math.max(0, this.body.vel().y));
      push(this.body.torso, flat.normalize().multiplyScalar(-6).add(new Vector3(0, lift, 0)), this.body.mass);
      for (const w of this.wings) push(w, UP, w.mass * 8);
    }
  }

  /** Wind-up: pull the weapon (or the body) back from `dir`, once per tick. */
  windup(dt: number, move: Move, dir: Vector3, w: Piece): void {
    const back = dir.clone().negate();
    if (move === 'punch' || move === 'jab') push(w, back.add(UP.clone().multiplyScalar(0.7)), w.mass * 10 * dt);
    if (move === 'kick' || move === 'bump') push(this.body.torso, back, this.body.mass * 3 * dt);
    if (move === 'headbutt') push(w, back.add(UP.clone().multiplyScalar(-0.5)), w.mass * 12 * dt);
  }

  /** The strike's burst, once, as the strike window opens (a divebomb's hop climbs as high under any `gravity`). */
  strike(move: Move, dir: Vector3, w: Piece, gravity = SPIKE_G): void {
    const M = this.body.mass, torso = this.body.torso, up = (y: number) => UP.clone().multiplyScalar(y);
    switch (move) {
      case 'punch': case 'jab':
        push(w, dir.clone().add(up(0.25)), w.mass * (move === 'punch' ? 26 : 16));
        push(torso, dir, M * 2.5);
        break;
      case 'kick':
        for (const p of new Set(this.weapons.flatMap((x) => this.limb(x)))) push(p, dir.clone().add(up(0.9)), p.mass * 22);
        break;
      case 'bump': push(torso, dir.clone().add(up(0.25)), M * 7); break;
      case 'headbutt': push(torso, dir.clone().add(up(0.15)), M * 10); push(w, dir, w.mass * 12); break;
      case 'divebomb': push(torso, dir.clone().multiplyScalar(DIVE_FWD).add(up(9 * Math.sqrt(gravity / SPIKE_G))), M); break;
      case 'spin': break;
    }
  }

  /** Spin: keeps twisting the body round through the strike window (`times` × the tail's own spin). */
  spin(dt: number, times = 1): void {
    this.body.torso.body.applyTorqueImpulse({ x: 0, y: this.body.mass * 2.2 * this.k * this.k * dt * 10 * times, z: 0 }, true);
  }

  /** Flings `pieces` out from the torso, level, `k` m/s worth each tick (helicopter legs). */
  splay(pieces: readonly Piece[], k: number): void {
    const c = v(this.body.torso.body.translation());
    for (const p of pieces) {
      const d = v(p.body.translation()).sub(c).setY(0);
      if (d.lengthSq() < 1e-6) continue;
      push(p, d.normalize().add(UP.clone().multiplyScalar(0.15)), p.mass * k);
    }
  }
}

/**
 * PD torque keeping a piece the way up it was built (and turning it toward `face`), scaled by strength. Orientation is
 * measured against the piece's rest pose, so a slightly tilted torso capsule is not forced straight.
 */
function upright(part: Piece, dt: number, str: number, face: Vector3 | null, m: number, rad: number, kp: number, kd: number): void {
  if (str <= 0) return;
  const r = part.body.rotation();
  const q = new Quaternion(r.x, r.y, r.z, r.w).multiply(part.restQ.clone().invert()); // creature-frame turn
  const u = UP.clone().applyQuaternion(q);
  const w = v(part.body.angvel());
  const tq = u.clone().cross(UP).multiplyScalar(kp).sub(w.clone().multiplyScalar(kd));
  if (face) {
    const f = FORWARD.clone().applyQuaternion(q);
    let err = Math.atan2(face.x, face.z) - Math.atan2(f.x, f.z);
    err = Math.atan2(Math.sin(err), Math.cos(err));
    tq.y = YAW_KP * err - YAW_KD * w.y;
  } else tq.y = 0;
  const k = 0.4 * m * rad * rad * str * dt;
  part.body.applyTorqueImpulse({ x: tq.x * k, y: tq.y * k, z: tq.z * k }, true);
}
