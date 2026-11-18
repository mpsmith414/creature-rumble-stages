import { Matrix4, Quaternion, Vector2, Vector3, type Object3D } from 'three/webgpu';
import { restPieces } from '../anim/rest';
import type { BodyLayout } from '../anim/layout';
import type { Vec3 } from '../util/vec';
import type { FighterObject } from './fighter-object';

const ONE = new Vector3(1, 1, 1);

/**
 * Each bone's world matrix in the rest pose (bones carry no turn at rest): at its start × `scale` (the fighting scale),
 * scaled by it. `starts` are creature space, the jaw already raised shut.
 */
export function restBoneMatrices(starts: Vec3[], scale: number): Matrix4[] {
  const s = new Vector3(scale, scale, scale), q = new Quaternion();
  return starts.map((p) => new Matrix4().compose(new Vector3(p.x, p.y, p.z).multiplyScalar(scale), q, s));
}

/** Each segment's piece at rest (the poses' rest), as a matrix. */
export function pieceRestMatrices(layout: Pick<BodyLayout, 'segments'>): Matrix4[] {
  return restPieces(layout);
}

/**
 * Where each bone is now: bone i rides rigidly on its segment's piece s = `boneSegment[i]`, so its world matrix is
 * pieceNow[s] × pieceRest[s]⁻¹ × restBones[i]. Pure; writes into `out` when given (no new matrices each frame).
 */
export function boneWorld(layout: Pick<BodyLayout, 'boneSegment'>, restBones: readonly Matrix4[], pieceRest: readonly Matrix4[],
  pieceNow: readonly Matrix4[], out: Matrix4[] = restBones.map(() => new Matrix4())): Matrix4[] {
  while (moved.length < pieceNow.length) moved.push(new Matrix4());
  for (let s = 0; s < pieceNow.length; s++) moved[s].multiplyMatrices(pieceNow[s], _move.copy(pieceRest[s]).invert());
  for (let i = 0; i < restBones.length; i++) out[i].multiplyMatrices(moved[layout.boneSegment[i]], restBones[i]);
  return out;
}
/** boneWorld's scratch: each piece's move from rest. */
const moved: Matrix4[] = [];
const _move = new Matrix4();

/** The pupil's spring (the spike's): stiffness (1/s²), damping (1/s), and how far it may slide (× the eye's radius). */
export const PUPIL_STIFFNESS = 90, PUPIL_DAMPING = 6, PUPIL_MAX = 0.42;
/** How far the pupil leans per m/s of the head's motion, per rad/s of its turn and of its nod (m). */
const LEAN_MOVE = 0.02, LEAN_TURN = 0.01, LEAN_NOD = 0.005;
/** The spring takes steps no longer than this (s): a slow frame does not kick it. */
const PUPIL_STEP = 1 / 60;
/** A pupil hitting the eye's edge bounces back with this much of its speed. */
const PUPIL_BOUNCE = 0.6;

/**
 * A googly eye's pupil: a damped spring that lags behind the head's motion and settles when it stops (the spike's).
 * Its `offset` (m, in the eye's own frame: x across, y up) never goes past PUPIL_MAX × `radius`; the pupil object, a
 * child of the eyeball (whose geometry has radius 1 and which is scaled by the eye's radius), slides by offset / radius.
 */
export class GooglyEye {
  readonly offset = new Vector2();
  readonly vel = new Vector2();
  /** The eye bone it sits on (−1 when not on a fighter). */
  bone = -1;
  private readonly max: number;
  private readonly target = new Vector2();

  /** `radius`: the eyeball's radius (m, at fighting size). */
  constructor(readonly radius: number, readonly pupil: { position: Vector3 } | null = null, readonly ball: Object3D | null = null) {
    this.max = PUPIL_MAX * radius;
  }

  /** `headVel` (m/s) and `headAngVel` (rad/s) are the head's motion in the eye's own frame (x across, y up, z out). */
  update(dt: number, headVel: Vector3, headAngVel: Vector3): void {
    const t = this.target.set(-headVel.x * LEAN_MOVE + headAngVel.y * LEAN_TURN, -headVel.y * LEAN_MOVE - Math.abs(headAngVel.x) * LEAN_NOD);
    t.clampLength(0, this.max * 3);
    for (let left = dt; left > 1e-9; left -= PUPIL_STEP) this.step(Math.min(left, PUPIL_STEP));
    if (this.pupil) {
      this.pupil.position.x = this.offset.x / this.radius;
      this.pupil.position.y = this.offset.y / this.radius;
    }
  }

  private step(h: number): void {
    const { offset: o, vel: v, target: t } = this;
    v.x += (t.x - o.x) * PUPIL_STIFFNESS * h;
    v.y += (t.y - o.y) * PUPIL_STIFFNESS * h;
    v.multiplyScalar(1 - PUPIL_DAMPING * h);
    o.addScaledVector(v, h);
    if (o.length() > this.max) {
      o.setLength(this.max);
      v.multiplyScalar(-PUPIL_BOUNCE);
    }
  }
}

