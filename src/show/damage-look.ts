import { InstancedMesh, Matrix4, MeshBasicNodeMaterial, Quaternion, SphereGeometry, Vector3, type Object3D } from 'three/webgpu';
import { untone } from '../render/tone';
import { setTint, WARM_MAX } from '../render/toon';
import { damageStep, type StageTune } from '../stage/damage';
import type { V2 } from '../stage/types';

/**
 * Damage you can see (spec §5.3: no numbers on screen). A creature's hidden damage shows in four steps (`damageStep`),
 * always keeping its own colours (kids find their creature by them): fresh (as made); warm (a touch warmer, a faint
 * red glow round its edge); hot (warmer, a red glow, sweat drops flying off its head); about to fly (a strong red glow
 * that pulses, steam puffing from its head and its googly pupils spinning round). The look eases in and out, so an Ice
 * Pop cools it back to fresh smoothly. Display only: it reads the fighter and never changes it.
 */

/**
 * Each step's look: how far the skin is warmed (a colour-keeping multiply, at most WARM_MAX) and how strongly the red
 * glow rims the silhouette (`setTint`).
 */
export const DAMAGE_LOOKS: readonly { warm: number; heat: number }[] = [
  { warm: 0, heat: 0 },
  { warm: 0.1, heat: 0.3 },
  { warm: 0.2, heat: 0.6 },
  { warm: WARM_MAX, heat: 0.85 },
];
/** How fast (per second) the look eases toward its step's; at the last step the glow pulses this much either way, this often (Hz). */
const TINT_EASE = 6, PULSE = 0.15, PULSE_HZ = 2.2;
/**
 * Sweat (hot): every SWEAT_EVERY s a drop flies off each side of the head, out at SWEAT_OUT and up at SWEAT_UP (m/s),
 * falling at SWEAT_FALL (m/s²), for SWEAT_LIFE s; a drop is SWEAT_SIZE m across (stretched SWEAT_STRETCH tall).
 */
const SWEAT_EVERY = 0.3, SWEAT_OUT = 1.6, SWEAT_UP = 1.8, SWEAT_FALL = 9, SWEAT_LIFE = 0.55, SWEAT_SIZE = 0.14, SWEAT_STRETCH = 1.5;
/**
 * Steam (about to fly): a puff leaves the top of the head every STEAM_EVERY s, rising at STEAM_RISE (m/s) and drifting
 * either way up to STEAM_DRIFT, growing from STEAM_FROM to STEAM_TO m across over STEAM_LIFE s and shrinking away at the
 * end; soft (STEAM_OPACITY). Kept sparse however many steam: each one's puffs come that many times less often, and never
 * more than STEAM_MAX puffs are in the air at once for everyone.
 */
const STEAM_EVERY = 0.25, STEAM_RISE = 1.2, STEAM_DRIFT = 0.3, STEAM_FROM = 0.1, STEAM_TO = 0.26, STEAM_LIFE = 0.8;
export const STEAM_MAX = 6;
const STEAM_OPACITY = 0.7;
/**
 * Steam sits this far behind the play plane (m), so a puff never covers a creature (its own head or another's). Sweat
 * drops stay at the face: they are a few centimetres across and fly clear in a moment.
 */
export const STEAM_Z = -0.6;
/** The head's top is this share of the box height over the eyes (with no eyes: this share of the box up from its bottom). */
const OVER_EYES = 0.12, NO_EYES_HEAD = 0.85;
/** Spinning pupils: how far from the eye's middle (× the eye's radius) and how fast (rad/s); the two eyes spin opposite ways. */
const SPIN_R = 0.3, SPIN_RATE = 2 * Math.PI * 1.6;
/** Drops and puffs in the air at once, for everyone (more reuse the oldest). */
const SWEAT_POOL = 64, STEAM_POOL = 64;

/** What the look reads of a fighter (a `StageFighter` will do). */
export type HurtFighter = { readonly id: string; readonly damage: number; readonly tune: StageTune; readonly mover: { readonly pos: V2; readonly h: number } };
/** What the look needs of a body (a `FighterObject` will do): the mesh it tints and the googly eyes. */
export type HurtLook = {
  readonly root: Object3D;
  readonly mesh: Object3D;
  readonly bones: readonly Object3D[];
  readonly eyes: readonly { readonly pupil: { position: Vector3 } | null; readonly ball: Object3D | null; readonly bone: number }[];
};

/** One drop or puff: whose, where, its speed, age and life (s); `life` 0 is a free slot. */
type Bit = { owner: string; x: number; y: number; z: number; vx: number; vy: number; age: number; life: number };
/**
 * Per fighter: the step shown, the warmth and glow now, the timers to the next drop and puff, the pupils' spin, and the
 * mesh it last tinted (put back to fresh when it is forgotten).
 */
type Shown = {
  step: number; warm: number; heat: number; sweatIn: number; steamIn: number; spin: number; spinning: boolean; t: number;
  puffs: number; mesh: Object3D | null;
};
const _m = new Matrix4(), _p = new Vector3(), _s = new Vector3(), _q = new Quaternion();
const ZERO = new Matrix4().makeScale(0, 0, 0);
const head = { x: 0, y: 0, z: 0 };

