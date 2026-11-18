import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, Euler, ExtrudeGeometry,
  Group, InstancedMesh, Matrix3, Matrix4, Mesh, MeshBasicNodeMaterial, MeshToonNodeMaterial, type Object3D, Quaternion,
  Shape, SphereGeometry, TorusGeometry, Vector3, type Material,
} from 'three/webgpu';
import { attribute, color, float, fract, mix, positionWorld, sin, smoothstep, uniform, vertexColor } from 'three/tsl';
import { toonGradient } from '../../render/toon';
import { untone } from '../../render/tone';
import type { MischiefCue, MischiefName, TrainBox } from '../../stage/mischief';

/**
 * What every level's scenery is built from: the shape it hands the show, a way to merge many little shapes into one
 * mesh (one draw call: a whole jungle backdrop is one), the two materials, and a clock for the mischief's looks.
 *
 * Colours are picked as they should look on the TV. The tone mapping pales them (`render/tone.ts`), so they are drawn
 * through `untone`: unlit scenery exactly (its light and shade are baked into its colours from one fixed sun, so it
 * looks the same under any lights), the lit platforms for about the light the stage's sun and sky give them.
 */

/** What the scenery shows of the mischief now, for tests and the show: how open each airlock is, the low-gravity tint. */
export type SceneryState = { airlock: { left: number; right: number }; tint: number };

/**
 * The live mischief the scenery reads (the fight's `sim.mischief`): which one is under way, its side (the way the river
 * flows, the airlock pulls, the train first runs), its start and end, and the toy train.
 */
export type MischiefView = {
  readonly active: MischiefName | null;
  readonly side: 1 | -1;
  readonly startT: number;
  readonly endT: number;
  train(out: TrainBox): TrainBox | null;
};

/**
 * A level's 3D scenery: `root` (add it to the scene), `update(t, cues, live?)` once a frame with the level time (the
 * moving platforms go where `platformsAt` has them, the mischief's looks come and go with its cues; `live`, the fight's
 * mischief, tells which way and where the train is), `state()` and `dispose()` (frees everything it built and leaves
 * the scene). Everything is placed by time alone: the same `t` always looks the same.
 */
export type LevelScenery = {
  root: Group;
  update(t: number, cues: readonly MischiefCue[], live?: MischiefView): void;
  state(): SceneryState;
  dispose(): void;
};

/** About how many times over the stage's sun and sky light a platform's top (`untone`'s `light` for lit surfaces). */
export const PLATFORM_LIGHT = 1.15;
/** A glowing part of a lit mesh shines this much on top of its lit colour (× its colour). */
const GLOW_GAIN = 1.2;

/**
 * The fixed sun the unlit scenery's shade is baked from (upper left, in front, like the stage's sun): a surface facing
 * the camera or the sky shows its full colour, one turned away to the right or down darkens to BAKE_DARK.
 */
const BAKE_SUN = new Vector3(-0.35, 0.85, 0.4).normalize();
const BAKE_DARK = 0.62, BAKE_FULL = 0.82, BAKE_SLOPE = 0.45;
/** Baked shades are rounded to this step (so colours are shared). */
const SHADE_STEP = 0.02;

/** How a shape is coloured: a hex as it should look on the TV, or a function giving the colour to draw per vertex. */
export type Paint = string | ((at: Vector3, normal: Vector3, out: Color) => Color);

const _m3 = new Matrix3(), _p = new Vector3(), _n = new Vector3(), _c = new Color();

/**
 * Many shapes merged into one geometry (one draw call). `flat` shapes get their shade baked from the fixed sun and are
 * drawn unlit; `lit` ones keep their plain colour for the lights (with a `glow` share each that shines on its own).
 */
export class Batch {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly glow: number[] = [];
  private readonly idx: number[] = [];

  constructor(readonly kind: 'flat' | 'lit') {}

