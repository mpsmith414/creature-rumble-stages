import { Quaternion, Vector3, type PerspectiveCamera } from 'three/webgpu';
import { ShotPicker, type ShotCue, type ShotPick } from './shot-picker';
import {
  clearHeight, DUEL_FAR, duelBearing, duelNeed, fighterSphere, keepClear, ropePosts, shotAngle, shotFrame, subjectsOf, type ShotBody, type ShotFrame, type ShotName,
  type ShotView, type Sphere,
} from './shots';
import { SHOW_JUMP, WALK_TO } from './timeline';

export { clearHeight };

/**
 * The camera director: through the fight, the shot director (wild ring design 2026-11-14 §6: `shot-picker.ts` chooses,
 * `shots.ts` frames) cutting between wide, duel, hero, low, top, flier, ring-out and crane shots; an entrance shot on the
 * bridge and a push-in on the champion, which win over the fight's shots. Shots change by cuts; inside a shot the camera
 * eases with the same frame-rate-independent smoothing as ever. Allocates almost nothing per frame.
 */
/**
 * Entrance shot (the spike's, measured from the walker's torso): this far in front of it (toward the ring), aside and
 * up (m), looking this far above the torso.
 */
export const ENTRANCE_FRONT = 5.5, ENTRANCE_ASIDE = 2.5, ENTRANCE_UP = 2.4, ENTRANCE_LOOK_UP = 0.6;
/** The show-off shot swings round to this much in front and this much aside (× the same distance): outside the bumper. */
export const SHOW_FRONT = 2.5, SHOW_ASIDE = 5.5;
/** The torso sits this far up a fighter (× its ring height). */
const TORSO_AT = 0.55;
/** Room (m) kept round the fighter's whole jump when sizing the entrance shot. */
const FIT_MARGIN = 0.4;
/** A duel's fighter this high (× its height, torso) when its pair flies apart is a flier worth following. */
const FLIER_HIGH = 1.5;
/**
 * Champion shot: the champion fills this fraction of the frame's height, no nearer than this (m), seen from in front
 * of its face this far (rad) above its eye level (eyes about EYE_AT × its height up), looking at LOOK_AT × its height.
 */
export const CHAMPION_FILL = 0.4, CHAMPION_NEAR = 0.8, CHAMPION_ANGLE = (15 * Math.PI) / 180, EYE_AT = 0.8, CHAMPION_LOOK_AT = 0.6;
/**
 * Smoothing rates (1/s): every shot; the champion shot follows faster, as it is close on a strutting fighter; it swings
 * round to the champion's front slowly, so a sudden turn never whips it round.
 */
export const EASE = 2.5, CHAMPION_EASE = 6, CHAMPION_TURN = 1.5;
const SPIKE_DIST = Math.hypot(ENTRANCE_FRONT, ENTRANCE_ASIDE);

/**
 * A special's impact: a gentle shake of the fight's shot (young children watch on a big TV): never more than SHAKE_MAX m
 * off, dying away within SHAKE_S s; it wobbles at about SHAKE_HZ.
 */
export const SHAKE_MAX = 0.12, SHAKE_S = 0.5, SHAKE_DECAY = 6, SHAKE_HZ = 8;

/** How far off (m) a shake of strength `amp` m may put the camera `t` s after the impact: ≤ SHAKE_MAX, 0 past SHAKE_S. */
export function shakeEnvelope(t: number, amp: number): number {
  if (!(t >= 0) || t >= SHAKE_S || !(amp > 0)) return 0;
  return Math.min(SHAKE_MAX, amp) * Math.exp(-SHAKE_DECAY * t) * (1 - t / SHAKE_S);
}

/** The shake's offset `t` s after an impact of strength `amp` (its length never past `shakeEnvelope`). Writes into `out`. */
export function shakeOffset(t: number, amp: number, out: Vector3): Vector3 {
  const e = shakeEnvelope(t, amp);
  if (e === 0) return out.set(0, 0, 0);
  const w = t * SHAKE_HZ * Math.PI * 2;
  out.set(Math.sin(w), 0.8 * Math.sin(w * 0.83 + 1.3), Math.sin(w * 1.21 + 2.1));
  const l = out.length();
  return l > 1 ? out.multiplyScalar(e / l) : out.multiplyScalar(e);
}

/** How far (0 … 1) the camera closes on its target in `dt` s: 1 − exp(−rate dt) (2.5 by default). */
export const smoothing = (dt: number, rate = EASE) => 1 - Math.exp(-rate * Math.max(0, dt));

