import { Color, Group, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3, type BufferGeometry, type Material, type Object3D } from 'three/webgpu';
import { bodyInfo } from '../anim/pose';
import { striker } from '../anim/strikes';
import type { Move } from '../fight/types';
import { at, flatMaterial, geometryOf, instanced, litMaterial } from '../levels/scenery/kit';
import type { BodyLayout } from '../anim/layout';
import { untone } from '../render/tone';
import { PIE, PRESENT_SIZE, type ItemCue, type ItemName, type Pie, type Present } from '../stage/items';

/**
 * How presents and power-ups look on the TV (spec §8), display only: a present box with a ribbon and a bow floating down
 * under a striped parachute (folded away once it lands); a held pool noodle or custard pie in the creature's hand; a pie
 * flying; a splat of custard on the face of a creature it hit while it is stunned; an ice pop in the hand a moment; a
 * sparkle round a creature in its own colour while a timed power-up lasts (blinking faster as it runs out); a bubble
 * behind a creature with a Bubble Shield; a soft glow with twinkles rising through it in its pad's colour behind a
 * creature with kid power. Presents, sparkles, bubbles and glows sit behind the play plane (z < 0), never in front of
 * a creature; the things in a hand, a flying pie and a splat are small and part of the creature.
 */

/** What the looks need of one creature now: its power-up, its time left (s) of a timed one, its box as drawn, its colour and pose. */
export type ItemFighter = {
  id: string;
  item: ItemName | null;
  /** Seconds left of a timed power-up (Infinity for one that is not timed). */
  left: number;
  /** Its box's bottom centre and size as drawn (m). */
  x: number;
  y: number;
  w: number;
  h: number;
  facing: 1 | -1;
  move: Move;
  /** Its colour (a CSS colour): the sparkle's. */
  colour: string;
  layout: BodyLayout;
  /** Its pieces as posed this frame (one world matrix per segment, as `poseSegments` makes them). */
  pieces: readonly Matrix4[];
  /** With kid power (a child steering it with a controller): its pad's colour (a CSS colour), the glow's; else none. */
  kid?: string | null;
};

/** How far behind the play plane presents and bubbles (and sparkles) are drawn (m): behind every creature's body. */
export const BEHIND = -0.8, SPARKLE_Z = -0.6;
/** Presents drawn at once, and the colours their boxes cycle through. */
const PRESENTS = 3;
const BOX_COLOURS = ['#ff5fa2', '#3fc6e8', '#ffb23f'] as const;
/** The parachute: canopy radius and how far above the box it floats (m); it sways this far (rad) this fast (rad/s). */
const CANOPY_R = 0.75, CANOPY_UP = 1.3, SWAY = 0.12, SWAY_SPEED = 2.2;
/** Creatures drawn with things at once, pies in flight at once. */
const FIGHTERS = 8, PIES = 4;
/** Sparkles round a sparkling creature, how far out from its box (m), how fast they go round (rad/s), their size (m). */
const SPARKLES = 7, SPARKLE_OUT = 0.35, SPARKLE_TURN = 1.6, SPARKLE_SIZE = 0.55;
/** The sparkle's colour: the creature's hue at this saturation and lightness. */
const SPARKLE_SAT = 0.9, SPARKLE_LIGHT = 0.55;
/** In its last this many seconds a timed power-up's sparkle blinks, this many times a second. */
const BLINK_FROM = 2, BLINK_RATE = 6;
/** The pool noodle: length and radius (m); the custard pie: radius (m, as the sim's). */
const NOODLE_LEN = 1.5, NOODLE_R = 0.11;
/** The bubble behind a shielded creature: × its box's larger side. */
const BUBBLE_SIZE = 0.75;
/** A splat stays on the face this long (s: the stun); an ice pop shows in the hand this long (s). */
const SPLAT_TIME = PIE.stun, ICE_POP_TIME = 1;
/** The splat sits this far (m) out from the front of the head; it is drawn for a head of this radius (m), never below this share. */
const SPLAT_OUT = 0.03, SPLAT_HEAD = 0.3, SPLAT_MIN = 0.8;

