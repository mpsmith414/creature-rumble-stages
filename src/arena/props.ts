import {
  type BufferGeometry, CircleGeometry, Color, CylinderGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicNodeMaterial, MeshToonNodeMaterial, Shape, ShapeGeometry, SphereGeometry,
  TorusGeometry, type Scene,
} from 'three/webgpu';
import { toonGradient } from '../render/toon';
import { BALL_R, PAD_RADIUS, POST_H, POST_RADIUS, type Pad, type Post } from './features';

/**
 * The wild ring's props drawn (design 2026-11-14 §5.2) from `RingFeatures`' state, touching nothing in the physics: the
 * spring pads (a springy disc with a star that glows and bobs while armed, squashes and springs when it fires), the
 * Pinball posts (mushroom bumpers that rise from the floor and flash on a ding) and the beach ball (striped, with a
 * blob shadow). The motion curves are pure and exported (tested headless).
 */

/** What the props read: the features' pads, posts and ball (a structural view, so a test can hand in plain objects). */
export type PropsView = {
  readonly pads: readonly Pad[];
  readonly posts: readonly Post[];
  readonly ball: { readonly body: { translation(): { x: number; y: number; z: number }; rotation(): { x: number; y: number; z: number; w: number } }; readonly radius: number } | null;
};

/** An armed pad's cushion bobs this high (m) at this pace (rad/s), and glows between `PAD_GLOW_LO` and `PAD_GLOW_HI`. */
export const PAD_BOB = 0.035, PAD_BOB_W = 4, PAD_GLOW_LO = 0.25, PAD_GLOW_HI = 0.6;
/** A firing pad squashes to `PAD_SQUASH` of its height, then springs (a damped wobble at `PAD_SPRING_W` rad/s, dying at `PAD_SPRING_DAMP`/s) over `PAD_SPRING_S` s. */
export const PAD_SQUASH = 0.3, PAD_SPRING_W = 22, PAD_SPRING_DAMP = 5.5, PAD_SPRING_S = 0.9;
/** A ding's flash lasts this long (s). */
export const POST_FLASH_S = 0.3;

/** A firing pad's cushion height (× its rest height) `age` s after it fired: squashed, then springing back with a wobble. */
export function padSpring(age: number): number {
  if (!(age >= 0) || age >= PAD_SPRING_S) return 1;
  return 1 - (1 - PAD_SQUASH) * Math.exp(-age * PAD_SPRING_DAMP) * Math.cos(age * PAD_SPRING_W);
}

/** How strongly a pad glows (0 … 1): pulsing while armed, a faint glow growing with its charge while it recharges. */
export function padGlow(pad: Pick<Pad, 'armed' | 'charge'>, t: number, i: number): number {
  if (!pad.armed) return 0.12 * Math.min(1, Math.max(0, pad.charge));
  return PAD_GLOW_LO + (PAD_GLOW_HI - PAD_GLOW_LO) * (0.5 + 0.5 * Math.sin(t * PAD_BOB_W + i * 1.7));
}

/** How far up (m) an armed pad's cushion bobs; a recharging one lies still. */
export function padBob(pad: Pick<Pad, 'armed'>, t: number, i: number): number {
  return pad.armed ? PAD_BOB * (0.5 + 0.5 * Math.sin(t * PAD_BOB_W + i * 1.7)) : 0;
}

/** A Pinball post's height (m, its foot's) at rise `up` (0 sunk out of sight under the floor … 1 standing on it). */
export const postLift = (up: number) => (Math.min(1, Math.max(0, up)) - 1) * (POST_H + 0.05);

/** How white a post's flash is (0 … 1) `age` s after its ding. */
export function postFlash(age: number): number {
  if (!(age >= 0) || age >= POST_FLASH_S) return 0;
  const u = 1 - age / POST_FLASH_S;
  return u * u;
}

/** The beach ball's blob shadow: its size (× the ball's radius) and darkness (opacity) for a ball `h` m over the floor. */
export function ballShadow(h: number): { scale: number; opacity: number } {
  const k = Math.min(1, Math.max(0, h) / 10);
  return { scale: 1 - 0.45 * k, opacity: 0.38 * (1 - 0.6 * k) };
}

function toon(hex: number): MeshToonNodeMaterial {
  const m = new MeshToonNodeMaterial({ color: hex });
  m.gradientMap = toonGradient();
  return m;
}