const _p = new Vector3(), _inv = new Matrix4(), _q = new Quaternion(), _qi = new Quaternion(), _lv = new Vector3(), _av = new Vector3();
const _up = new Vector3(0, 1, 0), _place = new Matrix4();

/**
 * The pieces of a creature standing at rest with its origin (the ground under it) at `at`, turned by `yaw` about +y:
 * each `rest` piece moved there as one rigid body (for still line-ups like the dev pages' and tests). Writes into `out`.
 */
export function placedPieces(rest: readonly Matrix4[], at: Vector3, yaw: number, out: Matrix4[] = rest.map(() => new Matrix4())): Matrix4[] {
  _place.compose(at, _q.setFromAxisAngle(_up, yaw), ONE);
  for (let k = 0; k < rest.length; k++) out[k].multiplyMatrices(_place, rest[k]);
  return out;
}

/** Sets every bone's world matrix to bone = pieceNow × pieceRest⁻¹ × restBone (and its matrix under the root to match). */
function placeBones(obj: FighterObject, rest: readonly Matrix4[], now: readonly Matrix4[], out: Matrix4[]): void {
  boneWorld(obj, obj.restBones, rest, now, out);
  obj.root.updateWorldMatrix(true, false);
  _inv.copy(obj.root.matrixWorld).invert();
  for (let i = 0; i < obj.bones.length; i++) {
    const b = obj.bones[i];
    b.matrix.multiplyMatrices(_inv, out[i]); // the scene's next update gives it back: root × matrix
    b.matrixWorld.copy(out[i]);
    b.matrixWorldNeedsUpdate = true;
  }
}

/** Per fighter driven by poses: bone scratch, and last frame's pieces (their motion wobbles the eyes). */
type PoseScratch = { out: Matrix4[]; lastP: Vector3[]; lastQ: Quaternion[]; restQ: Quaternion[]; seen: boolean };
const poseScratches = new WeakMap<FighterObject, PoseScratch>();
const _s = new Vector3(), _dq = new Quaternion();

function poseScratchFor(obj: FighterObject): PoseScratch {
  let s = poseScratches.get(obj);
  if (!s) {
    s = {
      out: obj.bones.map(() => new Matrix4()),
      lastP: obj.pieceRest.map(() => new Vector3()),
      lastQ: obj.pieceRest.map(() => new Quaternion()),
      restQ: obj.pieceRest.map((m) => {
        const q = new Quaternion();
        m.decompose(_p, q, _s);
        return q;
      }),
      seen: false,
    };
    poseScratches.set(obj, s);
  }
  return s;
}

/**
 * Puts the fighter's bones where the given pieces are (one world matrix per segment, as `poseSegments` makes them).
 * Given the frame's `dt` (s), the googly eyes wobble with how each eye's piece moved
 * since the last call (the first call only remembers). Allocates nothing per frame.
 */
export function driveBonesFrom(obj: FighterObject, pieceNow: readonly Matrix4[], dt = 0): void {
  const s = poseScratchFor(obj);
  placeBones(obj, obj.pieceRest, pieceNow, s.out);
  if (dt > 0 && s.seen) for (const e of obj.eyes) {
    const k = obj.boneSegment[e.bone], now = pieceNow[k];
    if (!now) continue;
    now.decompose(_p, _q, _s);
    _lv.copy(_p).sub(s.lastP[k]).divideScalar(dt);
    // the turn since last frame, as an angular speed: angle × axis / dt (the shorter way round)
    _dq.copy(_q).multiply(_qi.copy(s.lastQ[k]).invert());
    if (_dq.w < 0) _dq.set(-_dq.x, -_dq.y, -_dq.z, -_dq.w);
    const sinHalf = Math.hypot(_dq.x, _dq.y, _dq.z), angle = 2 * Math.atan2(sinHalf, _dq.w);
    if (sinHalf > 1e-9) _av.set(_dq.x, _dq.y, _dq.z).multiplyScalar(angle / sinHalf / dt);
    else _av.set(0, 0, 0);
    // read in the eye's own frame: its gaze on the bone, turned as the piece has turned from rest
    _q.multiply(_qi.copy(s.restQ[k]).invert());
    if (e.ball) _q.multiply(e.ball.quaternion);
    _q.invert();
    e.update(dt, _lv.applyQuaternion(_q), _av.applyQuaternion(_q));
  }
  for (let k = 0; k < pieceNow.length && k < s.lastP.length; k++) pieceNow[k].decompose(s.lastP[k], s.lastQ[k], _s);
  s.seen = true;
}
