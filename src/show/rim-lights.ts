import { Color, InstancedMesh, MeshBasicNodeMaterial, SphereGeometry, type Scene } from 'three/webgpu';
import { angleDiff, BUMPER_TUBE } from '../arena/geometry';

/**
 * The bumper's rim lights (wild ring design §5.2): a string of candy-coloured light blobs round the bumper whose bright
 * band chases round the ring, flashes white on a hit, runs fast during a ring event and turns gold at the crowning.
 * `RimState` is the pure state (tested headless); `RimLights` draws it as one instanced mesh (one draw call), writing
 * only the colours each frame.
 */

/** Light blobs round the bumper. */
export const RIM_COUNT = 56;
/** The chase moves this many lights a second, × `RIM_FAST` while a ring event runs. */
export const RIM_CHASE = 7, RIM_FAST = 3.5;
/** The chase pattern repeats every `RIM_BAND` lights, `RIM_LIT` of them bright; an unlit blob glows at `RIM_DIM`. */
export const RIM_BAND = 8, RIM_LIT = 3, RIM_DIM = 0.45;
/**
 * A hit's white flash lasts this long (s), fading out. A plain hit flashes the lights on its side of the ring (within
 * `RIM_FLASH_SPAN` rad of it, softening away), a big one the whole rim: hits come so often that a whole-rim flash on every
 * one kept the rim white and hid the chase.
 */
export const RIM_FLASH_S = 0.35, RIM_FLASH_SPAN = Math.PI / 3;
/** The blobs' candy colours (the arena's), round the ring in turn, and the crowning's gold. */
export const RIM_COLOURS = [0xff4f8b, 0x3ec7ff, 0xffc933, 0x7dff5a, 0xb26bff, 0xff7a2f];
export const RIM_GOLD = 0xffd23f;
/** A blob's radius (m). */
const RIM_BLOB = 0.11;

/** The rim lights' pure state: where the chase is, how much white flash is left, and whether they are gold. */
export class RimState {
  /** The chase's position round the ring, in lights (0 … RIM_COUNT). */
  phase = 0;
  /** Seconds of white flash left. */
  flash = 0;
  /** Where round the ring (rad) the last flash is, or null when it is the whole rim. */
  flashAt: number | null = null;
  /** Gold (the crowning) until `reset`. */
  gold = false;

  /** Once a frame: the chase moves on (fast while an event runs) and the flash fades. */
  update(dt: number, fast: boolean): void {
    const step = Math.max(0, dt) * RIM_CHASE * (fast ? RIM_FAST : 1);
    this.phase = (this.phase + step) % RIM_COUNT;
    this.flash = Math.max(0, this.flash - Math.max(0, dt));
  }

  /** A hit at angle `at` round the ring (rad) flashes that side; with no angle (a big hit) the whole rim flashes. */
  hit(at: number | null = null): void {
    // a plain hit never shrinks a whole-rim flash still showing
    if (at !== null && this.flashAt === null && this.flash > RIM_FLASH_S / 2) return;
    this.flash = RIM_FLASH_S;
    this.flashAt = at;
  }
  /** The crowning: gold. */
  crown(): void { this.gold = true; }
  /** A new round or a cleared ring: candy colours, no flash. */
  reset(): void {
    this.gold = false;
    this.flash = 0;
    this.flashAt = null;
  }

  /** How bright light `i` is (RIM_DIM … 1): bright where the chase's lit band is, with soft ends. */
  level(i: number): number {
    const u = (((i - this.phase) % RIM_BAND) + RIM_BAND) % RIM_BAND; // 0 … RIM_BAND, how far behind the band's front
    // the lit band is RIM_LIT lights long, brightest in its middle light
    const d = Math.abs(u - (RIM_LIT - 1) / 2) / ((RIM_LIT + 1) / 2);
    const k = Math.max(0, 1 - d);
    return RIM_DIM + (1 - RIM_DIM) * k * k * (3 - 2 * k);
  }

  /** How white light `i` is now (0 … 1): the flash, eased out, softening away from where the hit was. */
  white(i: number): number {
    const u = this.flash / RIM_FLASH_S;
    if (u <= 0) return 0;
    if (this.flashAt === null) return u * u;
    const d = Math.abs(angleDiff((i / RIM_COUNT) * Math.PI * 2, this.flashAt));
    const k = Math.max(0, 1 - d / RIM_FLASH_SPAN);
    return u * u * k;
  }

  /** Light `i`'s colour now, into `out`: its candy colour (or gold), toward white by the flash, × its level. */
  colour(i: number, out: Color): Color {
    const w = this.white(i);
    out.setHex(this.gold ? RIM_GOLD : RIM_COLOURS[i % RIM_COLOURS.length]);
    out.lerp(WHITE, w);
    return out.multiplyScalar(Math.max(this.level(i), w));
  }
}
const WHITE = new Color(1, 1, 1);

/** Where light `i` sits on a bumper `height` m tall round a ring `ringRadius` m: on its upper outer face. */
export function rimSpot(i: number, ringRadius: number, height: number): { x: number; y: number; z: number } {
  const a = (i / RIM_COUNT) * Math.PI * 2;
  // the torus's tube at 45° up its outer side (the tube is squashed to span 0 … height)
  const r = ringRadius + 0.15 + BUMPER_TUBE * Math.SQRT1_2 + RIM_BLOB * 0.4;
  return { x: Math.cos(a) * r, y: height / 2 + (height / 2) * Math.SQRT1_2 + RIM_BLOB * 0.3, z: Math.sin(a) * r };
}

const _c = new Color();

export class RimLights {
  readonly state = new RimState();
  readonly mesh: InstancedMesh;
  private shownHeight = NaN;

  constructor(scene: Scene, private readonly ringRadius: number) {
    const mat = new MeshBasicNodeMaterial({ color: 0xffffff });
    mat.toneMapped = false;
    this.mesh = new InstancedMesh(new SphereGeometry(RIM_BLOB, 10, 8), mat, RIM_COUNT);
    this.mesh.name = 'rim-lights';
    this.mesh.frustumCulled = false;
    for (let i = 0; i < RIM_COUNT; i++) this.mesh.setColorAt(i, this.state.colour(i, _c));
    scene.add(this.mesh);
  }

  /** Once a frame: the chase moves (fast in an event), the colours are written; they follow the bumper's height. */
  update(dt: number, fast: boolean, bumper: number): void {
    if (bumper !== this.shownHeight) this.place(bumper);
    this.state.update(dt, fast);
    if (!this.mesh.visible) return;
    for (let i = 0; i < RIM_COUNT; i++) this.mesh.setColorAt(i, this.state.colour(i, _c));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private place(h: number): void {
    this.shownHeight = h;
    this.mesh.visible = h > 0; // no bumper, no lights
    const m = this.mesh.instanceMatrix.array;
    for (let i = 0; i < RIM_COUNT; i++) {
      const p = rimSpot(i, this.ringRadius, h), o = i * 16;
      m.fill(0, o, o + 16);
      m[o] = m[o + 5] = m[o + 10] = m[o + 15] = 1;
      m[o + 12] = p.x;
      m[o + 13] = p.y;
      m[o + 14] = p.z;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