/**
 * Kid power's glow: an oval this far (m) out round the box, drawn this far behind the play plane (m, behind the
 * presents and bubbles too), made of rings each this opaque (stacked, it is soft: brightest in the middle, faint at its
 * rim), breathing ± this share this fast (rad/s).
 */
const KID_GLOW_OUT = 0.45, KID_GLOW_Z = -0.95, KID_GLOW_OPACITY = 0.3;
const KID_GLOW_RINGS = [1, 0.86, 0.72, 0.58, 0.44] as const;
const KID_GLOW_BREATHE = 0.06, KID_GLOW_SPEED = 3;
/** Kid power's twinkles: this many rise through the glow, each taking this long (s) from bottom to top, this big (m). */
const KID_TWINKLES = 5, KID_TWINKLE_RISE = 1.4, KID_TWINKLE_SIZE = 0.4;
/** How far toward white the glow's colour (and, from there, the twinkles') is lightened (0 none … 1 white). */
const KID_GLOW_LIGHT = 0.3, KID_TWINKLE_LIGHT = 0.4;

/** The noodle never points further down than this (the y of its direction): held out level or up. */
const NOODLE_UP = 0;

const _p = new Vector3(), _q = new Quaternion(), _s = new Vector3(), _m = new Matrix4(), _v = new Vector3(), _d = new Vector3();
const UP = new Vector3(0, 1, 0);
const WHITE = new Color(1, 1, 1);
const _hsl = { h: 0, s: 0, l: 0 };

/** Which piece holds things (a hand, on the side nearer the camera), and how far out along it its end is, per layout. */
const hands = new WeakMap<BodyLayout, Map<string, { s: number; end: number }>>();

/**
 * The piece a creature holds things in, facing `facing`, and its far end's distance from the piece's centre (m, along
 * its +y): a hand (or the lowest piece of an arm) on the side nearer the camera, else the part it strikes with.
 */
export function holdPiece(layout: BodyLayout, move: Move, facing: 1 | -1): { s: number; end: number } {
  let per = hands.get(layout);
  if (!per) hands.set(layout, (per = new Map()));
  const key = `${move} ${facing}`;
  let h = per.get(key);
  if (!h) {
    const info = bodyInfo(layout), near = -facing;
    let best = -1, score = -Infinity;
    for (let s = 0; s < info.n; s++) {
      const j = info.joint[s];
      const rank = j === 'hand' ? 3 : j === 'elbow' ? 2 : j === 'shoulder' ? 1 : 0;
      if (rank === 0) continue;
      const sc = rank * 10 + (info.side[s] === near ? 2 : info.side[s] === 0 ? 1 : 0);
      if (sc > score) {
        score = sc;
        best = s;
      }
    }
    if (best < 0) best = striker(info, move, near);
    const g = layout.segments[best];
    per.set(key, (h = { s: best, end: Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y, g.b.z - g.a.z) / 2 }));
  }
  return h;
}

/** Where a creature's hand is now (the end of its holding piece, posed), into `out`. */
export function handSpot(f: ItemFighter, out: Vector3): Vector3 {
  const h = holdPiece(f.layout, f.move, f.facing), m = f.pieces[h.s];
  return m ? out.set(0, h.end, 0).applyMatrix4(m) : out.set(f.x, f.y + f.h * 0.6, 0);
}

/** One creature's display timers: a splat on its face, an ice pop in its hand (s left). */
type Timers = { splat: number; icePop: number };

export class ItemLooks {
  readonly root = new Group();
  private readonly materials: Material[] = [];
  private readonly geos: BufferGeometry[] = [];
  private readonly boxGeos: BufferGeometry[] = [];
  private readonly boxes: Mesh[] = [];
  private readonly chutes: Mesh[] = [];
  private readonly noodles: Mesh[] = [];
  private readonly held: Mesh[] = [];
  private readonly pops: Mesh[] = [];
  private readonly splats: Mesh[] = [];
  private readonly bubbles: Mesh[] = [];
  private readonly flying: Mesh[] = [];
  private readonly sparkles: InstancedMesh;
  /** Kid power's glows (one a creature) and the twinkles rising through them. */
  private readonly glows: InstancedMesh;
  private readonly twinkles: InstancedMesh;
  private readonly timers = new Map<string, Timers>();
  private readonly tint = new Color();
  private time = 0;