/** A flat five-pointed star `r` m across its points, lying on the floor (facing up). */
function starGeometry(r: number): ShapeGeometry {
  const s = new Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2, k = i % 2 ? r * 0.45 : r;
    if (i === 0) s.moveTo(Math.cos(a) * k, Math.sin(a) * k);
    else s.lineTo(Math.cos(a) * k, Math.sin(a) * k);
  }
  s.closePath();
  const g = new ShapeGeometry(s);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** A beach ball: six coloured gores round it and white caps at its poles, in crisp flat colours (per face). */
function beachBallGeometry(r: number): BufferGeometry {
  const g = new SphereGeometry(r, 36, 20).toNonIndexed();
  const p = g.getAttribute('position'), col = new Float32Array(p.count * 3);
  const gores = [0xff4f8b, 0xffffff, 0x3ec7ff, 0xffffff, 0xffc933, 0xffffff].map((h) => new Color(h)), cap = new Color(0xffffff);
  for (let f = 0; f < p.count; f += 3) {
    // the face's middle decides its colour
    const x = (p.getX(f) + p.getX(f + 1) + p.getX(f + 2)) / 3, y = (p.getY(f) + p.getY(f + 1) + p.getY(f + 2)) / 3;
    const z = (p.getZ(f) + p.getZ(f + 1) + p.getZ(f + 2)) / 3;
    const gore = Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * gores.length) % gores.length;
    const c = Math.abs(y) > r * 0.88 ? cap : gores[gore];
    for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], (f + v) * 3);
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  return g;
}

type PadPart = { group: Group; cushion: Group; mat: MeshToonNodeMaterial; starMat: MeshToonNodeMaterial; firedAt: number; armed: boolean };
type PostPart = { group: Group; cap: MeshToonNodeMaterial; dingAt: number };

const PAD_BASE_H = 0.07, PAD_CUSHION_H = 0.07;
const GLOW_PINK = new Color(0xff4f8b), GLOW_GOLD = new Color(0xffd23f), WHITE = new Color(0xffffff);

export class RingProps {
  readonly group = new Group();
  readonly ball: Mesh;
  readonly shadow: Mesh;
  private readonly pads: PadPart[] = [];
  private readonly posts: PostPart[] = [];
  private readonly shadowMat: MeshBasicNodeMaterial;
  private t = 0;

  constructor(scene: Scene, view: PropsView) {
    this.group.name = 'ring-props';
    // ---- spring pads: a purple base, a springy pink cushion with a gold star on it ----
    const baseGeo = new CylinderGeometry(PAD_RADIUS, PAD_RADIUS + 0.05, PAD_BASE_H, 32);
    baseGeo.translate(0, PAD_BASE_H / 2, 0);
    const cushionGeo = new CylinderGeometry(PAD_RADIUS - 0.1, PAD_RADIUS - 0.08, PAD_CUSHION_H, 32);
    cushionGeo.translate(0, PAD_CUSHION_H / 2, 0);
    const ringGeo = new TorusGeometry(PAD_RADIUS - 0.09, 0.035, 6, 32);
    ringGeo.rotateX(Math.PI / 2);
    const starGeo = starGeometry(PAD_RADIUS * 0.62);
    const baseMat = toon(0x8a4dff), ringMat = toon(0xffffff);
    view.pads.forEach((pad) => {
      const group = new Group(), cushion = new Group();
      group.position.set(pad.at.x, 0, pad.at.z);
      const base = new Mesh(baseGeo, baseMat);
      base.receiveShadow = true;
      const mat = toon(0xff7ab8), starMat = toon(0xffd23f);
      const top = new Mesh(cushionGeo, mat);
      top.receiveShadow = true;
      const ring = new Mesh(ringGeo, ringMat);
      ring.position.y = PAD_CUSHION_H;
      const star = new Mesh(starGeo, starMat);
      star.position.y = PAD_CUSHION_H + 0.004;
      cushion.position.y = PAD_BASE_H;
      cushion.add(top, ring, star);
      group.add(base, cushion);
      this.group.add(group);
      this.pads.push({ group, cushion, mat, starMat, firedAt: -Infinity, armed: pad.armed });
    });

    // ---- Pinball posts: a cream stem under a pink mushroom cap with a lemon band and white spots ----
    const stemH = POST_H * 0.62, capR = POST_RADIUS + 0.17;
    const stemGeo = new CylinderGeometry(POST_RADIUS * 0.92, POST_RADIUS, stemH, 20);
    stemGeo.translate(0, stemH / 2, 0);
    const capGeo = new SphereGeometry(capR, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    capGeo.scale(1, (POST_H - stemH) / capR, 1);
    capGeo.translate(0, stemH, 0);
    const bandGeo = new TorusGeometry(capR - 0.02, 0.06, 8, 28);
    bandGeo.rotateX(Math.PI / 2);
    bandGeo.translate(0, stemH + 0.02, 0);
    const spotGeo = new SphereGeometry(0.075, 8, 6);
    const stemMat = toon(0xfff1d6), bandMat = toon(0xffc933), spotMat = toon(0xffffff);
    view.posts.forEach((post) => {
      const group = new Group();
      group.position.set(post.at.x, postLift(post.up), post.at.z);
      const cap = toon(0xff4f8b);
      const stem = new Mesh(stemGeo, stemMat), top = new Mesh(capGeo, cap), band = new Mesh(bandGeo, bandMat);
      stem.castShadow = top.castShadow = true;
      group.add(stem, top, band);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2, spot = new Mesh(spotGeo, spotMat);
        spot.position.set(Math.cos(a) * capR * 0.62, stemH + (POST_H - stemH) * 0.72, Math.sin(a) * capR * 0.62);
        group.add(spot);
      }
      group.visible = post.up > 0;
      this.group.add(group);
      this.posts.push({ group, cap, dingAt: -Infinity });
    });

    // ---- the beach ball and its blob shadow ----
    const ballMat = new MeshToonNodeMaterial({ vertexColors: true });
    ballMat.gradientMap = toonGradient();
    this.ball = new Mesh(beachBallGeometry(BALL_R), ballMat);
    this.ball.name = 'beach-ball';
    this.ball.castShadow = true;
    this.ball.visible = false;
    this.shadowMat = new MeshBasicNodeMaterial({ color: 0x2b1460, transparent: true, opacity: 0, depthWrite: false });
    const shadowGeo = new CircleGeometry(BALL_R, 32);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadow = new Mesh(shadowGeo, this.shadowMat);
    this.shadow.name = 'beach-ball-shadow';
    this.shadow.position.y = 0.02;
    this.shadow.renderOrder = 1;
    this.shadow.visible = false;
    this.group.add(this.ball, this.shadow);
    scene.add(this.group);
  }

