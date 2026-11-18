import { Euler, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import type { Move } from '../fight/types';
import type { BodyLayout, Segment, SegmentKind } from './layout';
import type { Attack, AttackDir } from '../stage/attacks';
import type { Action, StageFighter } from '../stage/fighter';
import type { V2 } from '../stage/types';
import { CAMERA_TURN, fillFrame, newFrame, type Frame } from './clips';
import { restPiece } from './rest';

export { CAMERA_TURN };
export { restPiece, restPieces } from './rest';

/**
 * Creatures moved by computed poses, never by physics: every segment of the body's layout turns rigidly about its
 * joint (`anchor`) in its parent's frame, parent before child, so a limb can never come loose. The whole body then
 * stands on the fighter's box on the stage (the plane z = 0, x right, y up): its own +z turned to face ±x, then turned
 * a little toward the camera, its feet on the box's bottom centre. The clips themselves are in `clips.ts`.
 */

/** What a pose can show: any fighter action, or the show-off (entrances and the champion's strut). */
export type AnimAction = Action | 'showoff';

/**
 * Everything a pose needs from a fighter at one moment. `t` is the steps since the action began (a fraction between
 * steps is fine), `len` the action's length in steps (0 when untimed). `attack` and `attackDir` are the attack under way.
 * `spin` is the tumble's turn (rad, about the stage's z axis), `land` the landing squash (1 at touch-down, easing to 0).
 * `ground`: standing on something (grounded poses keep the lowest point on the box bottom). A special's `attack` is its
 * main blow (its timing and hit area); `holding` and `throwUp` say how a grab and a throw go.
 */
export type AnimState = {
  action: AnimAction;
  t: number;
  len: number;
  facing: 1 | -1;
  pos: V2;
  vel: V2;
  move: Move;
  attackDir?: AttackDir;
  attack?: Attack | null;
  spin: number;
  land: number;
  ground: boolean;
  /** In a grab: whether it holds someone (else it is still reaching). */
  holding?: boolean;
  /** In a throw: whether it throws up (else forward). */
  throwUp?: boolean;
  /** The look's size (1 when missing; Grow Juice: up to 1.6), from the box's bottom centre: its box grew as much. */
  scale?: number;
  /**
   * Hanging from a vine (the jungle's mischief: the sim keeps riders on `sim.mischief`, so the show sets this, not
   * `animState`): in the air it hangs by its hands from the grip instead of the air pose.
   */
  hang?: boolean;
};

/** The tumble's spin (rad per step): two turns a second, a clean cartwheel. */
export const TUMBLE_SPIN = (2 * 2 * Math.PI) / 60;

/**
 * `f` as a pose sees it, written into `out` when given (it keeps its own `pos` and `vel` objects). `t` is the steps into
 * the action to show (the fighter's own count by default; the TV passes one between two steps to draw smoothly).
 */
export function animState(f: StageFighter, out: AnimState = blankState(), t = f.actionT): AnimState {
  const action = f.action === 'frozen' ? f.frozenFrom : f.action;
  out.action = action;
  out.t = t;
  out.len = f.actionLen;
  out.facing = f.facing;
  out.pos.x = f.mover.pos.x;
  out.pos.y = f.mover.pos.y;
  out.vel.x = f.mover.vel.x;
  out.vel.y = f.mover.vel.y;
  out.move = f.stats.move;
  out.attackDir = f.attackDir ?? undefined;
  out.attack = f.attack;
  // A backflip away from the attacker (who it faces): the head goes back the way the body flies.
  out.spin = action === 'tumble' || action === 'out' ? f.facing * TUMBLE_SPIN * t : 0;
  out.land = action === 'land' && f.actionLen > 0 ? Math.max(0, 1 - t / f.actionLen) : 0;
  out.ground = f.mover.ground !== null;
  out.scale = f.lookScale();
  out.holding = f.holding !== null;
  out.throwUp = f.throwDir === 'up';
  return out;
}

/** The look's size in `a`: its `scale`, 1 when missing or broken. */
const lookSize = (a: AnimState) => (a.scale !== undefined && Number.isFinite(a.scale) && a.scale > 0 ? a.scale : 1);

function blankState(): AnimState {
  return { action: 'idle', t: 0, len: 0, facing: 1, pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, move: 'punch', spin: 0, land: 0, ground: true };
}

/**
 * What each segment is for in a pose: the root (torso); a hip (a leg or foot hanging off the body), a knee (a leg below
 * a leg), an ankle (a foot below a leg); a shoulder (an arm or hand off the body), an elbow (the first piece below a
 * shoulder), a hand (further down the arm); a wing (off the body) and a wing tip; a tail piece; the head; anything else.
 */
export type Joint = 'root' | 'hip' | 'knee' | 'ankle' | 'shoulder' | 'elbow' | 'hand' | 'wing' | 'wingTip' | 'tail' | 'head' | 'other';

/** A body's layout read once for posing (per layout, kept while the layout lives). */
export type BodyInfo = {
  n: number;
  segments: readonly Segment[];
  joint: Joint[];
  /** −1, 0 or 1: which side of the body (creature x) the segment is on. */
  side: number[];
  /** For a tail piece, how far down the tail it is (0 at the body). */
  chain: number[];
  parent: number[];
  /** The piece that swings a limb: the ancestor hanging straight off the root (the segment itself if it does; 0 for the root). */
  limb: number[];
  anchor: Vector3[];
  a: Vector3[];
  b: Vector3[];
  /** Each piece at rest: its centre and its turn (its +y along a→b). */
  restP: Vector3[];
  restQ: Quaternion[];
  /** The box's centre at rest (creature x and z), so the body stands centred on its box; its height. */
  cx: number;
  cz: number;
  boxH: number;
  /** The body's fighting height (m). */
  height: number;
  /** Whether it has real legs (knees or leg pieces), not just feet on its body. */
  legs: boolean;
};

/** Segment kinds the box is sized from, as `bodyStats` does: the body itself (not arms, wings, tails or horns). */
const BOX_KINDS: readonly SegmentKind[] = ['torso', 'head', 'leg', 'foot'];
/** A segment more than this far off the middle (m) is on a side. */
const SIDE_EPS = 0.01;

const infos = new WeakMap<BodyLayout, BodyInfo>();

/** A layout read for posing (worked out once per layout). */
export function bodyInfo(layout: BodyLayout): BodyInfo {
  let info = infos.get(layout);
  if (!info) infos.set(layout, (info = readBody(layout)));
  return info;
}

const isLeg = (k: SegmentKind) => k === 'leg' || k === 'foot';
const isArm = (k: SegmentKind) => k === 'arm' || k === 'hand';

function readBody(layout: BodyLayout): BodyInfo {
  const segs = layout.segments, n = segs.length;
  const joint: Joint[] = [], side: number[] = [], chain: number[] = [], parent: number[] = [], limb: number[] = [];
  const v3 = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z);
  segs.forEach((g, s) => {
    const p = g.parent;
    parent.push(p);
    limb.push(p < 0 ? 0 : p === 0 ? s : limb[p]);
    const pk = p >= 0 ? segs[p].kind : null;
    const mid = (g.a.x + g.b.x) / 2;
    side.push(mid > SIDE_EPS ? 1 : mid < -SIDE_EPS ? -1 : 0);
    chain.push(g.kind === 'tail' && pk === 'tail' ? chain[p] + 1 : 0);
    let j: Joint = 'other';
    if (p < 0) j = 'root';
    else if (isLeg(g.kind)) j = !pk || !isLeg(pk) ? 'hip' : g.kind === 'leg' ? 'knee' : 'ankle';
    else if (isArm(g.kind)) j = !pk || !isArm(pk) ? 'shoulder' : joint[p] === 'shoulder' ? 'elbow' : 'hand';
    else if (g.kind === 'wing') j = pk === 'wing' ? 'wingTip' : 'wing';
    else if (g.kind === 'tail') j = 'tail';
    else if (g.kind === 'head') j = 'head';
    joint.push(j);
  });
  const restP: Vector3[] = [], restQ: Quaternion[] = [];
  for (const g of segs) {
    const { p, q } = restPiece(g);
    restP.push(p);
    restQ.push(q);
  }
  const box = segs.filter((g) => BOX_KINDS.includes(g.kind));
  const core = box.length ? box : [segs[0]];
  const span = (axis: 'x' | 'z') => {
    let lo = Infinity, hi = -Infinity;
    for (const g of core) {
      lo = Math.min(lo, g.a[axis] - g.radius, g.b[axis] - g.radius);
      hi = Math.max(hi, g.a[axis] + g.radius, g.b[axis] + g.radius);
    }
    return (lo + hi) / 2;
  };
  const boxH = Math.max(...core.map((g) => Math.max(g.a.y, g.b.y) + g.radius));
  return {
    n, segments: segs, joint, side, chain, parent, limb,
    anchor: segs.map((g) => v3(g.anchor)), a: segs.map((g) => v3(g.a)), b: segs.map((g) => v3(g.b)),
    restP, restQ, cx: span('x'), cz: span('z'), boxH, height: layout.fightHeight,
    legs: segs.some((g, s) => g.kind === 'leg' || joint[s] === 'knee'),
  };
}