export class DamageLook {
  private readonly shown = new Map<string, Shown>();
  private readonly sweat: Bit[] = [];
  private readonly steam: Bit[] = [];
  private readonly sweatMesh: InstancedMesh;
  private readonly steamMesh: InstancedMesh;
  private nextSweat = 0;
  private nextSteam = 0;

  /** Drops and puffs are drawn under `parent` (the scene). */
  constructor(private readonly parent: Object3D) {
    const make = (n: number, hex: string, name: string, opacity = 1) => {
      const mat = new MeshBasicNodeMaterial({ color: untone(hex) });
      if (opacity < 1) Object.assign(mat, { transparent: true, opacity, depthWrite: false });
      const im = new InstancedMesh(new SphereGeometry(1, 10, 8), mat, n);
      im.name = name;
      im.frustumCulled = false;
      for (let i = 0; i < n; i++) im.setMatrixAt(i, ZERO);
      parent.add(im);
      return im;
    };
    this.sweatMesh = make(SWEAT_POOL, '#2f9cf0', 'damage:sweat');
    this.steamMesh = make(STEAM_POOL, '#ffffff', 'damage:steam', STEAM_OPACITY);
    for (let i = 0; i < SWEAT_POOL; i++) this.sweat.push(blank());
    for (let i = 0; i < STEAM_POOL; i++) this.steam.push(blank());
  }

  /**
   * Once a frame per fighter in play, after its bones (and googly eyes) are placed: tints `obj` for `f`'s damage step,
   * sends off its drops and puffs and, about to fly, spins its pupils (over what the googly eyes did). `dt` is real
   * seconds. Its own drops and puffs move on with it, so call it for each fighter in play every frame.
   */
  update(f: HurtFighter, obj: HurtLook, dt: number): void {
    const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
    let s = this.shown.get(f.id);
    if (!s) {
      s = { step: 0, warm: 0, heat: 0, sweatIn: 0, steamIn: 0, spin: 0, spinning: false, t: 0, puffs: 0, mesh: null };
      this.shown.set(f.id, s);
    }
    const step = damageStep(f.damage, f.tune);
    s.step = step;
    s.t += d;
    s.mesh = obj.mesh;

    // the warmth and the red glow ease to their step's (the glow pulsing at the last), and back to none
    const look = DAMAGE_LOOKS[step], k = 1 - Math.exp(-TINT_EASE * d);
    const heat = look.heat + (step === 3 ? PULSE * Math.sin(2 * Math.PI * PULSE_HZ * s.t) : 0);
    s.warm += (look.warm - s.warm) * k;
    s.heat += (heat - s.heat) * k;
    if (step === 0 && s.warm < 1e-3 && s.heat < 1e-3) s.warm = s.heat = 0;
    setTint(obj.mesh, s.warm, s.heat);

    headOf(f, obj);
    if (step === 2) {
      s.sweatIn -= d;
      while (s.sweatIn <= 0) {
        s.sweatIn += SWEAT_EVERY;
        for (let side = -1; side <= 1; side += 2) this.emit(this.sweat, 'sweat', f.id, head.x, head.y, head.z, side * SWEAT_OUT, SWEAT_UP, SWEAT_LIFE);
      }
    } else s.sweatIn = 0;
    if (step === 3) {
      s.steamIn -= d;
      if (s.steamIn <= 0) {
        // each one steams less often the more are steaming, and a puff waits while the air is full
        s.steamIn = STEAM_EVERY * Math.max(1, this.steaming());
        if (this.livePuffs() < STEAM_MAX) {
          // puffs drift out one way then the other
          const side = s.puffs++ % 2 ? 1 : -1;
          this.emit(this.steam, 'steam', f.id, head.x, head.y, STEAM_Z, side * STEAM_DRIFT, STEAM_RISE, STEAM_LIFE);
        }
      }
    } else s.steamIn = 0;

    // about to fly: the pupils go round and round (the googly eyes take them back after)
    s.spinning = step === 3;
    if (s.spinning) {
      s.spin += SPIN_RATE * d;
      obj.eyes.forEach((e, i) => {
        if (!e.pupil) return;
        const a = i % 2 ? -s.spin : s.spin + Math.PI;
        e.pupil.position.x = Math.cos(a) * SPIN_R;
        e.pupil.position.y = Math.sin(a) * SPIN_R;
      });
    }

    this.move(f.id, d);
  }

  /** What `id` shows now (for tests and the dev page): its step, its drops and puffs in the air, its pupils spinning. */
  state(id: string): { step: number; sweat: number; steam: number; spinning: boolean } {
    const s = this.shown.get(id);
    const live = (bits: Bit[]) => bits.reduce((n, b) => n + (b.life > 0 && b.owner === id ? 1 : 0), 0);
    return { step: s?.step ?? 0, sweat: live(this.sweat), steam: live(this.steam), spinning: s?.spinning ?? false };
  }

