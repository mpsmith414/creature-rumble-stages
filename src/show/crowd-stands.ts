import {
  BufferGeometry, Color, DoubleSide, Float32BufferAttribute, InstancedMesh, LatheGeometry, Mesh, MeshBasicNodeMaterial, MeshToonNodeMaterial,
  SphereGeometry, Vector2, type Scene,
} from 'three/webgpu';
import { angleDiff, ENTRY_ANGLE } from '../arena/geometry';
import { toonGradient } from '../render/toon';
import { mulberry32 } from '../util/rng';

/**
 * The crowd (wild ring design §5.2): ~240 googly-eyed blobs in six candy colours on low stands round the ball pit. They
 * bob gently, jump on a roar (a big hit, a ring-out, an event's start, the crowning) and now and then do a wave round the
 * ring. `crowdSeats` and `CrowdMotion` are pure (tested headless); `CrowdStands` draws them as two instanced meshes
 * (bodies, eyes) that share one matrix buffer, so a frame writes 240 matrices and nothing else: well under 1 ms.
 */

/** The stands' rows: how far out (m), the height of the row's seat (m), and how far apart the blobs sit (m). */
export const CROWD_ROWS = [
  { r: 15, y: -1.7 }, { r: 16.5, y: -1.0 }, { r: 18, y: -0.3 }, { r: 19.5, y: 0.4 },
] as const;
export const CROWD_SPACING = 1.65;
/** No seats (nor stands) this close (rad) to the entry: the bridge comes in there. */
export const CROWD_GAP = 0.34;
/** The arena's candy colours. */
export const CROWD_COLOURS = [0xff4f8b, 0x3ec7ff, 0x7dff5a, 0xffc933, 0xb26bff, 0xff7a2f];
/** A blob's radius (m) and its height (× that). */
const BLOB_R = 0.46, BLOB_TALL = 1.15;
/** A row's step: this deep (m) either side of its seats. */
const STEP_HALF = 0.75;
/** The stands go down to here (m), into the pit. */
const STANDS_FOOT = -12;

/** A gentle bob: this high (m) at this pace (rad/s). */
export const BOB_H = 0.07, BOB_W = 3.2;
/** A roar's jump: this high (m), this long (s), each blob up to `JUMP_SPREAD` s late (they do not jump as one). */
export const JUMP_H = 0.55, JUMP_S = 0.5, JUMP_SPREAD = 0.3;
/** The wave: round the ring at `WAVE_SPEED` rad/s, `WAVE_WIDTH` rad wide, lifting `WAVE_H` m; the first comes
 * `WAVE_FIRST_MIN`–`WAVE_FIRST_MAX` s in, the next `WAVE_GAP_MIN`–`WAVE_GAP_MAX` s after the last finished. */
export const WAVE_SPEED = 2.4, WAVE_WIDTH = 0.45, WAVE_H = 0.5;
export const WAVE_FIRST_MIN = 10, WAVE_FIRST_MAX = 18, WAVE_GAP_MIN = 18, WAVE_GAP_MAX = 32;
/** A wave lasts one trip round the ring (plus its width, so the last blobs sit down). */
export const WAVE_S = (Math.PI * 2 + WAVE_WIDTH * 2) / WAVE_SPEED;

const TAU = Math.PI * 2;

export type Seat = { x: number; y: number; z: number; angle: number; colour: number; delay: number; bob: number };

/** Every blob's seat: the rows round the pit, leaving the entry clear, each with its colour and its own little lateness. */
export function crowdSeats(entry = ENTRY_ANGLE): Seat[] {
  const rng = mulberry32(0xc0ffee), seats: Seat[] = [];
  CROWD_ROWS.forEach((row, k) => {
    const n = Math.round((Math.PI * 2 * row.r) / CROWD_SPACING);
    for (let i = 0; i < n; i++) {
      const angle = ((i + (k % 2) * 0.5) / n) * Math.PI * 2 - Math.PI;
      if (Math.abs(angleDiff(angle, entry)) < CROWD_GAP) continue;
      seats.push({
        x: Math.cos(angle) * row.r, y: row.y + BLOB_R * BLOB_TALL, z: Math.sin(angle) * row.r, angle,
        colour: Math.floor(rng() * CROWD_COLOURS.length), delay: rng() * JUMP_SPREAD, bob: rng() * Math.PI * 2,
      });
    }
  });
  return seats;
}