  constructor(parent: Object3D) {
    this.root.name = 'item-looks';
    const lit = litMaterial(), flat = flatMaterial(), glass = flatMaterial();
    glass.transparent = true;
    glass.opacity = 0.4;
    glass.depthWrite = false;
    this.materials.push(lit, flat, glass);

    const half = PRESENT_SIZE / 2;
    const boxGeos = this.boxGeos;
    for (const c of BOX_COLOURS) boxGeos.push(this.geo(geometryOf('lit', (b, s) => {
      b.add(s.box, at(0, half, 0, PRESENT_SIZE), c);
      // the ribbon round it both ways and a bow on top
      b.add(s.box, at(0, half, 0, PRESENT_SIZE * 0.22, PRESENT_SIZE * 1.02, PRESENT_SIZE * 1.02), '#fff4c2');
      b.add(s.box, at(0, half, 0, PRESENT_SIZE * 1.02, PRESENT_SIZE * 1.02, PRESENT_SIZE * 0.22), '#fff4c2');
      b.add(s.torus, at(-0.11, PRESENT_SIZE + 0.07, 0, 0.11, 0.11, 0.11, 0, 0, 0.6), '#fff4c2');
      b.add(s.torus, at(0.11, PRESENT_SIZE + 0.07, 0, 0.11, 0.11, 0.11, 0, 0, -0.6), '#fff4c2');
    })));
    const chuteGeo = this.geo(geometryOf('lit', (b, s) => {
      // a striped canopy of puffs round a dome, strings down to the box's top corners
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        b.add(s.ball, at(Math.cos(a) * 0.38, CANOPY_UP, Math.sin(a) * 0.38 * 0.6, 0.42, 0.26, 0.3), k % 2 ? '#ffffff' : '#ff6b6b');
      }
      b.add(s.ball, at(0, CANOPY_UP + 0.08, 0, CANOPY_R * 0.7, 0.3, CANOPY_R * 0.5), '#ff6b6b');
      for (const sx of [-1, 1]) {
        const top = new Vector3(sx * CANOPY_R * 0.8, CANOPY_UP - 0.1, 0), bottom = new Vector3(sx * half * 0.9, PRESENT_SIZE, 0);
        const mid = top.clone().add(bottom).multiplyScalar(0.5), len = top.distanceTo(bottom);
        b.add(s.cyl, at(mid.x, mid.y, mid.z, 0.015, len, 0.015, 0, 0, Math.atan2(top.x - bottom.x, top.y - bottom.y) * -1), '#5b4a6b');
      }
    }));
    for (let i = 0; i < PRESENTS; i++) {
      this.boxes.push(this.mesh(boxGeos[i % boxGeos.length], lit, `present-${i}`));
      this.chutes.push(this.mesh(chuteGeo, lit, `parachute-${i}`));
    }