/** Anything with a torso to frame (a Fighter). */
export type Tracked = { readonly ragdoll: { readonly torso: { readonly body: { translation(): { x: number; y: number; z: number } } } } };
/** Where a shot puts the camera and what it looks at. */
export type Frame = { pos: Vector3; look: Vector3 };
/** The ring the entrance shot keeps its line of sight clear of, and the camera's vertical field of view (degrees). */
export type Stage = { ringRadius: number; bumper: number; fov: number };

/** The entrance shot swings from the walk shot to the show-off shot as the walker comes from this far past the edge to WALK_TO. */
const SWING_FROM = 4.5;

/** How far (0 … 1) the entrance shot has swung aside for a walker `offset` m past the ring's edge (`entranceFrame`'s `side`). */
export function swing(offset: number): number {
  const k = Math.min(1, Math.max(0, (SWING_FROM - offset) / (SWING_FROM - WALK_TO)));
  return k * k * (3 - 2 * k);
}

const newFrame = (): Frame => ({ pos: new Vector3(), look: new Vector3() });

/**
 * The entrance shot of a fighter standing at `at` (its ground point), `height` m tall, lifted `lift` m off the ground
 * (bounce, jump, hop). It looks at the torso. It stands far enough back that the fighter's whole show-off jump
 * (SHOW_JUMP × height) fits in the frame around the torso as the eased camera follows it, however tall it is; never
 * nearer than the spike's shot.
 * `side` swings it from the spike's walk shot (0: in front, a little aside) to the show-off shot (1: mostly aside, out
 * past the bumper). It rises only as much as it must for its line of sight to the fighter's feet to pass over the
 * bumper. Pure; writes into `out`.
 */
export function entranceFrame(at: Vector3, entryDir: Vector3, height: number, lift: number, side: number, stage: Stage,
  out: Frame = newFrame()): Frame {
  const tanHalf = Math.tan((stage.fov * Math.PI) / 360);
  // half the frame's height holds the body and most of the jump, so the eased camera never loses it at the top or on landing
  const half = (0.5 + 0.75 * SHOW_JUMP) * height + FIT_MARGIN;
  const dist = Math.max(SPIKE_DIST, half / tanHalf);
  const k = dist / SPIKE_DIST;
  const front = (ENTRANCE_FRONT + (SHOW_FRONT - ENTRANCE_FRONT) * side) * k;
  const aside = (ENTRANCE_ASIDE + (SHOW_ASIDE - ENTRANCE_ASIDE) * side) * k;
  const torso = lift + TORSO_AT * height;
  out.look.set(at.x, torso + ENTRANCE_LOOK_UP * Math.min(1, height), at.z);
  const px = at.x - entryDir.x * front - entryDir.z * aside, pz = at.z - entryDir.z * front + entryDir.x * aside;
  // the camera rises with half the lift, so a jump still reads as a jump
  let y = TORSO_AT * height + lift * 0.5 + (ENTRANCE_UP - ENTRANCE_LOOK_UP) * k + ENTRANCE_LOOK_UP;
  y = Math.max(y, clearHeight(at.x, at.z, lift, px, pz, stage));
  out.pos.set(px, y, pz);
  return out;
}

/**
 * The champion shot: in front of a champion `height` m tall standing at `at` (its ground point) and facing `yaw` (rad
 * round +y from +z, as `Math.atan2(x, z)` of its facing), CHAMPION_ANGLE above its eye level, near enough that it fills
 * CHAMPION_FILL of the frame's height (with room above for its crown): its face, crown and the confetti round it.
 * Pure; writes into `out`.
 */
export function championFrame(at: Vector3, height: number, yaw: number, fov: number, out: Frame = newFrame()): Frame {
  const tanHalf = Math.tan((fov * Math.PI) / 360);
  const dist = Math.max(CHAMPION_NEAR, height / (2 * CHAMPION_FILL * tanHalf));
  const flat = Math.cos(CHAMPION_ANGLE) * dist;
  out.look.set(at.x, CHAMPION_LOOK_AT * height, at.z);
  out.pos.set(at.x + Math.sin(yaw) * flat, EYE_AT * height + Math.sin(CHAMPION_ANGLE) * dist, at.z + Math.cos(yaw) * flat);
  return out;
}