  /** Adds `geo` placed by `m`, painted `paint`, glowing `glow` (lit only). */
  add(geo: BufferGeometry, m: Matrix4, paint: Paint, glow = 0): this {
    const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal'), index = geo.index;
    const base = this.pos.length / 3;
    _m3.getNormalMatrix(m);
    for (let i = 0; i < pos.count; i++) {
      _p.fromBufferAttribute(pos, i).applyMatrix4(m);
      _n.fromBufferAttribute(nor, i).applyMatrix3(_m3).normalize();
      this.pos.push(_p.x, _p.y, _p.z);
      this.nor.push(_n.x, _n.y, _n.z);
      let c: Color;
      if (typeof paint === 'function') c = paint(_p, _n, _c);
      else if (this.kind === 'flat') c = untone(paint, bakedShade(_n));
      else c = untone(paint, 1, PLATFORM_LIGHT);
      this.col.push(c.r, c.g, c.b);
      this.glow.push(glow);
    }
    // a placement that mirrors (a negative scale) turns the triangles round: wind them back
    const flip = m.determinant() < 0;
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
        this.idx.push(base + a, base + (flip ? c : b), base + (flip ? b : c));
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) this.idx.push(base + i, base + (flip ? i + 2 : i + 1), base + (flip ? i + 1 : i + 2));
    }
    return this;
  }

  /** The merged geometry (bounding box and sphere computed). */
  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    if (this.kind === 'lit') g.setAttribute('glow', new BufferAttribute(new Float32Array(this.glow), 1));
    const n = this.pos.length / 3;
    g.setIndex(new BufferAttribute(n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** The baked shade of a surface facing `n` (unit): full facing the camera or up, BAKE_DARK facing away. */
function bakedShade(n: Vector3): number {
  const k = Math.min(1, Math.max(BAKE_DARK, BAKE_FULL + BAKE_SLOPE * n.dot(BAKE_SUN)));
  return Math.round(k / SHADE_STEP) * SHADE_STEP;
}

const _q = new Quaternion(), _e = new Euler(), _at = new Vector3(), _size = new Vector3(), _mat = new Matrix4();

/**
 * A placement: at (x, y, z), scaled (sx, sy, sz), turned (rx, ry, rz radians, in that order). Returns a shared matrix:
 * use it at once (Batch.add copies what it needs).
 */
export function at(x: number, y: number, z: number, sx = 1, sy = sx, sz = sx, rx = 0, ry = 0, rz = 0): Matrix4 {
  return _mat.compose(_at.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _size.set(sx, sy, sz));
}

/**
 * The unit shapes a level is built from, made once per build and freed once it is merged: a box 1 a side, balls of
 * radius 1 (smooth and plain), a cylinder and a hexagonal prism (radius 1, 1 tall, along y), a cone (radius 1, 1 tall,
 * point up) and a blunt hexagonal one (a crayon's tip), a torus (ring radius 1, tube 0.25), a five-pointed star and a
 * four-pointed sparkle (1 across, flat in xy).
 */
export class Shapes {
  readonly box = new BoxGeometry(1, 1, 1);
  readonly ball = new SphereGeometry(1, 14, 10);
  readonly lowBall = new SphereGeometry(1, 8, 6);
  readonly cyl = new CylinderGeometry(1, 1, 1, 14);
  readonly hex = new CylinderGeometry(1, 1, 1, 6);
  readonly cone = new ConeGeometry(1, 1, 10);
  readonly hexTip = new CylinderGeometry(0.25, 1, 1, 6);
  readonly torus = new TorusGeometry(1, 0.25, 8, 20);
  readonly star = starGeometry(5, 0.5, 0.21, 0.12);
  readonly sparkle = starGeometry(4, 0.5, 0.12, 0.04);

  dispose(): void {
    for (const g of Object.values(this)) (g as BufferGeometry).dispose();
  }
}

/** A puffy star or sparkle with `points` points (outer radius r, inner ri), `depth` thick, centred, facing +z. */
export function starGeometry(points: number, r: number, ri: number, depth: number): BufferGeometry {
  const s = new Shape();
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2, k = i % 2 ? ri : r;
    if (i === 0) s.moveTo(Math.cos(a) * k, Math.sin(a) * k);
    else s.lineTo(Math.cos(a) * k, Math.sin(a) * k);
  }
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** A lit cartoon material for merged lit shapes: their vertex colours in the toon bands, their glow shining on its own. */
export function litMaterial(): MeshToonNodeMaterial {
  const m = new MeshToonNodeMaterial({ vertexColors: true });
  m.gradientMap = toonGradient();
  (m as unknown as { emissiveNode: unknown }).emissiveNode = vertexColor().rgb.mul(attribute('glow', 'float')).mul(GLOW_GAIN);
  return m;
}

/** An unlit material for merged flat shapes (their colours already hold their shade); its `color` tints them all. */
export function flatMaterial(double = false): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ vertexColors: true });
  if (double) m.side = DoubleSide;
  return m;
}