// ---- posing ----

/** A lunge (a step toward a target out of reach) starts when the weapon is further than this × the area's radius from its centre. */
const LUNGE_FROM = 0.6;
/** The longest lunge, × the box height. */
const LUNGE_MAX = 0.35;
/**
 * How far each joint may ever turn from rest relative to its parent (rad): a head nods and turns on its neck but never
 * folds back on it; a shoulder may go right overhead, a knee tuck up tight. Every pose is held inside these, the
 * weapon's aim included (a strike that cannot reach within them leans or lunges the body instead).
 */
export const JOINT_MAX: Readonly<Record<Joint, number>> = {
  root: Math.PI, head: 1.0, shoulder: 2.9, elbow: 2.0, hand: 2.0, hip: 2.4, knee: 2.5, ankle: 1.6,
  wing: 2.4, wingTip: 1.5, tail: 1.5, other: 1.0,
};
/** Below this |sin| of the body's turn, aiming at the stage is skipped (the body is turned edge-on mid-twirl). */
const AIM_MIN_SIN = 0.2;

const ONE = new Vector3(1, 1, 1);
const frame: Frame = newFrame();
/** Per segment: its local turn about its anchor; its pose in creature space (x → q·x + t). */
const local: Quaternion[] = [], wq: Quaternion[] = [], wt: Vector3[] = [];
const _e = new Euler(0, 0, 0, 'YXZ');
const _qa = new Quaternion(), _qb = new Quaternion(), _qi = new Quaternion();
const _va = new Vector3(), _vb = new Vector3(), _vc = new Vector3(), _lift = new Vector3();
const _w = new Matrix4(), _m = new Matrix4();

