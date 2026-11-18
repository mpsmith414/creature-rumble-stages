import {
  BufferGeometry, Euler, InstancedMesh, Matrix4, MeshBasicNodeMaterial, Quaternion, SphereGeometry, TorusGeometry,
  Vector3, type Object3D,
} from 'three/webgpu';
import { starGeometry } from '../levels/scenery/kit';
import { untone } from '../render/tone';
import type { Bounds, LevelId } from '../stage/level';
import type { V2 } from '../stage/types';
import { mulberry32 } from '../util/rng';
import type { View } from './stage-camera';

/**
 * Knockout effects themed by level (spec §5.3): a creature that goes out off the top twinkles away as a star; one that
 * falls into the jungle river makes a big splash; one that leaves the space ship floats off into space in sparkles;
 * any other goes in a puff of cloud. The creature is already off the screen when it goes out, so the effect shows at
 * the nearest spot inside the view, sized to the view (it reads the same at any zoom). Display only.
 */

export type KoKind = 'star' | 'splash' | 'space' | 'poof';
export type ExitSide = 'top' | 'bottom' | 'left' | 'right';

/** How long an effect plays (s). */
export const KO_SECONDS = 2;
/** How far in from the view's edge an effect shows (× the view's height); a splash sits lower, half of that. */
const INSET = 0.12;
/** Sizes are × the view's height over this (m): an effect is the same size on the screen at any zoom. */
const SIZE_AT = 22;
/** Effects that can play at once (more take over the oldest), and the stars, puffs and rings each one may use. */
const SLOTS = 8, STARS = 8, PUFFS = 16;
/** A splash's drops fall at this gravity (× size) and fly up at least this fast (× size, per s). */
const DROP_G = 22, DROP_UP = 7;
/** A splash's foam crown: how many of its puffs. */
const SPLASH_FOAM = 5;
/**
 * Effects sit this far behind the play plane (m), every piece of them (they spread ±0.5 m at the widest view), so one
 * never covers a creature. They are placed (and sized) so that from the camera they show where `koSpot` says on the
 * plane, as if they were on it.
 */
const BACK = -1.2;
/** The stage camera's field of view (degrees, vertical) when none is given. */
const STAGE_FOV = 30;

const COLOURS = {
  star: '#ffd84a', sparkle: '#fff6b8', water: '#4cc3ef', foam: '#f4fdff', space: '#c9a8ff', spaceStar: '#bff4ff',
  puff: '#ffffff', ring: '#ffe680',
};

/** The edge `at` went out past: the one it is furthest past (a broken position counts as the bottom). */
export function exitSide(b: Bounds, at: V2): ExitSide {
  const past: [ExitSide, number][] = [
    ['left', b.left - at.x], ['right', at.x - b.right], ['bottom', b.bottom - at.y], ['top', at.y - b.top],
  ];
  let best: ExitSide = 'bottom', most = -Infinity;
  for (const [side, d] of past) {
    if (d > most) {
      most = d;
      best = side;
    }
  }
  return best;
}

/** The effect for a knockout on `level` past `side`: a star off the top, the river splash, space on the ship, else a poof. */
export function koKind(level: LevelId, side: ExitSide): KoKind {
  if (side === 'top') return 'star';
  if (level === 'jungle' && side === 'bottom') return 'splash';
  if (level === 'ship') return 'space';
  return 'poof';
}

/**
 * Where an effect for a creature gone out at `at` shows: the nearest spot inside `view` (inset from its edges), a star
 * always at the top, a splash at the bottom. A broken `at` shows in the middle. Fills and returns `out`.
 */
export function koSpot(kind: KoKind, at: V2, view: View, out: V2 = { x: 0, y: 0 }): V2 {
  const halfW = (view.height * view.aspect) / 2, halfH = view.height / 2, m = view.height * INSET;
  const x = Number.isFinite(at.x) ? at.x : view.cx, y = Number.isFinite(at.y) ? at.y : view.cy;
  out.x = Math.min(view.cx + halfW - m, Math.max(view.cx - halfW + m, x));
  out.y = Math.min(view.cy + halfH - m, Math.max(view.cy - halfH + m, y));
  if (kind === 'star') out.y = view.cy + halfH - m;
  if (kind === 'splash') out.y = view.cy - halfH + m / 2;
  return out;
}

/** One effect playing: its kind, where, how big, how long it has played, its random spread. */
type Slot = { kind: KoKind | null; x: number; y: number; size: number; age: number; seed: number; side: number };

const _m = new Matrix4(), _q = new Quaternion(), _e = new Euler(), _p = new Vector3(), _s = new Vector3();
const ZERO = new Matrix4().makeScale(0, 0, 0);

/** The knockout effects of a fight: three instanced meshes (stars, puffs, rings) shared by every effect playing. */
export class KoFx {
  private readonly stars: InstancedMesh;
  private readonly puffs: InstancedMesh;
  private readonly rings: InstancedMesh;
  private readonly meshes: InstancedMesh[];
  private readonly slots: Slot[] = [];
  private readonly spot: V2 = { x: 0, y: 0 };
  private played = 0;