/**
 * Cartoon water: bands of `deep` and `light` water with white foam crests. Along `x` the bands run sideways in the world
 * and `flow` moves them (set it to speed × time: they move at that speed, the way its sign says); along `y` they fall
 * (a waterfall: `flow` growing moves them down). Unlit; colours as on the TV; seen from both sides.
 */
export function waterMaterial(deep: string, light: string, foam: string, axis: 'x' | 'y', band = 2.2) {
  const flow = uniform(0);
  const along = axis === 'x' ? positionWorld.x.sub(flow) : positionWorld.y.add(flow);
  const wobble = sin((axis === 'x' ? positionWorld.z : positionWorld.x).mul(0.9).add(positionWorld.y.mul(1.3))).mul(0.18);
  const f = fract(along.div(band).add(wobble));
  const k = smoothstep(0.25, 0.5, f).sub(smoothstep(0.75, 0.95, f));
  const crest = smoothstep(0.86, 0.93, f).sub(smoothstep(0.93, 0.99, f));
  const m = new MeshBasicNodeMaterial();
  m.colorNode = mix(mix(color(untone(deep)), color(untone(light)), k), color(untone(foam)), crest.mul(float(0.9)));
  m.side = DoubleSide;
  return { material: m, flow };
}

/** A mesh of `batch`, named, never casting shadows. */
export function meshOf(batch: Batch, material: Material, name: string): Mesh {
  const mesh = new Mesh(batch.build(), material);
  mesh.name = name;
  mesh.castShadow = false;
  return mesh;
}

/** An instanced mesh of `geo` × n, every instance hidden (scale 0) at first; never culled (its instances move). */
export function instanced(geo: BufferGeometry, material: Material, n: number, name: string): InstancedMesh {
  const im = new InstancedMesh(geo, material, n);
  im.name = name;
  im.frustumCulled = false;
  im.castShadow = false;
  const zero = new Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < n; i++) im.setMatrixAt(i, zero);
  im.instanceMatrix.needsUpdate = true;
  return im;
}

/** One geometry from a batch of `shapes`, for an instanced mesh (the unit shapes freed after). */
export function geometryOf(kind: 'flat' | 'lit', fill: (b: Batch, s: Shapes) => void): BufferGeometry {
  const s = new Shapes(), b = new Batch(kind);
  fill(b, s);
  s.dispose();
  return b.build();
}

/**
 * Builds a scenery's `dispose`: frees every geometry under `root`, every instanced mesh's instance buffers and every
 * material listed, and takes `root` out of the scene. (The shared toon gradient is kept.)
 */
export function disposer(root: Object3D, materials: Material[]): () => void {
  return () => {
    const geos = new Set<BufferGeometry>();
    root.traverse((o) => {
      if (o instanceof Mesh) geos.add(o.geometry as BufferGeometry);
      if (o instanceof InstancedMesh) o.dispose(); // its instance buffers
    });
    for (const g of geos) g.dispose();
    for (const m of materials) m.dispose();
    root.removeFromParent();
  };
}

/** A level time fit to use: a broken one counts as 0. */
export const safeTime = (t: number) => (Number.isFinite(t) ? t : 0);

/** Clamped to 0 … 1. */
export const unit = (x: number) => Math.min(1, Math.max(0, x));
/** Eased in and out over 0 … 1. */
export const ease = (x: number) => {
  const k = unit(x);
  return k * k * (3 - 2 * k);
};

/**
 * When each mischief started and ended (level time), from its cues and the live mischief: how much of its look shows
 * at a time (`level`, 0 … 1, faded in over `fadeIn` s from its start and out over `fadeOut` s after its end).
 */
export class MischiefClock {
  private readonly from = new Map<MischiefName, number>();
  private readonly to = new Map<MischiefName, number>();

  /** Takes this frame's cues and the live mischief at level time `t`. */
  take(t: number, cues: readonly MischiefCue[], live?: MischiefView): void {
    for (const c of cues) {
      if (c.phase === 'start') {
        this.from.set(c.name, live?.active === c.name ? live.startT : t);
        this.to.set(c.name, Infinity);
      } else this.to.set(c.name, live && !live.active && live.endT <= t ? live.endT : t); // the planned end, if passed
    }
    if (!live) return;
    // a scenery made while one is under way, or a cue missed: the live mischief has the last word
    if (live.active && this.to.get(live.active) !== Infinity) {
      this.from.set(live.active, live.startT);
      this.to.set(live.active, Infinity);
    }
    for (const [name, end] of this.to) if (end === Infinity && live.active !== name) this.to.set(name, t);
  }

