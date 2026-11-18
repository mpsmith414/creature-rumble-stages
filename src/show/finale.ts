import {
  AdditiveBlending, CircleGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide, Euler, Group, InstancedMesh, Matrix4, Mesh,
  MeshBasicNodeMaterial, MeshToonNodeMaterial, PlaneGeometry, RingGeometry, SphereGeometry, Vector3, type Quaternion, type Scene,
} from 'three/webgpu';
import { toonGradient } from '../render/toon';

/**
 * The crowning (spec §2.8): a gold crown on the champion's head, a confetti shower and a glow on the platform under it
 * (the spike's crown and Confetti, spike/main.ts and spike/fx.ts). The crown goes where the champion's posed head says
 * every frame, so it stays put through every strut and bob. Allocates nothing per frame.
 */

/** Confetti pieces (one instanced mesh). */
export const CONFETTI = 400;
/** Where the shower starts: within this radius of the champion (× its height, at least 1 m), this high over its head. */
const SHOWER_SPREAD = 1.5, SHOWER_HIGH = 1.2;
/** Confetti settles flat this far over a platform; anything that misses one stops once it is this far down. */
const CONFETTI_REST = 0.015, CONFETTI_GONE = -14;
/**
 * A falling piece is caught by a platform whose top it is at most this far below (m): it falls a few cm a frame, so it
 * never slips past one between frames. A piece lying on a platform that slides away starts falling at this speed (m/s).
 */
const CONFETTI_CATCH = 0.5, CONFETTI_SLIP = 0.01;
const CONFETTI_COLOURS = [0xff4f8b, 0x3ec7ff, 0x7dff5a, 0xffc933, 0xb26bff];
const GOLD = 0xffd23f, GEM = 0xff4f8b, GLOW = 0xffe066;
/** The crown is built for a head of this radius (m) and scaled to the champion's, never smaller than this × its height. */
const CROWN_FOR = 0.35, CROWN_MIN = 0.14;

/**
 * A creature on the stage to crown (its pose is computed): `place` puts where its crown sits now
 * (the top of its head, turned as its head is) into `pos` and `turn` (false: not drawn now), `feet` where it stands;
 * its height (m) and its head's radius (m) size the crown.
 */
export type CrownSpot = {
  place(pos: Vector3, turn: Quaternion): boolean;
  feet(out: Vector3): boolean;
  readonly height: number;
  readonly headR: number;
};

function toon(hex: number): MeshToonNodeMaterial {
  const m = new MeshToonNodeMaterial({ color: hex });
  m.gradientMap = toonGradient();
  return m;
}

/** The spike's crown: an open gold band with five spikes, plus a pink gem on each spike's tip. */
function crownMesh(): Group {
  const g = new Group();
  g.name = 'crown';
  const gold = toon(GOLD);
  gold.side = DoubleSide;
  const band = new Mesh(new CylinderGeometry(0.32, 0.36, 0.22, 16, 1, true), gold);
  band.castShadow = true;
  g.add(band);
  const spikeGeo = new ConeGeometry(0.08, 0.25, 8), gemGeo = new SphereGeometry(0.045, 10, 8), gem = toon(GEM);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const spike = new Mesh(spikeGeo, gold);
    spike.position.set(Math.cos(a) * 0.33, 0.22, Math.sin(a) * 0.33);
    spike.castShadow = true;
    const tip = new Mesh(gemGeo, gem);
    tip.position.y = 0.14;
    spike.add(tip);
    g.add(spike);
  }
  return g;
}

const _t = new Vector3(), _m = new Matrix4(), _e = new Euler();

export class Finale {
  /** Who wears the crown (null before a crowning, or after `clear`): a stage creature's spot. */
  champion: CrownSpot | null = null;
  private readonly crownObj = crownMesh();
  private readonly glow: Group;
  private readonly glowDisc: Mesh;
  private readonly confetti: InstancedMesh;
  private readonly pos = new Float32Array(CONFETTI * 3);
  private readonly vel = new Float32Array(CONFETTI * 3);
  private readonly rot = new Float32Array(CONFETTI * 3);
  private readonly spin = new Float32Array(CONFETTI * 3);
  /** The shower is up: its pieces fall, lie on platforms, and fall again when a moving one slides away under them. */
  private falling = false;
  private clock = 0;
  private readonly rng: () => number;
  /** Where confetti at (x, y, z) lies: the top of the highest platform under it at or below y, or null where it falls away. */
  private readonly floor: (x: number, y: number, z: number) => number | null;