    const noodleGeo = this.geo(geometryOf('lit', (b, s) => {
      // along +y from the hand: a bright orange foam noodle with darker ends
      b.add(s.cyl, at(0, NOODLE_LEN / 2, 0, NOODLE_R, NOODLE_LEN, NOODLE_R), '#ff8c2e');
      b.add(s.cyl, at(0, NOODLE_LEN, 0, NOODLE_R * 0.8, 0.02, NOODLE_R * 0.8), '#c95a12');
    }));
    const pieGeo = this.geo(geometryOf('lit', (b, s) => {
      const r = PIE.r * 1.2;
      b.add(s.cyl, at(0, 0, 0, r, r * 0.45, r), '#c98a4b');
      b.add(s.ball, at(0, r * 0.25, 0, r * 0.9, r * 0.45, r * 0.9), '#fffdf4');
      b.add(s.ball, at(0, r * 0.62, 0, r * 0.18), '#e23b4e');
    }));
    const popGeo = this.geo(geometryOf('lit', (b, s) => {
      b.add(s.box, at(0, 0.28, 0, 0.18, 0.36, 0.1), '#7fd9ff');
      b.add(s.ball, at(0, 0.46, 0, 0.09, 0.06, 0.05), '#7fd9ff');
      b.add(s.box, at(0, 0.04, 0, 0.04, 0.16, 0.03), '#f1d9a8');
    }));
    const splatGeo = this.geo(geometryOf('lit', (b, s) => {
      b.add(s.ball, at(0, 0, 0, 0.26, 0.2, 0.08), '#fffdf4');
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + 0.4;
        b.add(s.ball, at(Math.cos(a) * 0.22, Math.sin(a) * 0.18, 0, 0.09, 0.07, 0.05), '#fffdf4');
      }
    }));
    const bubbleGeo = this.geo(geometryOf('flat', (b, s) => {
      b.add(s.ball, at(0, 0, 0, 1, 1, 0.05), '#bdf0ff');
      b.add(s.torus, at(0, 0, 0.02, 0.94), '#ffffff');
    }));
    for (let i = 0; i < FIGHTERS; i++) {
      this.noodles.push(this.mesh(noodleGeo, lit, `noodle-${i}`));
      this.held.push(this.mesh(pieGeo, lit, `held-pie-${i}`));
      this.pops.push(this.mesh(popGeo, lit, `ice-pop-${i}`));
      this.splats.push(this.mesh(splatGeo, lit, `splat-${i}`));
      this.bubbles.push(this.mesh(bubbleGeo, glass, `bubble-${i}`));
    }
    for (let i = 0; i < PIES; i++) this.flying.push(this.mesh(pieGeo, lit, `pie-${i}`));

    // (plain 1 white, so each sparkle shows exactly its creature's colour)
    const sparkGeo = this.geo(geometryOf('flat', (b, s) => b.add(s.sparkle, at(0, 0, 0), (_p, _n, out) => out.setRGB(1, 1, 1))));
    this.sparkles = instanced(sparkGeo, flat, FIGHTERS * SPARKLES, 'sparkles');
    for (let i = 0; i < FIGHTERS * SPARKLES; i++) this.sparkles.setColorAt(i, this.tint.set('#ffffff'));
    this.root.add(this.sparkles);

    // kid power: a soft glow (flat rings in plain white, each coloured its pad's) and twinkles rising through it
    const soft = flatMaterial();
    soft.transparent = true;
    soft.opacity = KID_GLOW_OPACITY;
    soft.depthWrite = false;
    this.materials.push(soft);
    const glowGeo = this.geo(geometryOf('flat', (b, s) => {
      for (const r of KID_GLOW_RINGS) b.add(s.ball, at(0, 0, 0, r, r, 0.02), (_p, _n, out) => out.setRGB(1, 1, 1));
    }));
    this.glows = instanced(glowGeo, soft, FIGHTERS, 'kid-glow');
    this.twinkles = instanced(sparkGeo, flat, FIGHTERS * KID_TWINKLES, 'kid-sparkles');
    for (let i = 0; i < FIGHTERS; i++) this.glows.setColorAt(i, this.tint.set('#ffffff'));
    for (let i = 0; i < FIGHTERS * KID_TWINKLES; i++) this.twinkles.setColorAt(i, this.tint.set('#ffffff'));
    this.root.add(this.glows, this.twinkles);
    parent.add(this.root);
  }

  /**
   * Draws the presents and pies now (`presents`, `pies` as the sim has them), the creatures' power-ups (`fighters`, each
   * already posed this frame), and starts the moments this frame's `cues` bring (a splat, an ice pop). `dt` is real
   * seconds since the last frame (the parachute's sway, the sparkle's turn, the timers).
   */
  update(presents: readonly Present[], pies: readonly Pie[], fighters: readonly ItemFighter[], cues: readonly ItemCue[], dt: number): void {
    const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.time += d;
    for (const t of this.timers.values()) {
      t.splat = Math.max(0, t.splat - d);
      t.icePop = Math.max(0, t.icePop - d);
    }
    for (const c of cues) {
      if (c.phase === 'end' && c.item === 'custardPie' && c.target) this.timer(c.target).splat = SPLAT_TIME;
      if (c.phase === 'use' && c.item === 'icePop' && c.id) this.timer(c.id).icePop = ICE_POP_TIME;
    }

    for (let i = 0; i < PRESENTS; i++) {
      const p = presents[i], box = this.boxes[i], chute = this.chutes[i];
      box.visible = !!p;
      chute.visible = !!p && p.on === null;
      if (!p) continue;
      box.position.set(p.x, p.y, BEHIND);
      // (each present keeps its colour while it lies there)
      box.geometry = this.boxGeos[p.id % this.boxGeos.length];
      chute.position.set(p.x, p.y, BEHIND);
      chute.rotation.z = p.on === null ? Math.sin(this.time * SWAY_SPEED + p.id) * SWAY : 0;
      box.rotation.z = chute.rotation.z * 0.5;
    }
    for (let i = 0; i < PIES; i++) {
      const p = pies[i], m = this.flying[i];
      m.visible = !!p;
      if (!p) continue;
      m.position.set(p.x, p.y, 0);
      // it tumbles over as it flies
      m.rotation.z = -Math.sign(p.vx) * this.time * 9;
    }

    let n = 0, g = 0, tw = 0;
    for (let i = 0; i < FIGHTERS; i++) {
      const f = fighters[i];
      const noodle = this.noodles[i], pie = this.held[i], pop = this.pops[i], splat = this.splats[i], bubble = this.bubbles[i];
      noodle.visible = pie.visible = pop.visible = splat.visible = bubble.visible = false;
      if (!f) continue;
      const t = this.timers.get(f.id);
      if (f.item === 'poolNoodle' || f.item === 'custardPie' || (t && t.icePop > 0)) {
        const hm = f.pieces[holdPiece(f.layout, f.move, f.facing).s];
        const thing = f.item === 'poolNoodle' ? noodle : f.item === 'custardPie' ? pie : pop;
        handSpot(f, _v);
        thing.visible = true;
        thing.position.copy(_v);
        if (thing === noodle && hm) {
          // along the arm, on out past the hand; an arm hanging down holds it up and out instead (never into the floor)
          hm.decompose(_p, _q, _s);
          _d.set(0, 1, 0).applyQuaternion(_q);
          if (_d.y < NOODLE_UP) _d.y = Math.max(NOODLE_UP, -_d.y);
          thing.quaternion.setFromUnitVectors(UP, _d.normalize());
        } else thing.quaternion.identity();
      }
      if (t && t.splat > 0) {
        // on the face: at its head, just in front of the body's front (a round body's head is sunk in it), sized to the head
        const head = headPiece(f.layout);
        const m = f.pieces[head];
        if (m) {
          splat.visible = true;
          let front = -Infinity;
          f.pieces.forEach((pm, s) => {
            pm.decompose(_p, _q, _s);
            front = Math.max(front, _p.z + f.layout.segments[s].radius * _s.x);
          });
          m.decompose(_p, _q, _s);
          const r = f.layout.segments[head].radius * _s.x;
          splat.position.set(_p.x, _p.y, front + SPLAT_OUT);
          splat.scale.setScalar(Math.max(SPLAT_MIN, r / SPLAT_HEAD));
        }
      }
      if (f.item === 'bubbleShield') {
        bubble.visible = true;
        const r = Math.max(f.w, f.h) * BUBBLE_SIZE;
        bubble.position.set(f.x, f.y + f.h / 2, BEHIND);
        bubble.scale.setScalar(r * (1 + 0.04 * Math.sin(this.time * 5)));
      }
      if (f.item === 'growJuice' || f.item === 'zoomSneakers') {
        const on = f.left > BLINK_FROM || Math.sin(this.time * BLINK_RATE * Math.PI * 2) > -0.3;
        // its colour made bold (a creature's colours are pastel: a pale sparkle reads as white on the TV)
        this.tint.set(f.colour).getHSL(_hsl);
        this.tint.set(untone(`#${this.tint.setHSL(_hsl.h, SPARKLE_SAT, SPARKLE_LIGHT).getHexString()}`));
        const rx = f.w / 2 + SPARKLE_OUT, ry = f.h / 2 + SPARKLE_OUT;
        for (let k = 0; k < SPARKLES; k++) {
          const a = this.time * SPARKLE_TURN + (k / SPARKLES) * Math.PI * 2;
          const twinkle = 0.6 + 0.4 * Math.abs(Math.sin(this.time * 4 + k * 1.7));
          const size = on ? SPARKLE_SIZE * twinkle : 0;
          _m.compose(_p.set(f.x + Math.cos(a) * rx, f.y + f.h / 2 + Math.sin(a) * ry, SPARKLE_Z), _q.identity(), _s.set(size, size, size));
          this.sparkles.setMatrixAt(n, _m);
          this.sparkles.setColorAt(n, this.tint);
          n++;
        }
      }
      if (f.kid) {
        this.kidGlow(f, f.kid, g++, tw);
        tw += KID_TWINKLES;
      }
    }
    hideFrom(this.sparkles, n);
    hideFrom(this.glows, g);
    hideFrom(this.twinkles, tw);
  }

  /**
   * Kid power's look on `f`: glow `g` (an oval round its box, breathing) in `colour`, and twinkles
   * from `tw` on rising through it, each growing then fading as it goes, a little brighter than the glow.
   */
  private kidGlow(f: ItemFighter, colour: string, g: number, tw: number): void {
    // the pad's colour a little lighter, so it reads as light even on a dark trunk (as it is, not untoned: a glow is
    // mostly see-through, and an untoned bold pink shows orange)
    this.tint.set(colour).lerp(WHITE, KID_GLOW_LIGHT);
    const breathe = 1 + KID_GLOW_BREATHE * Math.sin(this.time * KID_GLOW_SPEED);
    const rx = (f.w / 2 + KID_GLOW_OUT) * breathe, ry = (f.h / 2 + KID_GLOW_OUT) * breathe, cy = f.y + f.h / 2;
    _m.compose(_p.set(f.x, cy, KID_GLOW_Z), _q.identity(), _s.set(rx, ry, 1));
    this.glows.setMatrixAt(g, _m);
    this.glows.setColorAt(g, this.tint);
    this.tint.lerp(WHITE, KID_TWINKLE_LIGHT);
    for (let k = 0; k < KID_TWINKLES; k++) {
      // each its own way up, spread round the glow; it grows in, then fades out near the top
      const u = (this.time / KID_TWINKLE_RISE + k / KID_TWINKLES) % 1;
      const side = Math.sin(k * 2.4 + 0.7);
      const size = KID_TWINKLE_SIZE * Math.sin(u * Math.PI);
      _p.set(f.x + side * rx * 0.8, cy + (u * 2 - 1) * ry * 0.9, SPARKLE_Z);
      _m.compose(_p, _q.identity(), _s.set(size, size, size));
      this.twinkles.setMatrixAt(tw + k, _m);
      this.twinkles.setColorAt(tw + k, this.tint);
    }
  }

  /** Forgets a creature that left (its splat and ice pop). */
  forget(id: string): void {
    this.timers.delete(id);
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.materials) m.dispose();
    this.sparkles.dispose();
    this.glows.dispose();
    this.twinkles.dispose();
    this.root.removeFromParent();
  }

  private timer(id: string): Timers {
    let t = this.timers.get(id);
    if (!t) this.timers.set(id, (t = { splat: 0, icePop: 0 }));
    return t;
  }

  private geo(g: BufferGeometry): BufferGeometry {
    this.geos.push(g);
    return g;
  }

  private mesh(g: BufferGeometry, m: Material, name: string): Mesh {
    const mesh = new Mesh(g, m);
    mesh.name = name;
    mesh.visible = false;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    this.root.add(mesh);
    return mesh;
  }
}

/** Hides instances `from` on of `im` (a speck at the origin) and marks it changed. */
function hideFrom(im: InstancedMesh, from: number): void {
  _m.compose(_p.set(0, 0, 0), _q.identity(), _s.set(0, 0, 0));
  for (let i = from; i < im.count; i++) im.setMatrixAt(i, _m);
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
}

/** The head piece (the root when it has none). */
function headPiece(layout: BodyLayout): number {
  const info = bodyInfo(layout);
  const h = info.joint.indexOf('head');
  return h >= 0 ? h : 0;
}

