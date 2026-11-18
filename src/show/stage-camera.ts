import { MathUtils, type PerspectiveCamera } from 'three/webgpu';
import type { Bounds, Level } from '../stage/level';
import type { V2 } from '../stage/types';

/**
 * The side camera's numbers. `minHeight`/`maxHeight` are the view's height (m) on the stage plane z = 0: never closer
 * than 8 m (a fight stays readable) and never wider than 22 m (creatures never become specks; a creature beyond that
 * gets an edge bubble instead). `margin` is the space (m) kept round every creature; `ease` is how fast (per second)
 * the camera closes the gap to where it wants to be.
 */
export const CAM = { minHeight: 8, maxHeight: 22, margin: 3, ease: 4 };

/** Where the camera looks: the centre of the view on the plane z = 0 (m) and the view's height there (m). */
export type Framing = { cx: number; cy: number; height: number };
/** A framing plus the screen's shape (width / height), all a screen overlay needs to place things. */
export type View = Framing & { aspect: number };

/** The smallest view a close-up may ask for (m): closer than this and a creature would fill the screen. */
const CLOSE_UP_MIN = 2;

/** The screen's shape, or square when the canvas has no size yet (a zero or broken aspect must not poison the view). */
export function safeAspect(aspect: number): number {
  return aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
}

/**
 * Slides a view of `f.height` (on a screen of `aspect`) so it stays inside `camera` bounds; in a direction where the
 * view is bigger than the bounds it is centred on them instead.
 */
function fitInto(f: Framing, camera: Bounds, aspect: number): void {
  const halfW = (f.height * aspect) / 2, halfH = f.height / 2;
  f.cx = camera.right - camera.left <= 2 * halfW
    ? (camera.left + camera.right) / 2
    : MathUtils.clamp(f.cx, camera.left + halfW, camera.right - halfW);
  f.cy = camera.top - camera.bottom <= 2 * halfH
    ? (camera.bottom + camera.top) / 2
    : MathUtils.clamp(f.cy, camera.bottom + halfH, camera.top - halfH);
}

/**
 * The view that shows every target (a creature's bottom-centre `x, y` and its height `h`) with `CAM.margin` round
 * them on a screen of `aspect`: as close as fits, but no closer than `CAM.minHeight` and no wider than
 * `CAM.maxHeight`, slid to stay inside the level's `camera` bounds. With no targets it shows the bounds' centre at the
 * widest. Targets with a non-finite number are skipped. Pure; fills and returns `out`.
 */
export function framing(targets: readonly { x: number; y: number; h: number }[], camera: Bounds, aspect: number,
  out: Framing = { cx: 0, cy: 0, height: 0 }): Framing {
  const a = safeAspect(aspect);
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.h)) continue;
    if (t.x < left) left = t.x;
    if (t.x > right) right = t.x;
    if (t.y < bottom) bottom = t.y;
    if (t.y + t.h > top) top = t.y + t.h;
  }
  if (left > right) {
    out.cx = (camera.left + camera.right) / 2;
    out.cy = (camera.bottom + camera.top) / 2;
    out.height = CAM.maxHeight;
  } else {
    const m2 = 2 * CAM.margin;
    const need = Math.max(top - bottom + m2, (right - left + m2) / a);
    out.cx = (left + right) / 2;
    out.cy = (bottom + top) / 2;
    out.height = MathUtils.clamp(need, CAM.minHeight, CAM.maxHeight);
  }
  fitInto(out, camera, a);
  return out;
}

/**
 * The one side camera of the stage fight (spec §9.1): it looks along −z at the plane z = 0 and eases (exponentially,
 * so the same at any frame rate) toward the framing of the creatures in play — in when they are close, out when they
 * spread. A close-up (a big moment) takes over for a while, still eased, then hands back. Display only: `dt` is real
 * time (or slowed time, as the caller likes), never a fight step.
 */
export class StageCamera {
  /** Where the camera looks now (eased), and the screen's shape: what the edge bubbles place themselves by. */
  readonly view: View;
  private readonly goal: Framing = { cx: 0, cy: 0, height: 0 };
  private readonly close: Framing = { cx: 0, cy: 0, height: 0 };
  /** Seconds the close-up has left (0 when there is none). */
  private closeLeft = 0;

  constructor(private readonly camera: PerspectiveCamera, private readonly level: Level) {
    const f = framing([], level.camera, camera.aspect);
    this.view = { cx: f.cx, cy: f.cy, height: f.height, aspect: safeAspect(camera.aspect) };
    camera.rotation.set(0, 0, 0); // looking straight along −z, x right, y up
    this.place();
  }

  /**
   * Eases toward the framing of `targets` (the creatures in play only), or the close-up while one is on. `dt` is real
   * seconds (unslowed, so a close-up lasts a fixed time on the clock); a broken or negative one counts as none.
   */
  update(targets: readonly { x: number; y: number; h: number }[], dt: number): void {
    // a broken frame time (NaN, infinite, zero or negative) counts as no time: it must never poison the view
    if (!(Number.isFinite(dt) && dt > 0)) dt = 0;
    const aspect = safeAspect(this.camera.aspect);
    this.view.aspect = aspect;
    const g = this.goal;
    if (this.closeLeft > 0) {
      this.closeLeft -= dt;
      g.cx = this.close.cx;
      g.cy = this.close.cy;
      g.height = this.close.height;
      fitInto(g, this.level.camera, aspect);
    } else {
      framing(targets, this.level.camera, aspect, g);
    }
    const k = 1 - Math.exp(-CAM.ease * dt);
    const v = this.view;
    v.cx += (g.cx - v.cx) * k;
    v.cy += (g.cy - v.cy) * k;
    v.height += (g.height - v.height) * k;
    this.place();
  }

  /**
   * Shows a view `height` m tall centred on `at` for `seconds` (a knockout launch, a landed special: Task 14),
   * eased in and out like any other move of the camera; normal framing resumes after.
   */
  closeUp(at: V2, height: number, seconds: number): void {
    this.close.cx = Number.isFinite(at.x) ? at.x : this.view.cx;
    this.close.cy = Number.isFinite(at.y) ? at.y : this.view.cy;
    this.close.height = MathUtils.clamp(Number.isFinite(height) ? height : CAM.minHeight, CLOSE_UP_MIN, CAM.maxHeight);
    this.closeLeft = Math.max(0, seconds);
  }

  /** Puts the camera where it shows `view`: far enough back along +z that its field of view spans `view.height`. */
  private place(): void {
    const c = this.camera, v = this.view;
    const dist = v.height / 2 / Math.tan(MathUtils.degToRad(c.fov) / 2);
    c.position.set(v.cx, v.cy, dist);
    c.updateMatrixWorld();
  }
}