  /**
   * `floor`: the height confetti at (x, y, z) lies at (the highest platform top under it at or below y; null: it falls
   * away; with none given, all of it falls away).
   */
  constructor(private readonly scene: Scene, o: { rng?: () => number; floor?: (x: number, y: number, z: number) => number | null } = {}) {
    this.rng = o.rng ?? Math.random;
    this.floor = o.floor ?? (() => null);
    this.crownObj.visible = false;
    const disc = new MeshBasicNodeMaterial({ color: GLOW, transparent: true, opacity: 0.45, blending: AdditiveBlending, depthWrite: false });
    disc.toneMapped = false;
    const rim = new MeshBasicNodeMaterial({ color: GLOW, transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false });
    rim.toneMapped = false;
    this.glowDisc = new Mesh(new CircleGeometry(1, 48), disc);
    const ring = new Mesh(new RingGeometry(0.92, 1.05, 48), rim);
    this.glow = new Group();
    this.glow.name = 'podium-glow';
    for (const m of [this.glowDisc, ring]) {
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 1;
      this.glow.add(m);
    }
    this.glow.visible = false;

    const paper = new MeshBasicNodeMaterial({ side: DoubleSide });
    paper.toneMapped = false;
    this.confetti = new InstancedMesh(new PlaneGeometry(0.18, 0.28), paper, CONFETTI);
    const c = new Color();
    for (let i = 0; i < CONFETTI; i++) this.confetti.setColorAt(i, c.setHex(CONFETTI_COLOURS[i % CONFETTI_COLOURS.length]));
    this.confetti.name = 'confetti';
    this.confetti.frustumCulled = false; // its pieces fly far from the bounds of one plane
    this.confetti.visible = false;
    scene.add(this.crownObj, this.glow, this.confetti);
  }

  /**
   * Crowns a creature on the stage: the crown where `c.place` says (every frame), a confetti shower over it, the glow
   * under its feet. With `confetti` false (it drops in still wearing its crown after Again!) only the crown.
   */
  crownOn(c: CrownSpot, confetti = true): void {
    this.champion = c;
    this.crownObj.scale.setScalar(Math.max(c.headR, CROWN_MIN * c.height) / CROWN_FOR);
    this.crownObj.visible = c.place(this.crownObj.position, this.crownObj.quaternion);
    if (!confetti) return;
    const size = Math.max(0.6, c.height * 0.8);
    this.glow.scale.set(size, 1, size);
    this.glow.visible = true;
    if (!c.feet(_t)) return;
    this.glow.position.set(_t.x, _t.y + 0.02, _t.z);
    this.burst(_t, c.height, _t.y);
  }

  /** Once a frame: the crown rides the head, the glow follows the champion and pulses, the confetti falls. */
  update(dt: number): void {
    this.clock += dt;
    const c = this.champion;
    if (c) {
      this.crownObj.visible = c.place(this.crownObj.position, this.crownObj.quaternion);
      if (c.feet(_t)) this.glow.position.set(_t.x, _t.y + 0.02, _t.z);
      (this.glowDisc.material as MeshBasicNodeMaterial).opacity = 0.35 + 0.15 * Math.sin(this.clock * 4);
    }
    if (this.falling) this.fall(dt);
  }

  /** Ends the shower and the glow; the champion keeps its crown (the group entrance after "Again!" shows it off). */
  stop(): void {
    this.falling = false;
    this.confetti.visible = false;
    this.glow.visible = false;
  }

  /** Takes everything away, crown too. */
  clear(): void {
    this.stop();
    this.crownObj.visible = false;
    this.champion = null;
  }

