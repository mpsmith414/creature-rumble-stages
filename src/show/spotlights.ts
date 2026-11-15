import { CircleGeometry, Color, InstancedMesh, MeshBasicNodeMaterial, type Scene } from 'three/webgpu';
import { float, smoothstep, uv } from 'three/tsl';

/**
 * The sweeping spotlights (wild ring design §5.2): coloured pools of light gliding over the ring's floor. Cheap: soft
 * see-through discs lying on the floor (one instanced mesh, one draw call), not real lights. (Added light washed out to
 * white on the pale candy floor; a tint reads as a coloured pool.) They glide faster while a
 * ring event runs. `spotAt` is the pure path (tested headless).
 */

/** Pools on the floor, and their colours (the arena's pink, sky, lemon and green). */
export const SPOT_COUNT = 4;
export const SPOT_COLOURS = [0xff4f8b, 0x3ec7ff, 0xffc933, 0x7dff5a];
/** How fast the pools glide (their path's clock, per s), × `SPOT_FAST` while a ring event runs. */
export const SPOT_SPEED = 0.32, SPOT_FAST = 2.6;
/** A pool's radius (m), and how far out its middle wanders (× the ring's radius, at most), so it stays on the floor. */
export const SPOT_RADIUS = 1.6, SPOT_REACH = 0.62;
/** How strongly a pool tints the floor at its middle (opacity), and how far over the floor it lies (m). */
const SPOT_STRENGTH = 0.55, SPOT_LIFT = 0.012;

/**
 * Pool `i`'s middle at path clock `phase` on a ring `ringRadius` m round, into `out` (y = 0): each circles at its own
 * pace and swings in and out, the four spread round the ring, always within `SPOT_REACH` × the radius.
 */
export function spotAt(i: number, phase: number, ringRadius: number, out: { x: number; z: number }): { x: number; z: number } {
  const turn = (i % 2 ? -1 : 1) * (1 + i * 0.13); // neighbours circle opposite ways
  const a = phase * turn + (i * Math.PI) / 2;
  const swing = 0.5 + 0.5 * Math.sin(phase * (1.7 + i * 0.21) + i * 1.3); // 0 … 1
  const r = ringRadius * SPOT_REACH * (0.3 + 0.7 * swing);
  out.x = Math.cos(a) * r;
  out.z = Math.sin(a) * r;
  return out;
}

/** The pools' clock: it runs at `SPOT_SPEED` a second, `SPOT_FAST` × that in an event (never a jump: only its pace changes). */
export class SpotClock {
  phase = 0;
  update(dt: number, fast: boolean): number {
    return (this.phase += Math.max(0, dt) * SPOT_SPEED * (fast ? SPOT_FAST : 1));
  }
}

const _p = { x: 0, z: 0 };

export class Spotlights {
  readonly clock = new SpotClock();
  readonly mesh: InstancedMesh;

  constructor(scene: Scene, private readonly ringRadius: number) {
    const geo = new CircleGeometry(SPOT_RADIUS, 40);
    geo.rotateX(-Math.PI / 2);
    const mat = new MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
    // a soft pool in its instance colour: strongest in the middle, gone at the edge
    const d = uv().sub(0.5).length().mul(2);
    mat.opacityNode = float(SPOT_STRENGTH).mul(float(1).sub(smoothstep(0.3, 1, d)));
    mat.toneMapped = false;
    this.mesh = new InstancedMesh(geo, mat, SPOT_COUNT);
    this.mesh.name = 'spotlights';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    const c = new Color();
    for (let i = 0; i < SPOT_COUNT; i++) this.mesh.setColorAt(i, c.setHex(SPOT_COLOURS[i]));
    this.place();
    scene.add(this.mesh);
  }

  /** Once a frame: the pools glide on (faster in an event). */
  update(dt: number, fast: boolean): void {
    this.clock.update(dt, fast);
    this.place();
  }

  private place(): void {
    const m = this.mesh.instanceMatrix.array;
    for (let i = 0; i < SPOT_COUNT; i++) {
      spotAt(i, this.clock.phase, this.ringRadius, _p);
      const o = i * 16;
      m.fill(0, o, o + 16);
      m[o] = m[o + 5] = m[o + 10] = m[o + 15] = 1;
      m[o + 12] = _p.x;
      m[o + 13] = SPOT_LIFT + i * 0.002; // never two pools in one plane (no flicker where they overlap)
      m[o + 14] = _p.z;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