  /** Effects drawn under `parent`, placed by the camera's live `view` (its field of view `fov`, degrees). */
  constructor(private readonly parent: Object3D, private readonly view: View, private readonly fov = STAGE_FOV) {
    const make = (geo: BufferGeometry, n: number, name: string) => {
      const im = new InstancedMesh(geo, new MeshBasicNodeMaterial(), n);
      im.name = name;
      im.frustumCulled = false;
      for (let i = 0; i < n; i++) {
        im.setMatrixAt(i, ZERO);
        im.setColorAt(i, untone(COLOURS.puff));
      }
      parent.add(im);
      return im;
    };
    this.stars = make(starGeometry(5, 0.5, 0.22, 0.14), SLOTS * STARS, 'ko:stars');
    this.puffs = make(new SphereGeometry(1, 10, 8), SLOTS * PUFFS, 'ko:puffs');
    this.rings = make(new TorusGeometry(1, 0.1, 6, 28), SLOTS, 'ko:rings');
    this.meshes = [this.stars, this.puffs, this.rings];
    for (let i = 0; i < SLOTS; i++) this.slots.push({ kind: null, x: 0, y: 0, size: 1, age: 0, seed: 0, side: 1 });
  }

  /** Plays a `kind` effect for a creature gone out at `at` (the level's coordinates). */
  play(kind: KoKind, at: V2): void {
    let slot = this.slots.find((s) => !s.kind);
    if (!slot) slot = this.slots.reduce((a, b) => (a.age >= b.age ? a : b));
    const v = this.view, p = koSpot(kind, at, v, this.spot);
    // pushed back behind the plane, it is spread out (and grown) by as much as the distance shrinks it on the screen
    const dist = v.height / 2 / Math.tan((this.fov * Math.PI) / 360), k = (dist - BACK) / dist;
    Object.assign(slot, {
      kind, x: v.cx + (p.x - v.cx) * k, y: v.cy + (p.y - v.cy) * k, size: (v.height / SIZE_AT) * k, age: 0, seed: ++this.played,
      side: (Number.isFinite(at.x) ? at.x : this.view.cx) >= this.view.cx ? 1 : -1,
    });
    const i = this.slots.indexOf(slot);
    // colour this slot's pieces for its kind
    for (let k = 0; k < STARS; k++) {
      this.stars.setColorAt(i * STARS + k, untone(k === 0 ? (kind === 'space' ? COLOURS.spaceStar : COLOURS.star) : COLOURS.sparkle));
    }
    for (let k = 0; k < PUFFS; k++) {
      const c = kind === 'splash' ? (k < SPLASH_FOAM || k % 4 === 0 ? COLOURS.foam : COLOURS.water) : kind === 'space' ? COLOURS.space : COLOURS.puff;
      this.puffs.setColorAt(i * PUFFS + k, untone(c));
    }
    this.rings.setColorAt(i, untone(kind === 'splash' ? COLOURS.foam : kind === 'space' ? COLOURS.space : COLOURS.ring));
    for (const im of this.meshes) if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  /** Moves every effect on by `dt` real seconds (a broken or negative dt counts as none). */
  update(dt: number): void {
    const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (let i = 0; i < SLOTS; i++) {
      const s = this.slots[i];
      if (!s.kind) continue;
      s.age += d;
      if (s.age >= KO_SECONDS) {
        s.kind = null;
        this.clear(i);
        continue;
      }
      this.draw(i, s);
    }
    for (const im of this.meshes) im.instanceMatrix.needsUpdate = true;
  }

  /** Takes the effects out of the scene and frees them. */
  dispose(): void {
    for (const im of this.meshes) {
      im.geometry.dispose();
      (im.material as MeshBasicNodeMaterial).dispose();
      im.dispose();
      this.parent.remove(im);
    }
  }

  private clear(i: number): void {
    for (let k = 0; k < STARS; k++) this.stars.setMatrixAt(i * STARS + k, ZERO);
    for (let k = 0; k < PUFFS; k++) this.puffs.setMatrixAt(i * PUFFS + k, ZERO);
    this.rings.setMatrixAt(i, ZERO);
  }

  private star(i: number, k: number, x: number, y: number, z: number, size: number, spin: number): void {
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, 0, spin)), _s.setScalar(Math.max(0, size)));
    this.stars.setMatrixAt(i * STARS + k, _m);
  }

  private puff(i: number, k: number, x: number, y: number, z: number, sx: number, sy = sx): void {
    _m.compose(_p.set(x, y, z), _q.identity(), _s.set(Math.max(0, sx), Math.max(0, sy), Math.max(0, sx)));
    this.puffs.setMatrixAt(i * PUFFS + k, _m);
  }

  private ring(i: number, x: number, y: number, z: number, r: number, flat: boolean): void {
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(flat ? Math.PI / 2 : 0, 0, 0)), _s.set(r, r, flat ? r : r * 0.6));
    this.rings.setMatrixAt(i, _m);
  }

  /** One effect at its age: placed and sized by its kind. */
  private draw(i: number, s: Slot): void {
    this.clear(i);
    const u = s.size, t = s.age, k = t / KO_SECONDS, rng = mulberry32(s.seed * 7919);
    const pop = Math.min(1, t / 0.15), fade = 1 - smooth((k - 0.55) / 0.45);
    const z = BACK;
    if (s.kind === 'star') {
      // a big star pops and twinkles, sparkles burst round it, then it all winks out
      const tw = 1 + 0.25 * Math.sin(t * 28);
      this.star(i, 0, s.x, s.y, z, 3.4 * u * pop * tw * fade, t * 5);
      for (let n = 1; n < STARS; n++) {
        const a = (n / (STARS - 1)) * Math.PI * 2 + rng(), r = 3.2 * u * smooth(t / 0.5);
        this.star(i, n, s.x + Math.cos(a) * r, s.y + Math.sin(a) * r, z, 1 * u * pop * (1 - smooth(k / 0.8)), -t * 6 + a);
      }
      // a quick flash ring as it pops
      this.ring(i, s.x, s.y, z - 0.1, t < 0.35 ? 3.8 * u * smooth(t / 0.35) : 0, false);
    } else if (s.kind === 'splash') {
      // a crown of foam at the water, drops flying up in a fan and falling back, a ring spreading on the water
      for (let n = 0; n < PUFFS; n++) {
        if (n < SPLASH_FOAM) {
          const x = s.x + (n - (SPLASH_FOAM - 1) / 2) * 0.7 * u, rise = 1.4 * u * smooth(t / 0.25) * (1 - Math.abs(n - 2) * 0.25);
          this.puff(i, n, x, s.y + rise, z, 0.7 * u * pop * fade, 0.9 * u * pop * fade);
          continue;
        }
        const vx = (rng() - 0.5) * 8 * u, vy = (DROP_UP + rng() * 6) * u, r = (0.28 + rng() * 0.26) * u;
        const x = s.x + vx * t, y = s.y + vy * t - 0.5 * DROP_G * u * t * t;
        const size = y < s.y - u ? 0 : r * fade;
        this.puff(i, n, x, y, z + (rng() - 0.5) * u, size, size * 1.3);
      }
      this.ring(i, s.x, s.y, z, 3.5 * u * smooth(t / 0.8) * fade + 1e-3, true);
    } else if (s.kind === 'space') {
      // a bye-bye star floats off into the distance; sparkles swirl after it; a soft ring pulses
      const away = smooth(k);
      this.star(i, 0, s.x + s.side * 3 * u * away, s.y + 2 * u * away, z - 25 * away, 2.4 * u * pop * (1 + 0.2 * Math.sin(t * 20)), t * 2);
      for (let n = 1; n < STARS; n++) {
        const a = n * 0.9 + t * 3, r = (0.6 + n * 0.35) * u * (0.3 + away);
        this.star(i, n, s.x + Math.cos(a) * r + s.side * 2 * u * away, s.y + Math.sin(a) * r + u * away, z - 10 * away * (n / STARS),
          0.75 * u * pop * fade, a);
      }
      for (let n = 0; n < 6; n++) {
        const a = (n / 6) * Math.PI * 2 + rng(), r = 1.8 * u * smooth(t / 0.6);
        this.puff(i, n, s.x + Math.cos(a) * r, s.y + Math.sin(a) * r, z - 0.2, 0.35 * u * (1 - smooth(t / 0.9)));
      }
      this.ring(i, s.x, s.y, z - 0.2, 3.2 * u * smooth(t / 0.5) * (1 - smooth(t / 1.1)) + 1e-3, false);
    } else {
      // a puff of cloud bursts out and shrinks away, with a few sparkles
      for (let n = 0; n < 10; n++) {
        const a = (n / 10) * Math.PI * 2 + rng() * 0.4, r = 2.2 * u * smooth(t / 0.45);
        const size = u * (0.9 + rng() * 0.45) * pop * (1 - smooth((k - 0.3) / 0.6));
        this.puff(i, n, s.x + Math.cos(a) * r, s.y + Math.sin(a) * r * 0.8, z + (rng() - 0.5) * u, size);
      }
      this.puff(i, 10, s.x, s.y, z, 1.5 * u * pop * (1 - smooth(k / 0.5)));
      for (let n = 1; n < 4; n++) {
        const a = n * 2.1 + rng(), r = 2.4 * u * smooth(t / 0.6);
        this.star(i, n, s.x + Math.cos(a) * r, s.y + Math.sin(a) * r, z + 0.2, 0.55 * u * pop * fade, t * 4);
      }
    }
  }
}

/** Smoothstep of x clamped to 0 … 1. */
function smooth(x: number): number {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
}