  /** A post's ding: it flashes. */
  ding(post: number): void {
    const p = this.posts[post];
    if (p) p.dingAt = this.t;
  }

  /** Once a frame, from the features' state: pads bob, glow and spring; posts rise and flash; the ball rolls. */
  update(dt: number, view: PropsView, ringRadius: number): void {
    this.t += Math.max(0, dt);
    const t = this.t;
    view.pads.forEach((pad, i) => {
      const p = this.pads[i];
      if (!p) return;
      if (p.armed && !pad.armed) p.firedAt = t; // it just fired
      p.armed = pad.armed;
      const glow = padGlow(pad, t, i);
      p.mat.emissive.copy(GLOW_PINK).multiplyScalar(glow);
      p.starMat.emissive.copy(GLOW_GOLD).multiplyScalar(glow * 1.2);
      p.cushion.position.y = PAD_BASE_H + padBob(pad, t, i);
      const s = padSpring(t - p.firedAt);
      p.cushion.scale.set(1 + (1 - s) * 0.25, s, 1 + (1 - s) * 0.25); // squashed flat it spreads a little
    });
    view.posts.forEach((post, i) => {
      const p = this.posts[i];
      if (!p) return;
      p.group.visible = post.up > 0;
      p.group.position.y = postLift(post.up);
      p.cap.emissive.copy(WHITE).multiplyScalar(postFlash(t - p.dingAt) * 0.9);
    });
    const b = view.ball;
    this.ball.visible = !!b;
    if (!b) {
      this.shadow.visible = false;
      return;
    }
    const at = b.body.translation(), q = b.body.rotation();
    this.ball.position.set(at.x, at.y, at.z);
    this.ball.quaternion.set(q.x, q.y, q.z, q.w);
    const over = Math.hypot(at.x, at.z) < ringRadius && at.y > -0.5; // over the ring: its shadow is on the floor
    this.shadow.visible = over;
    if (over) {
      const s = ballShadow(at.y - b.radius);
      this.shadow.position.x = at.x;
      this.shadow.position.z = at.z;
      this.shadow.scale.setScalar(s.scale);
      this.shadowMat.opacity = s.opacity;
    }
  }

  /** Every flash and spring over (a new round, the ring cleared). */
  reset(): void {
    for (const p of this.pads) p.firedAt = -Infinity;
    for (const p of this.posts) p.dingAt = -Infinity;
  }
}