function ensure(n: number): void {
  while (local.length < n) {
    local.push(new Quaternion());
    wq.push(new Quaternion());
    wt.push(new Vector3());
  }
}

/** Places every segment from the local turns and the root's lift: parents first, each child turned about its anchor. */
function compose(info: BodyInfo, lift: Vector3): void {
  const { n, parent, anchor } = info;
  for (let s = 0; s < n; s++) {
    const p = parent[s], A = anchor[s];
    if (p < 0) {
      wq[s].copy(local[s]);
      wt[s].copy(A).add(lift).sub(_va.copy(A).applyQuaternion(wq[s]));
    } else {
      wq[s].multiplyQuaternions(wq[p], local[s]);
      // the joint stays where the parent carries it: t = (q_p·A + t_p) − q·A
      wt[s].copy(A).applyQuaternion(wq[p]).add(wt[p]).sub(_va.copy(A).applyQuaternion(wq[s]));
    }
  }
}

/** A creature-space point `p` of segment `s`, posed (into `out`). */
const posed = (s: number, p: Vector3, out: Vector3) => out.copy(p).applyQuaternion(wq[s]).add(wt[s]);

/**
 * The world matrix of every segment's piece (as `driveBonesFrom` takes them) for the fighter in state `a`: written
 * into `out` (one per segment) and returned. Deterministic, and allocates nothing once a layout has been seen.
 */