/** The crowd's pure motion: a clock, the last roar's jump and the wave. */
export class CrowdMotion {
  t = 0;
  /** When the last roar's jump started (s on `t`). */
  jumpAt = -Infinity;
  /** When the wave under way started, and the angle it started from; when the next starts. */
  waveAt = -Infinity;
  waveFrom = 0;
  nextWave: number;

  constructor(private readonly rng: () => number = mulberry32(0xbeef)) {
    this.nextWave = this.between(WAVE_FIRST_MIN, WAVE_FIRST_MAX);
  }

  /** Once a frame: the clock runs, and a wave starts when its time comes. */
  update(dt: number): void {
    this.t += Math.max(0, dt);
    if (this.t >= this.nextWave) {
      this.waveAt = this.t;
      this.waveFrom = this.rng() * Math.PI * 2 - Math.PI;
      this.nextWave = this.t + WAVE_S + this.between(WAVE_GAP_MIN, WAVE_GAP_MAX);
    }
  }

  /** A roar: everyone jumps (each a little late). */
  cheer(): void { this.jumpAt = this.t; }
  /** A new round or a cleared ring: no jump under way (the wave keeps its own clock). */
  reset(): void { this.jumpAt = -Infinity; }
  /** Whether a wave is going round now. */
  get waving(): boolean { return this.t - this.waveAt < WAVE_S; }

  /** How high (m) the blob in `seat` is lifted now: its bob, a roar's jump and the wave passing it (the highest). */
  lift(seat: Pick<Seat, 'angle' | 'delay' | 'bob'>): number {
    const bob = BOB_H * (0.5 + 0.5 * Math.sin(this.t * BOB_W + seat.bob));
    let up = bob;
    const u = this.t - this.jumpAt - seat.delay;
    if (u >= 0 && u < JUMP_S) up = Math.max(up, JUMP_H * 4 * (u / JUMP_S) * (1 - u / JUMP_S));
    if (this.waving) {
      // the wave's front runs once round from where it started; a blob is lifted as the front passes it
      const travelled = WAVE_SPEED * (this.t - this.waveAt);
      const ahead = (((seat.angle - this.waveFrom) % TAU) + TAU) % TAU; // how far round from the start it sits
      const d = Math.abs(travelled - ahead);
      if (d < WAVE_WIDTH) {
        const k = 1 - d / WAVE_WIDTH;
        up = Math.max(up, WAVE_H * k * k * (3 - 2 * k));
      }
    }
    return up;
  }

  private between(lo: number, hi: number): number {
    return lo + this.rng() * (hi - lo);
  }
}