  /** Drops what is kept for `id` and its drops and puffs (it left the stage), and puts its body back to fresh. */
  forget(id: string): void {
    const m = this.shown.get(id)?.mesh;
    if (m) setTint(m, 0, 0);
    this.shown.delete(id);
    this.sweat.forEach((b, i) => {
      if (b.owner === id) this.hide(b, this.sweatMesh, i);
    });
    this.steam.forEach((b, i) => {
      if (b.owner === id) this.hide(b, this.steamMesh, i);
    });
    this.sweatMesh.instanceMatrix.needsUpdate = true;
    this.steamMesh.instanceMatrix.needsUpdate = true;
  }

  /** Takes everything out of the scene and frees it. */
  dispose(): void {
    for (const s of this.shown.values()) if (s.mesh) setTint(s.mesh, 0, 0);
    for (const im of [this.sweatMesh, this.steamMesh]) {
      im.geometry.dispose();
      (im.material as MeshBasicNodeMaterial).dispose();
      im.dispose();
      this.parent.remove(im);
    }
    this.shown.clear();
  }

  /** How many fighters are steaming (at the last step) now. */
  private steaming(): number {
    let n = 0;
    for (const s of this.shown.values()) if (s.step === 3) n++;
    return n;
  }

  /** How many puffs are in the air now, everyone's. */
  private livePuffs(): number {
    let n = 0;
    for (const b of this.steam) if (b.life > 0) n++;
    return n;
  }

  private emit(bits: Bit[], kind: 'sweat' | 'steam', owner: string, x: number, y: number, z: number, vx: number, vy: number, life: number): void {
    const i = kind === 'sweat' ? this.nextSweat : this.nextSteam;
    if (kind === 'sweat') this.nextSweat = (i + 1) % bits.length;
    else this.nextSteam = (i + 1) % bits.length;
    Object.assign(bits[i], { owner, x, y, z, vx, vy, age: 0, life });
  }

  /**
   * Moves the drops and puffs of `id` on by `dt` (each fighter's own, so a frame moves each once) and redraws just
   * those (a slot another fighter's drop took over is redrawn by that fighter).
   */
  private move(id: string, dt: number): void {
    let moved = false;
    this.sweat.forEach((b, i) => {
      if (b.owner !== id || (b.life <= 0 && b.age < 0)) return;
      moved = true;
      b.age += dt;
      if (b.life <= 0 || b.age >= b.life) {
        this.hide(b, this.sweatMesh, i);
        return;
      }
      b.vy -= SWEAT_FALL * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const k = (SWEAT_SIZE / 2) * (1 - 0.4 * (b.age / b.life));
      this.sweatMesh.setMatrixAt(i, _m.compose(_p.set(b.x, b.y, b.z), _q.identity(), _s.set(k, k * SWEAT_STRETCH, k)));
    });
    this.steam.forEach((b, i) => {
      if (b.owner !== id || (b.life <= 0 && b.age < 0)) return;
      moved = true;
      b.age += dt;
      if (b.life <= 0 || b.age >= b.life) {
        this.hide(b, this.steamMesh, i);
        return;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const p = b.age / b.life, grow = STEAM_FROM + (STEAM_TO - STEAM_FROM) * Math.min(1, p * 1.5);
      const k = (grow / 2) * (p > 0.75 ? (1 - p) / 0.25 : 1);
      this.steamMesh.setMatrixAt(i, _m.compose(_p.set(b.x, b.y, b.z), _q.identity(), _s.set(k, k, k)));
    });
    if (moved) {
      this.sweatMesh.instanceMatrix.needsUpdate = true;
      this.steamMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** A drop or puff gone: a free slot, drawn as nothing (age −1 marks it already hidden). */
  private hide(b: Bit, im: InstancedMesh, i: number): void {
    b.life = 0;
    b.age = -1;
    im.setMatrixAt(i, ZERO);
  }
}

function blank(): Bit {
  return { owner: '', x: 0, y: 0, z: 0, vx: 0, vy: 0, age: -1, life: 0 };
}

/**
 * The top of the head as drawn: a little over the middle of its googly eyes (they ride the head's bone, so this follows
 * a tumble's spin), or with no eyes near the top of the box. Fills `head`.
 */
function headOf(f: HurtFighter, obj: HurtLook): void {
  let n = 0, x = 0, y = 0, z = 0;
  for (const e of obj.eyes) {
    const bone = obj.bones[e.bone];
    if (!e.ball || !bone) continue;
    _m.multiplyMatrices(obj.root.matrixWorld, bone.matrix).multiply(e.ball.matrix);
    _p.setFromMatrixPosition(_m);
    x += _p.x;
    y += _p.y;
    z += _p.z;
    n++;
  }
  if (n > 0 && Number.isFinite(x + y + z)) {
    head.x = x / n;
    head.y = y / n + OVER_EYES * f.mover.h;
    head.z = z / n;
  } else {
    head.x = f.mover.pos.x;
    head.y = f.mover.pos.y + NO_EYES_HEAD * f.mover.h;
    head.z = 0;
  }
}