/** The way a piece faces (its +z at rest), flat on the ground, as an angle round +y from +z (`Math.atan2(x, z)`). */
export function facingYaw(piece: { readonly body: { rotation(): { x: number; y: number; z: number; w: number } }; readonly restQ: Quaternion }): number {
  const r = piece.body.rotation();
  _turn.set(r.x, r.y, r.z, r.w).multiply(_restInv.copy(piece.restQ).invert());
  _fwd.set(0, 0, 1).applyQuaternion(_turn);
  return Math.hypot(_fwd.x, _fwd.z) > 1e-6 ? Math.atan2(_fwd.x, _fwd.z) : 0;
}
const _turn = new Quaternion(), _restInv = new Quaternion(), _fwd = new Vector3(), _dir = new Vector3();

/** The shortest turn (rad, in −π … π) from `a` to `b`. */
const turnTo = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/**
 * How fast (1/s) the camera eases along each fight shot: the ones that chase a fast fighter (a flier, a hero's leap)
 * keep up closer than the slow shots.
 */
export const SHOT_EASE: Record<ShotName, number> = { wide: EASE, duel: 3, hero: 5, low: 3, top: EASE, flier: 7, ringOut: 5, crane: 3 };
/** The look eases this many times faster than the camera's place, so a fast fighter stays in the middle of the frame. */
export const LOOK_FASTER = 2;
/** A flier shot holds at least this long (s) before its fighter's landing ends it. */
export const FLIER_LEAST = 3;
/** The duel swings round to stay side-on to its pair at this rate (1/s), never whipping across them. */
export const DUEL_TURN = 1.5;
/** Two fighting this near (m, torso to torso) are an engaged pair, for a duel. */
export const PAIR_NEAR = 3.5;
/** A duel whose pair needs the camera this much farther than DUEL_FAR to fit them both is over. */
const DUEL_SLACK = 1.15;

/** A fighter as the director reads it (a Fighter). */
export type Actor = {
  readonly id: string; readonly state: string; readonly stunt: string | null; readonly flying: boolean;
  readonly layout: { readonly ringHeight: number };
  readonly ragdoll: {
    readonly pieces: { readonly length: number };
    readonly torso: { readonly body: { translation(): { x: number; y: number; z: number }; linvel(): { x: number; z: number } } };
  };
};

/** What the director may be told besides the fighters: the props to keep out of, whether a ring event is on, its dice. */
export type DirectorRing = { props?: () => readonly Sphere[]; event?: () => boolean; rng?: () => number };

/**
 * A fighter is "in view" (a special it lets go needs no close-up to be seen) when its torso is inside this share of
 * the frame's half-width and half-height (clear of the edges, where it may be cut off) and in front of the camera.
 */
export const IN_SIGHT = 0.8;
const _fw = new Vector3(), _rt = new Vector3(), _upv = new Vector3(), _d = new Vector3(), _UP = new Vector3(0, 1, 0);
/** Sets the view's axes (`inSight`'s) for a camera at `pos` looking at `look`. */
function sightBasis(pos: Vector3, look: Vector3): void {
  _fw.subVectors(look, pos);
  if (_fw.lengthSq() < 1e-9) _fw.set(0, 0, -1);
  _fw.normalize();
  _rt.crossVectors(_fw, _UP);
  if (_rt.lengthSq() < 1e-9) _rt.set(1, 0, 0); // looking straight down
  _rt.normalize();
  _upv.crossVectors(_rt, _fw);
}
/**
 * Is the point (x, y, z) inside IN_SIGHT of the frame of a camera at `pos` (looking along the axes `sightBasis` set)
 * with vertical field of view `fov` (degrees) and shape `aspect`?
 */
function inSight(pos: Vector3, x: number, y: number, z: number, fov: number, aspect: number): boolean {
  _d.set(x - pos.x, y - pos.y, z - pos.z);
  const depth = _d.dot(_fw);
  if (depth <= 0.1) return false;
  const half = Math.tan((fov * Math.PI) / 360) * depth;
  return Math.abs(_d.dot(_upv)) <= IN_SIGHT * half && Math.abs(_d.dot(_rt)) <= IN_SIGHT * half * aspect;
}