  /** How much of `name`'s look shows at `t`. */
  level(name: MischiefName, t: number, fadeIn: number, fadeOut: number): number {
    const a = this.from.get(name);
    if (a === undefined || t < a) return 0;
    const b = this.to.get(name) ?? Infinity;
    return ease((t - a) / fadeIn) * (1 - ease((t - b) / fadeOut));
  }

  /** Whether `name` is under way at `t` (started and not yet ended). */
  on(name: MischiefName, t: number): boolean {
    const a = this.from.get(name);
    return a !== undefined && t >= a && t < (this.to.get(name) ?? Infinity);
  }

  /** When `name` last started (−Infinity if never). */
  since(name: MischiefName): number {
    return this.from.get(name) ?? -Infinity;
  }
}

/** A colour as on the TV with no shade baked in (for things painted flat: a sun, a sticker, a sign). */
export function plain(hex: string): Paint {
  const c = untone(hex);
  return (_p, _n, out) => out.copy(c);
}

/** A vertical gradient by world height: `stops` (height, hex as on the TV), lowest first. A Paint for flat batches. */
export function gradient(stops: readonly (readonly [number, string])[]): Paint {
  const cols = stops.map(([y, hex]) => [y, untone(hex)] as const);
  return (p, _n, out) => {
    if (p.y <= cols[0][0]) return out.copy(cols[0][1]);
    for (let i = 1; i < cols.length; i++) {
      if (p.y <= cols[i][0]) {
        const k = (p.y - cols[i - 1][0]) / (cols[i][0] - cols[i - 1][0]);
        return out.copy(cols[i - 1][1]).lerp(cols[i][1], k);
      }
    }
    return out.copy(cols[cols.length - 1][1]);
  };
}

/** A big backdrop plane at depth `z` covering any view the camera can show, painted `paint`, split `rows` times up. */
export function addBackdrop(b: Batch, z: number, cx: number, cy: number, paint: Paint, rows = 24): void {
  const g = new BufferGeometry();
  const W = 460, H = 260, cols = 2;
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      pos.push(cx - W / 2 + (c / cols) * W, cy - H / 2 + (r / rows) * H, z);
      nor.push(0, 0, 1);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c, bb = a + 1, d = a + cols + 1, e = d + 1;
      idx.push(a, bb, e, a, e, d);
    }
  }
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  g.setIndex(idx);
  b.add(g, new Matrix4(), paint);
  g.dispose();
}

/** A small seeded random number source for laying scenery out (the same layout every time). */
export { mulberry32 as layoutRng } from '../../util/rng';

/**
 * A platform as drawn: a group named `platform:<id>` holding one lit mesh (filled by `fill` with the platform's top
 * centre at the origin: its top at y = 0, its sides at x = ±w/2), catching the creatures' shadows and casting none
 * (a thin platform's shadow lay on the stage as a dark bar). Its place is set by the scenery's update.
 */
export function platformGroup(id: string, material: Material, fill: (b: Batch, s: Shapes) => void): Group {
  const g = new Group();
  g.name = `platform:${id}`;
  const mesh = new Mesh(geometryOf('lit', fill), material);
  mesh.name = `platform-mesh:${id}`;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  g.add(mesh);
  return g;
}

/** Adds a rod (a cylinder of radius `r`) from `a` to `b` to a batch. */
export function rod(b: Batch, s: Shapes, a: Vector3, c: Vector3, r: number, paint: Paint, glow = 0): void {
  const d = _rodD.subVectors(c, a), len = d.length();
  _rodQ.setFromUnitVectors(_rodUp, d.normalize());
  _mat.compose(_rodMid.addVectors(a, c).multiplyScalar(0.5), _rodQ, _size.set(r, len, r));
  b.add(s.cyl, _mat, paint, glow);
}
const _rodD = new Vector3(), _rodQ = new Quaternion(), _rodUp = new Vector3(0, 1, 0), _rodMid = new Vector3();

/** A point, for `rod`. */
export const v3 = (x: number, y: number, z: number) => new Vector3(x, y, z);
