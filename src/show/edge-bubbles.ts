import { safeAspect, type View } from './stage-camera';
import './show.css';

export type { View } from './stage-camera';

/** A creature as the bubbles need it: its box (bottom-centre `x, y`, height `h`, m), its colour (CSS) and its name. */
export type BubbleFighter = { id: string; x: number; y: number; h: number; color: string; name: string };
/** Where a bubble goes (fractions of the screen; `top` 0 at the top) and the way it points (degrees, 0 = right, 90 = down). */
export type BubbleSpot = { left: number; top: number; angle: number };

/**
 * How far in from the screen's edge a bubble's centre sits, as a fraction of the screen's height (the same distance on
 * the sides): the bubble's radius, its rim and its pointer (= the CSS sizes) fit inside.
 */
export const BUBBLE_INSET = 0.08;
/** The most bubbles at once: one per creature a stage holds. */
const POOL = 8;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Whether a creature with its box at (`x`, `y`), `h` tall is outside `view` (its middle is off the screen), and if so
 * where its bubble goes: the creature's place on the screen held in by `BUBBLE_INSET` from each edge, pointing from
 * there toward it. The camera looks straight along −z, so the plane z = 0 maps to the screen without perspective
 * skew. Pure; fills `out`.
 */
export function bubbleSpot(x: number, y: number, h: number, view: View, out: BubbleSpot): boolean {
  const aspect = safeAspect(view.aspect);
  const sx = 0.5 + (x - view.cx) / (view.height * aspect);
  const sy = 0.5 - (y + h / 2 - view.cy) / view.height;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;
  if (sx >= 0 && sx <= 1 && sy >= 0 && sy <= 1) return false;
  const ix = BUBBLE_INSET / aspect, iy = BUBBLE_INSET;
  out.left = Math.min(1 - ix, Math.max(ix, sx));
  out.top = Math.min(1 - iy, Math.max(iy, sy));
  // measured in screen heights both ways so the angle is the one seen on the screen
  out.angle = Math.atan2(sy - out.top, (sx - out.left) * aspect) * RAD_TO_DEG;
  return true;
}

/** The letter on a bubble: the first letter of the name, upper case ("?" for no name). */
const initial = (name: string) => (Array.from(name.trim())[0] ?? '?').toUpperCase();

const _spot: BubbleSpot = { left: 0, top: 0, angle: 0 };

/**
 * Face bubbles at the screen's edge (spec §9.1): a creature that flies out of the view shows as a round bubble in its
 * colour with its initial, held at the nearest edge and pointing to where it is, so nobody is lost off screen. A DOM
 * overlay like `Pops`: a fixed pool of elements, only moved and recoloured as the fight goes.
 */
export class EdgeBubbles {
  readonly el: HTMLDivElement;
  private readonly pool: HTMLDivElement[] = [];
  private readonly faces: HTMLSpanElement[] = [];
  /** What each bubble shows now, so the page is only touched when it changes. */
  private readonly shown: { color: string; name: string }[] = [];
  private disposed = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'stage-bubbles';
    parent.append(this.el);
    for (let i = 0; i < POOL; i++) {
      const b = document.createElement('div');
      b.className = 'stage-bubble';
      b.hidden = true;
      const arrow = document.createElement('div');
      arrow.className = 'stage-bubble-arrow';
      const face = document.createElement('span');
      face.className = 'stage-bubble-face';
      b.append(arrow, face);
      this.el.append(b);
      this.pool.push(b);
      this.faces.push(face);
      this.shown.push({ color: '', name: '' });
    }
  }

  /** Shows a bubble for each of `fighters` (those in play) outside `view` and hides the rest (nothing after `dispose`). */
  update(fighters: readonly BubbleFighter[], view: View): void {
    if (this.disposed) return;
    let used = 0;
    for (let i = 0; i < fighters.length && used < POOL; i++) {
      const f = fighters[i];
      if (!bubbleSpot(f.x, f.y, f.h, view, _spot)) continue;
      const b = this.pool[used], was = this.shown[used];
      if (was.color !== f.color) {
        b.style.setProperty('--c', f.color);
        was.color = f.color;
      }
      if (was.name !== f.name) {
        this.faces[used].textContent = initial(f.name);
        was.name = f.name;
      }
      b.style.left = `${_spot.left * 100}%`;
      b.style.top = `${_spot.top * 100}%`;
      b.style.setProperty('--a', `${_spot.angle}deg`);
      b.hidden = false;
      used++;
    }
    for (let i = used; i < POOL; i++) if (!this.pool[i].hidden) this.pool[i].hidden = true;
  }

  /** Takes every bubble off the page. */
  dispose(): void {
    this.disposed = true;
    this.el.remove();
    this.pool.length = 0;
    this.faces.length = 0;
    this.shown.length = 0;
  }
}