  /** Takes it all out of the scene and frees its geometries and materials (the toon gradient is shared and kept). */
  dispose(): void {
    this.clear();
    this.scene.remove(this.crownObj, this.glow, this.confetti);
    const geos = new Set<{ dispose(): void }>(), mats = new Set<{ dispose(): void }>();
    for (const root of [this.crownObj, this.glow, this.confetti]) {
      root.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        geos.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
      });
    }
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    this.confetti.dispose();
  }

  /** A shower raining down round and over the champion (`height` m tall), so it shows in the close champion shot. */
  private burst(at: Vector3, height: number, base = 0): void {
    const r = this.rng, P = this.pos, V = this.vel, S = this.spin, A = this.rot;
    const spread = Math.max(1, SHOWER_SPREAD * height), top = base + height + SHOWER_HIGH;
    for (let i = 0; i < CONFETTI * 3; i += 3) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread;
      P[i] = at.x + Math.cos(a) * d;
      P[i + 1] = top + r() * 3;
      P[i + 2] = at.z + Math.sin(a) * d;
      V[i] = (r() - 0.5) * 4;
      V[i + 1] = r() * 3;
      V[i + 2] = (r() - 0.5) * 4;
      S[i] = r() * 10;
      S[i + 1] = r() * 10;
      S[i + 2] = r() * 10;
      A[i] = A[i + 1] = A[i + 2] = 0;
    }
    this.falling = true;
    this.confetti.visible = true;
    this.fall(0);
  }

  /**
   * Flutters every piece down; a piece reaching a platform lies flat on it, one that misses falls away and stops. A
   * piece lying on a moving platform rides it up, or falls again once it slides away. Pieces lying still cost a look
   * at the platforms and nothing more (their matrices are only sent again when one moved).
   */
  private fall(dt: number): void {
    const P = this.pos, V = this.vel, A = this.rot, S = this.spin, drag = Math.max(0, 1 - 1.5 * dt);
    let changed = false;
    for (let k = 0, i = 0; k < CONFETTI; k++, i += 3) {
      if (dt > 0 && V[i] === 0 && V[i + 1] === 0 && V[i + 2] === 0) {
        // lying still (or gone, far down): is its platform still under it?
        if (P[i + 1] < CONFETTI_GONE) continue;
        const under = this.floor(P[i], P[i + 1] + CONFETTI_CATCH, P[i + 2]);
        const rest = (under ?? -Infinity) + CONFETTI_REST;
        if (Math.abs(rest - P[i + 1]) < 1e-4) continue;
        if (rest > P[i + 1]) {
          P[i + 1] = rest; // its platform rose: it rides up
          this.place(k, i);
          changed = true;
          continue;
        }
        V[i + 1] = -CONFETTI_SLIP; // its platform went: it falls again
      }
      V[i + 1] -= 6 * dt;
      V[i] *= drag; V[i + 1] *= drag; V[i + 2] *= drag;
      P[i] += V[i] * dt; P[i + 1] += V[i + 1] * dt; P[i + 2] += V[i + 2] * dt;
      A[i] += S[i] * dt; A[i + 1] += S[i + 1] * dt; A[i + 2] += S[i + 2] * dt;
      // where it can lie: the platform under it (never one over its head)
      const lie = this.floor(P[i], P[i + 1] + CONFETTI_CATCH, P[i + 2]);
      const rest = (lie ?? 0) + CONFETTI_REST;
      if ((lie !== null && P[i + 1] <= rest) || P[i + 1] < CONFETTI_GONE) {
        if (lie !== null) P[i + 1] = rest;
        V[i] = V[i + 1] = V[i + 2] = 0;
        A[i] = -Math.PI / 2; A[i + 1] = 0; // flat
      }
      this.place(k, i);
      changed = true;
    }
    if (changed) this.confetti.instanceMatrix.needsUpdate = true;
  }

  /** Piece `k` (its values from `i` on) drawn where it is now. */
  private place(k: number, i: number): void {
    const P = this.pos, A = this.rot;
    _m.makeRotationFromEuler(_e.set(A[i], A[i + 1], A[i + 2])).setPosition(P[i], P[i + 1], P[i + 2]);
    this.confetti.setMatrixAt(k, _m);
  }
}