export function poseSegments(layout: BodyLayout, a: AnimState, out: Matrix4[], mem?: PoseMemory): Matrix4[] {
  const info = bodyInfo(layout), n = info.n, f = frame;
  ensure(n);
  while (out.length < n) out.push(new Matrix4());
  fillFrame(info, a, f);
  if (mem) carrySpin(mem, a, f);

  for (let s = 0; s < n; s++) local[s].setFromEuler(_e.set(f.pitch[s], f.yaw[s], f.roll[s], 'YXZ'));
  if (f.plant) {
    // hips hang straight down whatever the body does, so the legs stay planted under a leaning body
    _qi.copy(local[0]).invert();
    for (let s = 1; s < n; s++) if (info.joint[s] === 'hip') local[s].premultiply(_qi);
  }
  for (let s = 1; s < n; s++) holdJoint(info, s);
  let yaw = a.facing * (Math.PI / 2 - CAMERA_TURN) + f.twirl;
  if (mem) yaw = crossFade(info, mem, a, f, yaw);
  _lift.set(f.liftX, f.liftY, f.liftZ);
  compose(info, _lift);

  if (f.aim >= 0 && a.attack && Math.abs(Math.sin(yaw)) > AIM_MIN_SIN) aim(info, a, a.attack, f, yaw);
  if (mem) remember(mem, n, f, yaw);

  // W = T(box bottom + fit) · size · squash · spin about the box's middle · turn · centre on the box
  const sy = 1 - f.squash, sxz = 1 + f.squash / 2, hc = info.boxH / 2, sc = lookSize(a);
  _w.makeTranslation(-info.cx, 0, -info.cz)
    .premultiply(_m.makeRotationY(yaw))
    .premultiply(_m.makeTranslation(0, -hc, 0))
    .premultiply(_m.makeRotationZ(f.spin))
    .premultiply(_m.makeTranslation(0, hc, 0))
    .premultiply(_m.makeScale(sxz, sy, sxz))
    .premultiply(_m.makeScale(sc, sc, sc));
  let fit = 0;
  if (f.ground) {
    // the lowest point of any capsule rests on the box bottom: feet planted, nothing sunk into the floor
    let low = Infinity;
    for (let s = 0; s < n; s++) {
      const r = info.segments[s].radius * sy * sc;
      low = Math.min(low, posed(s, info.a[s], _va).applyMatrix4(_w).y - r, posed(s, info.b[s], _va).applyMatrix4(_w).y - r);
    }
    fit = -low;
  }
  _w.premultiply(_m.makeTranslation(a.pos.x, a.pos.y + fit, f.slide));

  for (let s = 0; s < n; s++) {
    _qa.multiplyQuaternions(wq[s], info.restQ[s]);
    out[s].compose(posed(s, info.restP[s], _va), _qa, ONE).premultiply(_w);
  }
  return out;
}

// ---- the cross-fade (display only) ----

/** Steps a change of action (or of facing) takes to cross-fade from the pose shown before: about 5 frames. */
export const FADE_STEPS = 5;
/**
 * These start at once, never faded into: a hit lands with a snap (the impact must read), and an attack, a special or a
 * grab starts on its own wind-up (a jab winds up in 3 steps: a fade would leave its strike short of the pose). Out of a
 * hold (thrown, or hit out of the hands) even these fade, so the curled-up held pose eases into the tumble.
 */
const SNAP_INTO: ReadonlySet<AnimAction> = new Set<AnimAction>(['attack', 'special', 'grab', 'hitstun', 'tumble', 'out']);
/** The same action counts as begun again when its time goes back by more than this (steps): a second attack. */
const RESTART = 0.5;
const TAU = 2 * Math.PI;

/** The whole body's moves as shown: its lift (creature m), its turns about the vertical and in the stage's plane (rad), squash, slide. */
type BodyMoves = { liftX: number; liftY: number; liftZ: number; yaw: number; spin: number; squash: number; slide: number };
const blankMoves = (): BodyMoves => ({ liftX: 0, liftY: 0, liftZ: 0, yaw: 0, spin: 0, squash: 0, slide: 0 });