export class CameraDirector {
  /** Where the camera is and what it looks at, and its field of view (degrees), eased. */
  readonly pos = new Vector3(0, 10, 16);
  readonly look = new Vector3();
  fov: number;
  private snap = false;
  /** The champion shot's angle round the champion (eased toward its facing); NaN before the first champion shot. */
  private champYaw = NaN;
  private readonly want = newFrame();
  private readonly shotWant: ShotFrame = { pos: new Vector3(), look: new Vector3(), fov: 50 };
  private readonly stage: Stage;
  /** The mode asked for last: the fight's shots, an entrance, the champion. The shake plays on the fight's shots only. */
  private mode: 'action' | 'entrance' | 'champion' = 'action';
  /** The impact shake: how strong (m) and how long ago (s). */
  private shakeAmp = 0;
  private shakeT = SHAKE_S;
  /** The shot director: its picker, the shot's own angle, the ring's posts, a round's cue held over an entrance. */
  readonly picker: ShotPicker;
  private angle = 0;
  private readonly posts: Sphere[];
  private readonly ring: DirectorRing;
  private held: ShotCue[] = [];
  /** The camera's shape (width / height), read from the camera each `apply`. */
  private aspect = 16 / 9;
  /** Per-frame scratch: the fighters as the shots see them (pooled), by id; those fighting; the ring and shot views. */
  private readonly bodies = new Map<string, ShotBody>();
  private readonly pool: ShotBody[] = [];
  private readonly spherePool: Sphere[] = [];
  private readonly fighting: ShotBody[] = [];
  private readonly ids: string[] = [];
  /** The shot's fighter as last seen (a ring-out's flier is watched on after it is let go), and whose it is. */
  private readonly last: ShotBody = { x: 0, y: 0, z: 0, h: 1 };
  private lastId: string | null = null;
  /** Who is up in the air this frame (a flier shot ends once its fighter is down). */
  private readonly flying = new Set<string>();
  private readonly keepOut: Sphere[] = [];
  private readonly subj: ShotBody[] = [];
  private readonly view: ShotView = { all: this.fighting, t: 0, angle: 0, side: 1, aspect: 16 / 9, keepOut: this.keepOut };
  private readonly inView = new Set<string>();
  private readonly ringView: { ids: string[]; pair: [string, string] | null; star: string | null; event: boolean; inView: Set<string> } = {
    ids: this.ids, pair: null, star: null, event: false, inView: this.inView,
  };

  /**
   * `stage`: the ring (for lines of sight over the bumper) and the camera's vertical field of view (degrees) for the
   * entrance and champion shots. `ring`: the props to keep the camera out of, whether an event is on, and the shot
   * director's randomness.
   */
  constructor(stage: Partial<Stage> = {}, ring: DirectorRing = {}) {
    this.stage = { ringRadius: 6.5, bumper: 0.65, fov: 50, ...stage };
    this.fov = this.stage.fov;
    this.ring = ring;
    this.picker = new ShotPicker(ring.rng ?? Math.random);
    this.posts = ropePosts(this.stage);
  }

  /** The fight's shot now. */
  get shot(): ShotName { return this.picker.pick.shot; }
  /** Who the fight's shot is about (ids), if anyone. */
  get subjects(): { a?: string; b?: string } { return { a: this.picker.pick.a, b: this.picker.pick.b }; }
  /** Which mode the camera was in last: the fight's shots, an entrance or the champion. */
  get showing(): 'action' | 'entrance' | 'champion' { return this.mode; }

  /** The next shot jumps straight there instead of easing (a page's first frame). */
  cut(): void { this.snap = true; }

  /**
   * The fight's shots over `fighters` (everyone in the ring: those fighting are the action; a ring-out's flier is still
   * followed as it falls) with this frame's moments (`cues`): the picker cuts between shots, the shot frames the fight,
   * the camera eases along it, and an impact's shake plays on top (see `apply`).
   */
  action(dt: number, fighters: readonly Actor[], cues: readonly ShotCue[]): void {
    const back = this.mode !== 'action';
    this.mode = 'action';
    this.shakeT += Math.max(0, dt);
    this.read(fighters);
    const ring = this.ringView;
    if (this.held.length) {
      cues = [...this.held, ...cues];
      this.held = [];
    }
    // back from an entrance or the champion: a fresh shot, eased into (the camera is somewhere else entirely)
    if (back) this.begin(this.picker.end(ring, cues.find((c) => c.kind === 'round')), false);
    else {
      const pick = this.picker.update(dt, ring, cues);
      if (pick) this.begin(pick, true);
    }
    // a shot that can no longer frame what it is about ends at once
    for (let i = 0; i < 3 && !this.valid(); i++) this.begin(this.picker.end(ring, this.flierCue()), !back);
    const p = this.picker.pick;
    const view = this.fill(this.picker.held);
    if (p.shot === 'duel' && view.a && view.b) {
      // it stays side-on to the pair as they turn about, swinging round slowly
      this.angle += turnTo(this.angle, duelBearing(view.a, view.b, this.angle)) * smoothing(dt, DUEL_TURN);
      view.angle = this.angle;
    }
    shotFrame(p.shot, view, this.stage, this.posts, this.shotWant);
    this.want.pos.copy(this.shotWant.pos);
    this.want.look.copy(this.shotWant.look);
    this.ease(dt, SHOT_EASE[p.shot], this.shotWant.fov, SHOT_EASE[p.shot] * LOOK_FASTER);
    // the eased camera lags its shot: it is kept clear too (a fighter walking into it pushes it aside)
    keepClear(this.pos, subjectsOf(this.view, this.subj), this.keepOut, this.posts, this.stage, true);
  }

