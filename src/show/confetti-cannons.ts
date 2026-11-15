import { Color, DoubleSide, Euler, InstancedMesh, Matrix4, MeshBasicNodeMaterial, PlaneGeometry, Quaternion, Vector3, type Scene } from 'three/webgpu';
import { angleDiff } from '../arena/geometry';
import { mulberry32 } from '../util/rng';

/**
 * Confetti cannons (wild ring design §5.2): a ring-out fires a burst of confetti from the two corner posts nearest where
 * the fighter flew out, up and in over the ring. `nearestPosts` is the pure choice (tested headless); `ConfettiCannons`
 * is a fixed pool of pieces in one instanced mesh (the oldest are reused), so nothing is made per burst or per frame.
 */

/** Pieces in one cannon's burst, and in the pool (room for a few bursts at once). */
export const BURST = 60, CONFETTI_POOL = 360;
/** A piece lives this long (s). */
export const CONFETTI_S = 2.4;
/** A burst leaves the cannon's mouth this high (m) over the floor, up at `SHOOT_UP` m/s (± `SHOOT_JITTER`), in toward
 * the middle at `SHOOT_IN` m/s, spread sideways ± `SHOOT_SPREAD` m/s. */
const MOUTH_Y = 1.35, SHOOT_UP = 8, SHOOT_IN = 2.6, SHOOT_SPREAD = 2.2, SHOOT_JITTER = 2.5;
/** Pieces fall at this gravity (m/s²) and air slows them (per s), so they flutter down. */
const FALL = 9, DRAG = 1.6;
const COLOURS = [0xff4f8b, 0x3ec7ff, 0x7dff5a, 0xffc933, 0xb26bff, 0xff7a2f, 0xffffff];

/** The `n` posts (indices into `angles`, nearest first) closest round the ring to the point `at`. */
export function nearestPosts(at: { x: number; z: number }, angles: readonly number[], n = 2): number[] {
  const a = Math.atan2(at.z, at.x);
  return angles.map((p, i) => ({ i, d: Math.abs(angleDiff(p, a)) })).sort((x, y) => x.d - y.d).slice(0, n).map((x) => x.i);
}

const _m = new Matrix4(), _p = new Vector3(), _q = new Quaternion(), _e = new Euler(), _s = new Vector3(), _zero = new Matrix4().makeScale(0, 0, 0);

export class ConfettiCannons {
  readonly mesh: InstancedMesh;
  private readonly pos = new Float32Array(CONFETTI_POOL * 3);
  private readonly vel = new Float32Array(CONFETTI_POOL * 3);
  private readonly spin = new Float32Array(CONFETTI_POOL * 3);
  private readonly age = new Float32Array(CONFETTI_POOL).fill(CONFETTI_S);
  private next = 0;
  private live = 0;
  private readonly rng: () => number;

  /** `posts`: the corner posts' angles round the ring; they stand `postRadius` m out. */
  constructor(scene: Scene, private readonly posts: readonly number[], private readonly postRadius: number, o: { rng?: () => number } = {}) {
    this.rng = o.rng ?? mulberry32(0xc0f);
    const mat = new MeshBasicNodeMaterial({ color: 0xffffff, side: DoubleSide });
    mat.toneMapped = false;
    this.mesh = new InstancedMesh(new PlaneGeometry(0.16, 0.1), mat, CONFETTI_POOL);
    this.mesh.name = 'confetti-cannons';
    this.mesh.frustumCulled = false;
    const c = new Color();
    for (let i = 0; i < CONFETTI_POOL; i++) {
      this.mesh.setMatrixAt(i, _zero);
      this.mesh.setColorAt(i, c.setHex(COLOURS[i % COLOURS.length]));
    }
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Pieces flying now. */
  get count(): number { return this.live; }

  /** A ring-out at `at`: the two posts nearest it fire. Returns the posts that fired. */
  ringOut(at: { x: number; z: number }): number[] {
    const which = nearestPosts(at, this.posts, 2);
    for (const i of which) this.fire(this.posts[i]);
    return which;
  }

  /** The cannon on the post at angle `a` fires a burst up and in over the ring. */
  fire(a: number): void {
    const r = this.rng, cx = Math.cos(a), cz = Math.sin(a);
    for (let k = 0; k < BURST; k++) {
      const i = this.next, o = i * 3;
      this.next = (this.next + 1) % CONFETTI_POOL;
      if (this.age[i] >= CONFETTI_S) this.live++;
      this.age[i] = 0;
      this.pos[o] = cx * this.postRadius;
      this.pos[o + 1] = MOUTH_Y;
      this.pos[o + 2] = cz * this.postRadius;
      const side = (r() * 2 - 1) * SHOOT_SPREAD, inward = SHOOT_IN * (0.4 + r());
      this.vel[o] = -cx * inward - cz * side;
      this.vel[o + 1] = SHOOT_UP + (r() * 2 - 1) * SHOOT_JITTER;
      this.vel[o + 2] = -cz * inward + cx * side;
      this.spin[o] = (r() * 2 - 1) * 9;
      this.spin[o + 1] = (r() * 2 - 1) * 9;
      this.spin[o + 2] = (r() * 2 - 1) * 9;
    }
    this.mesh.visible = true;
  }

  /** Once a frame: the pieces fly, flutter and spin; spent ones vanish. */
  update(dt: number): void {
    if (!this.live) return;
    const t = Math.max(0, dt), slow = Math.exp(-DRAG * t);
    for (let i = 0; i < CONFETTI_POOL; i++) {
      if (this.age[i] >= CONFETTI_S) continue;
      this.age[i] += t;
      if (this.age[i] >= CONFETTI_S) {
        this.live--;
        this.mesh.setMatrixAt(i, _zero);
        continue;
      }
      const o = i * 3;
      this.vel[o] *= slow;
      this.vel[o + 2] *= slow;
      this.vel[o + 1] = this.vel[o + 1] * slow - FALL * t;
      this.pos[o] += this.vel[o] * t;
      this.pos[o + 1] += this.vel[o + 1] * t;
      this.pos[o + 2] += this.vel[o + 2] * t;
      const age = this.age[i];
      _e.set(this.spin[o] * age, this.spin[o + 1] * age, this.spin[o + 2] * age);
      const k = Math.min(1, (CONFETTI_S - age) / 0.4); // shrinks away at the end
      _m.compose(_p.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]), _q.setFromEuler(_e), _s.set(k, k, k));
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!this.live) this.mesh.visible = false;
  }

  /** Every piece gone (a new round, the ring cleared). */
  clear(): void {
    for (let i = 0; i < CONFETTI_POOL; i++) {
      this.age[i] = CONFETTI_S;
      this.mesh.setMatrixAt(i, _zero);
    }
    this.live = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = false;
  }
}