/**
 * What one fighter's body last showed, so a change of action cross-fades instead of snapping (tumble to landing, a run
 * coming to a stop, a turn round). Display only: the fight never reads it, so a bout still replays exactly. The fade
 * blends each joint's LOCAL turn (and the body's lift, turns, squash and slide), never the pieces' world matrices, so
 * every joint stays on its parent and inside its range all the way. One per fighter; `elapse` moves the fade on by
 * the fight steps that passed since the last pose. An attack or a hit's reaction is never faded into: it snaps.
 */
export class PoseMemory {
  /** What was shown last (null: nothing yet), its facing and its steps into the action. */
  action: AnimAction | null = null;
  facing: 1 | -1 = 1;
  t = 0;
  /** Steps of the fade done (FADE_STEPS: none under way). */
  fade = FADE_STEPS;
  /** Added to the tumble's spin so it runs on unbroken when the tumble starts again or becomes out (rad). */
  spinCarry = 0;
  /** Segments remembered (0 until the first pose). */
  n = 0;
  readonly from: Quaternion[] = [];
  readonly last: Quaternion[] = [];
  readonly fromBody: BodyMoves = blankMoves();
  readonly lastBody: BodyMoves = blankMoves();

  /** Moves the fade on by `steps` fight steps (a fraction is fine; a broken or negative count does nothing). */
  elapse(steps: number): void {
    if (Number.isFinite(steps) && steps > 0) this.fade = Math.min(FADE_STEPS, this.fade + steps);
  }
}

/** `a` to `b` the short way round, `k` of the way (rad). */
function lerpAngle(a: number, b: number, k: number): number {
  const d = ((((b - a) % TAU) + 3 * Math.PI) % TAU) - Math.PI;
  return a + d * k;
}
const smoothStep = (p: number) => p * p * (3 - 2 * p);

/**
 * Keeps the tumble's spin unbroken: the spin counts from the start of the action, so a tumble begun again by another
 * hit, one that becomes out, or a thrown one (lying flat overhead) would jump back upright; instead it carries on from
 * the turn last shown.
 */
function carrySpin(mem: PoseMemory, a: AnimState, f: Frame): void {
  if (a.action !== 'tumble' && a.action !== 'out') {
    mem.spinCarry = 0;
    return;
  }
  const was = mem.action;
  const again = was === a.action && a.t + RESTART < mem.t;
  if ((was === 'tumble' && (a.action === 'out' || again)) || was === 'held') mem.spinCarry = mem.lastBody.spin - f.spin;
  else if (was !== 'tumble' && was !== 'out') mem.spinCarry = 0;
  f.spin += mem.spinCarry;
}

/**
 * Starts a fade when the action (or the facing) changes or begins again, and while one is under way blends this pose's
 * local joint turns and body moves from the pose shown when it began. Returns the body's turn about the vertical.
 */
function crossFade(info: BodyInfo, mem: PoseMemory, a: AnimState, f: Frame, yaw: number): number {
  const n = info.n;
  const changed = mem.action !== null && (a.action !== mem.action || a.facing !== mem.facing || a.t + RESTART < mem.t);
  if (mem.n !== n) mem.fade = FADE_STEPS;
  else if (changed) {
    // (out of a hold a body fades even into a snap action: thrown, the curled-up held pose eases into the tumble's
    // shape while its spin carries on, so nothing jumps)
    if (SNAP_INTO.has(a.action) && mem.action !== 'held') mem.fade = FADE_STEPS;
    else {
      for (let s = 0; s < n; s++) (mem.from[s] ??= new Quaternion()).copy(mem.last[s]);
      Object.assign(mem.fromBody, mem.lastBody);
      mem.fade = 0;
    }
  }
  mem.action = a.action;
  mem.facing = a.facing;
  mem.t = a.t;
  if (mem.fade >= FADE_STEPS) return yaw;

  const k = smoothStep(mem.fade / FADE_STEPS), b = mem.fromBody;
  for (let s = 0; s < n; s++) {
    _qb.copy(local[s]);
    local[s].copy(mem.from[s]).slerp(_qb, k);
    if (s > 0) holdJoint(info, s);
  }
  f.liftX = b.liftX + (f.liftX - b.liftX) * k;
  f.liftY = b.liftY + (f.liftY - b.liftY) * k;
  f.liftZ = b.liftZ + (f.liftZ - b.liftZ) * k;
  f.squash = b.squash + (f.squash - b.squash) * k;
  f.slide = b.slide + (f.slide - b.slide) * k;
  f.spin = lerpAngle(b.spin, f.spin, k);
  return lerpAngle(b.yaw, yaw, k);
}