/** One geometry of several coloured spheres (vertex colours): a blob's two googly eyes, whites and pupils. */
function eyesGeometry(): BufferGeometry {
  const parts = [
    { r: 0.15, at: [-0.16, 0.2, 0.36], c: 0xffffff }, { r: 0.15, at: [0.16, 0.2, 0.36], c: 0xffffff },
    { r: 0.075, at: [-0.15, 0.2, 0.5], c: 0x1a1030 }, { r: 0.075, at: [0.15, 0.21, 0.5], c: 0x1a1030 },
  ];
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  const c = new Color();
  for (const p of parts) {
    const s = new SphereGeometry(p.r, 10, 8), base = pos.length / 3;
    const sp = s.getAttribute('position'), sn = s.getAttribute('normal');
    c.setHex(p.c);
    for (let i = 0; i < sp.count; i++) {
      pos.push(sp.getX(i) + p.at[0], sp.getY(i) + p.at[1], sp.getZ(i) + p.at[2]);
      nor.push(sn.getX(i), sn.getY(i), sn.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    const si = s.getIndex()!;
    for (let i = 0; i < si.count; i++) idx.push(si.getX(i) + base);
    s.dispose();
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** The stands' stepped profile (radius, height), from the pit's floor up over every row and back down behind. */
function standsProfile(): Vector2[] {
  const pts = [new Vector2(CROWD_ROWS[0].r - STEP_HALF, STANDS_FOOT)];
  for (const row of CROWD_ROWS) {
    pts.push(new Vector2(row.r - STEP_HALF, row.y), new Vector2(row.r + STEP_HALF, row.y));
  }
  const last = CROWD_ROWS[CROWD_ROWS.length - 1];
  pts.push(new Vector2(last.r + STEP_HALF, STANDS_FOOT));
  return pts;
}

export class CrowdStands {
  readonly motion: CrowdMotion;
  readonly seats: Seat[];
  readonly bodies: InstancedMesh;
  readonly eyes: InstancedMesh;
  readonly stands: Mesh;
  /** Each blob's facing (toward the ring's middle), as its matrix's cos and sin. */
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;

  constructor(scene: Scene, o: { entry?: number; rng?: () => number } = {}) {
    const entry = o.entry ?? ENTRY_ANGLE;
    this.motion = new CrowdMotion(o.rng);
    this.seats = crowdSeats(entry);
    const n = this.seats.length;

    // the stands: one stepped ring round the pit (a lathe), open at the entry
    const standMat = new MeshToonNodeMaterial({ color: 0x7a3fe0 });
    standMat.gradientMap = toonGradient();
    standMat.side = DoubleSide;
    // lathe angle φ puts a point at atan2(z, x) = π/2 − φ: start just past the gap, go round to its other side
    const len = Math.PI * 2 - 2 * CROWD_GAP;
    this.stands = new Mesh(new LatheGeometry(standsProfile(), 96, Math.PI / 2 - (entry + CROWD_GAP + len), len), standMat);
    this.stands.name = 'stands';
    this.stands.receiveShadow = false;

    const bodyMat = new MeshToonNodeMaterial({ color: 0xffffff });
    bodyMat.gradientMap = toonGradient();
    const bodyGeo = new SphereGeometry(BLOB_R, 14, 10);
    bodyGeo.scale(1, BLOB_TALL, 1);
    this.bodies = new InstancedMesh(bodyGeo, bodyMat, n);
    this.bodies.name = 'crowd';
    const eyeMat = new MeshBasicNodeMaterial({ vertexColors: true });
    this.eyes = new InstancedMesh(eyesGeometry(), eyeMat, n);
    this.eyes.name = 'crowd-eyes';
    this.eyes.instanceMatrix = this.bodies.instanceMatrix; // the eyes ride their blob: one buffer, written once
    this.bodies.frustumCulled = this.eyes.frustumCulled = false;

    this.cos = new Float32Array(n);
    this.sin = new Float32Array(n);
    const c = new Color();
    this.seats.forEach((s, i) => {
      const yaw = Math.atan2(-s.x, -s.z); // its front (+z) toward the middle
      this.cos[i] = Math.cos(yaw);
      this.sin[i] = Math.sin(yaw);
      this.bodies.setColorAt(i, c.setHex(CROWD_COLOURS[s.colour]));
    });
    this.write();
    scene.add(this.stands, this.bodies, this.eyes);
  }

  /** Once a frame: everyone bobs, jumps or waves. */
  update(dt: number): void {
    this.motion.update(dt);
    this.write();
  }

  cheer(): void { this.motion.cheer(); }
  reset(): void { this.motion.reset(); }

  /** Every blob's matrix (turned to face the middle, lifted, a little stretched on the way up). */
  private write(): void {
    const m = this.bodies.instanceMatrix.array, seats = this.seats;
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i], up = this.motion.lift(s), o = i * 16;
      const stretch = 1 + (up > BOB_H ? 0.25 * Math.min(1, up / JUMP_H) : 0), squeeze = 1 / Math.sqrt(stretch);
      const c = this.cos[i] * squeeze, sn = this.sin[i] * squeeze;
      m[o] = c; m[o + 1] = 0; m[o + 2] = -sn; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = stretch; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = sn; m[o + 9] = 0; m[o + 10] = c; m[o + 11] = 0;
      m[o + 12] = s.x; m[o + 13] = s.y + up; m[o + 14] = s.z; m[o + 15] = 1;
    }
    this.bodies.instanceMatrix.needsUpdate = true;
  }
}