  /** Cues that came while another shot won (an entrance): a round's start is kept for when the fight's shots come back. */
  keep(cues: readonly ShotCue[]): void {
    for (const c of cues) if (c.kind === 'round') this.held = [c];
  }

  /** Dev (key V): cut to the next shot in SHOT_NAMES' order. */
  nextShot(): void {
    this.begin(this.picker.next(this.ringView), true);
  }

  /** Dev shots: cut straight to `shot`. */
  forceShot(shot: ShotName): void {
    this.begin(this.picker.force(shot, this.ringView), true);
  }

  /** A special's impact: a gentle shake of the fight's shot, `amp` m at most (capped at SHAKE_MAX). A stronger one wins. */
  shake(amp: number): void {
    if (shakeEnvelope(this.shakeT, this.shakeAmp) > Math.min(SHAKE_MAX, amp)) return;
    this.shakeAmp = Math.min(SHAKE_MAX, Math.max(0, amp));
    this.shakeT = 0;
  }

  /** Is a shake playing (on the fight's shot)? */
  get shaking(): boolean {
    return this.mode === 'action' && this.shakeT < SHAKE_S;
  }

  /**
   * The entrance shot (`entranceFrame`) of a fighter at `at` (its ground point) `height` m tall lifted `lift` m; `side`
   * 0 while it walks, 1 once it shows off.
   */
  entrance(dt: number, at: Vector3, entryDir: Vector3, height = 1.4, lift = 0, side = 0): void {
    this.leave('entrance');
    entranceFrame(at, entryDir, height, lift, side, this.stage, this.want);
    this.ease(dt, EASE, this.stage.fov);
  }

  /**
   * The champion shot (`championFrame`) of a champion at `at` (its ground point), `height` m tall, facing `yaw`
   * (`facingYaw` of its torso). The camera swings round to its front at CHAMPION_TURN, never whipping round.
   */
  champion(dt: number, at: Vector3, height: number, yaw: number): void {
    this.leave('champion');
    if (Number.isNaN(this.champYaw) || this.snap) this.champYaw = yaw;
    else this.champYaw += turnTo(this.champYaw, yaw) * smoothing(dt, CHAMPION_TURN);
    championFrame(at, height, this.champYaw, this.stage.fov, this.want);
    this.ease(dt, CHAMPION_EASE, this.stage.fov);
  }

  /** Puts the camera on the shot (plus, on the fight's shots, any shake on top of its eased place). */
  apply(camera: PerspectiveCamera): void {
    if (camera.aspect > 0) this.aspect = camera.aspect;
    camera.position.copy(this.pos);
    if (this.mode === 'action') camera.position.add(shakeOffset(this.shakeT, this.shakeAmp, _dir));
    if (Math.abs(camera.fov - this.fov) > 1e-3) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(this.look);
  }

  /** Any other shot ends the shake: it never fights an entrance's or the champion's framing. */
  private leave(mode: 'entrance' | 'champion'): void {
    this.mode = mode;
    this.shakeT = SHAKE_S;
  }