/** Notes the pose just shown (after the aim and any lunge) for the next fade. */
function remember(mem: PoseMemory, n: number, f: Frame, yaw: number): void {
  for (let s = 0; s < n; s++) (mem.last[s] ??= new Quaternion()).copy(local[s]);
  mem.n = n;
  const b = mem.lastBody;
  b.liftX = _lift.x;
  b.liftY = _lift.y;
  b.liftZ = _lift.z;
  b.yaw = yaw;
  b.spin = f.spin;
  b.squash = f.squash;
  b.slide = f.slide;
}

/** Keeps segment `s`'s turn from rest within its joint's range (`JOINT_MAX`), turning it back the short way if past it. */
function holdJoint(info: BodyInfo, s: number): void {
  const q = local[s], max = JOINT_MAX[info.joint[s]];
  const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  if (angle > max) q.copy(_qb.identity().slerp(q, max / angle));
}

/**
 * Swings the weapon's limb about its joint so the weapon's far end points at the attack's hit area (swept through it
 * across the strike by `f.sweep`), weighted by `f.aimW`; a weapon still out of reach (or the body itself) lunges the
 * whole body toward it along its facing.
 */
function aim(info: BodyInfo, a: AnimState, atk: Attack, f: Frame, yaw: number): void {
  const w = f.aim, j = info.limb[w], sinY = Math.sin(yaw), cosY = Math.cos(yaw);
  const own = f.aimR > 0;
  // (the attack's area is on the stage; a grown body is posed at its own size, then scaled up)
  const k = own ? 1 : 1 / lookSize(a);
  const X = a.facing * (own ? f.aimDx : atk.area.dx * k), Y = own ? f.aimDy : atk.area.dy * k, R = own ? f.aimR : atk.area.r * k;
  if (j > 0) {
    const p = info.parent[j];
    const P = posed(p, info.anchor[j], _va);
    // the target in creature space: in the limb's own side plane, at the area's place on the stage
    const tz = info.cz + (X - cosY * (P.x - info.cx)) / sinY;
    const v = _vb.set(0, Y - P.y, tz - P.z);
    const c = Math.cos(f.sweep), sn = Math.sin(f.sweep);
    v.set(0, v.y * c - v.z * sn, v.y * sn + v.z * c);
    const u = posed(w, info.b[w], _vc).sub(P);
    if (u.lengthSq() > 1e-10 && v.lengthSq() > 1e-10) {
      _qa.setFromUnitVectors(u.normalize(), v.normalize());
      _qb.identity().slerp(_qa, f.aimW);
      // a turn in creature space about the joint, as a turn in the parent's own frame: q_p⁻¹ · Q · q_p
      _qi.copy(wq[p]).invert();
      local[j].premultiply(_qa.copy(wq[p])).premultiply(_qb).premultiply(_qi);
      holdJoint(info, j);
      compose(info, _lift);
    }
  }
  if (!f.lunge) return;
  // how far the weapon's nearer end is from the area's centre, on the stage
  let best = Infinity, bx = 0;
  for (let k = 0; k < 2; k++) {
    const q = posed(w, k ? info.b[w] : info.a[w], _vc);
    const sx = cosY * (q.x - info.cx) + sinY * (q.z - info.cz);
    const d = Math.hypot(X - sx, Y - q.y);
    if (d < best) { best = d; bx = X - sx; }
  }
  const far = best - LUNGE_FROM * R;
  if (far <= 0 || best < 1e-9) return;
  const max = LUNGE_MAX * info.boxH;
  const dz = Math.max(-max, Math.min(max, (bx * far) / best / sinY)) * f.aimW;
  _lift.z += dz;
  compose(info, _lift);
}