  /** The fighters as the shots see them (by id), those fighting, the closest engaged pair and a star doing a stunt. */
  private read(fighters: readonly Actor[]): void {
    this.bodies.clear();
    this.fighting.length = 0;
    this.ids.length = 0;
    this.keepOut.length = 0;
    this.flying.clear();
    this.inView.clear();
    let n = 0, best = PAIR_NEAR, star: string | null = null;
    sightBasis(this.pos, this.look);
    this.ringView.pair = null;
    for (const f of fighters) {
      if (!f.ragdoll.pieces.length || f.state === 'gone') continue;
      const p = f.ragdoll.torso.body.translation(), v = f.ragdoll.torso.body.linvel();
      const b = this.pool[n] ?? (this.pool[n] = { x: 0, y: 0, z: 0, h: 1 });
      const s = this.spherePool[n] ?? (this.spherePool[n] = { x: 0, y: 0, z: 0, r: 0 });
      n++;
      b.x = p.x; b.y = p.y; b.z = p.z; b.h = f.layout.ringHeight; b.vx = v.x; b.vz = v.z;
      this.bodies.set(f.id, b);
      if (f.flying || f.state === 'out') this.flying.add(f.id);
      this.keepOut.push(fighterSphere(b, s));
      if (f.state !== 'fighting') continue;
      for (let i = 0; i < this.fighting.length; i++) {
        const o = this.fighting[i], d = Math.hypot(o.x - b.x, o.z - b.z);
        if (d < best) { best = d; this.ringView.pair = [this.ids[i], f.id]; }
      }
      this.fighting.push(b);
      this.ids.push(f.id);
      if (inSight(this.pos, b.x, b.y, b.z, this.fov, this.aspect)) this.inView.add(f.id);
      if (star === null && f.stunt !== null) star = f.id;
    }
    this.ringView.star = star;
    this.ringView.event = this.ring.event?.() ?? false;
    for (const s of this.ring.props?.() ?? []) this.keepOut.push(s);
  }

  /** The shot view for the shot now, `t` s into it. */
  private fill(t: number): ShotView {
    const p = this.picker.pick, v = this.view;
    v.a = p.a !== undefined ? this.bodies.get(p.a) : undefined;
    v.b = p.b !== undefined ? this.bodies.get(p.b) : undefined;
    // a ring-out's flier is remembered: once it has fallen out of sight (let go), the shot watches where it went
    if (v.a && p.a !== undefined) {
      this.lastId = p.a;
      Object.assign(this.last, v.a);
    } else if (p.shot === 'ringOut' && p.a !== undefined && p.a === this.lastId) v.a = this.last;
    v.t = t;
    v.angle = this.angle;
    v.side = p.side;
    v.aspect = this.aspect;
    return v;
  }

  /** A shot was cut to: its own angle is chosen now; the camera jumps there (`cut`) or eases there. */
  private begin(p: ShotPick, cut: boolean): void {
    this.angle = shotAngle(p.shot, this.fill(0), p.roll, this.stage);
    if (cut) this.snap = true;
  }

  /**
   * Can the shot still frame what it is about? (Its fighters are there; a duel's pair is still near enough; a flier is
   * still in the air.)
   */
  private valid(): boolean {
    const p = this.picker.pick;
    const a = p.a !== undefined ? this.bodies.get(p.a) : undefined, b = p.b !== undefined ? this.bodies.get(p.b) : undefined;
    const fell = p.shot === 'ringOut' && p.a !== undefined && p.a === this.lastId; // watched to the end of its 1.6 s
    if ((p.a !== undefined && !a && !fell) || (p.b !== undefined && !b)) return false;
    if (p.shot === 'duel' && a && b && duelNeed(a, b, this.aspect) > DUEL_FAR * DUEL_SLACK) return false;
    // a flier shot is over once its fighter has landed (and it has held its least)
    if (p.shot === 'flier' && p.a !== undefined && !this.flying.has(p.a) && this.picker.held >= FLIER_LEAST) return false;
    return true;
  }

  /** When a duel ends because its pair flew apart: a flier shot on whichever of them is up in the air, if one is. */
  private flierCue(): ShotCue | undefined {
    const p = this.picker.pick;
    if (p.shot !== 'duel') return undefined;
    for (const id of [p.b, p.a]) {
      const b = id !== undefined ? this.bodies.get(id) : undefined;
      if (id !== undefined && b && b.y > FLIER_HIGH * b.h) return { kind: 'launch', id };
    }
    return undefined;
  }

  private ease(dt: number, rate: number, fov: number, lookRate = rate): void {
    const k = this.snap ? 1 : smoothing(dt, rate);
    this.snap = false;
    this.pos.lerp(this.want.pos, k);
    this.look.lerp(this.want.look, k === 1 ? 1 : smoothing(dt, lookRate));
    this.fov += (fov - this.fov) * k;
  }
}
