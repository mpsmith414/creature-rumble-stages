import { safeAspect, type View } from './stage-camera';
import './show.css';

/** The arrow's tip floats this far over the creature's head (m). */
export const ARROW_ABOVE = 0.3;
/** An arrow this near the top of the screen (share of its height) is hidden: the creature's head is out of view. */
const TOP_MARGIN = 0.06;

/**
 * Where the arrow over a creature with its box at (`x`, `y`), `h` tall goes on the screen (fractions; `top` 0 at the
 * top), or false when that is off the screen (its edge bubble shows where it is then). Pure; fills `out`.
 */
export function arrowSpot(x: number, y: number, h: number, view: View, out: { left: number; top: number }): boolean {
  const sx = 0.5 + (x - view.cx) / (view.height * safeAspect(view.aspect));
  const sy = 0.5 - (y + h + ARROW_ABOVE - view.cy) / view.height;
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;
  out.left = sx;
  out.top = sy;
  return sx >= 0 && sx <= 1 && sy >= TOP_MARGIN && sy <= 1;
}

const _spot = { left: 0, top: 0 };

/**
 * A small arrow in a controller's colour floating over the creature it steers (with the player's number), so a child
 * finds theirs at a glance; dimmed and sleepy (z z z) while the pad is put down and the AI drives. A DOM overlay like the edge bubbles: one element per steered creature, only moved.
 */
export class PadArrows {
  readonly el: HTMLDivElement;
  private readonly arrows = new Map<string, HTMLDivElement>();

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'stage-arrows';
    parent.append(this.el);
  }

  /**
   * Creature `id` gets an arrow in `colour` with `label` (the player's number), dimmed with a sleepy "z z z" while its
   * pad rests; a null colour takes it away.
   */
  set(id: string, colour: string | null, label = '', resting = false): void {
    let a = this.arrows.get(id);
    if (!colour) {
      a?.remove();
      this.arrows.delete(id);
      return;
    }
    if (!a) {
      a = document.createElement('div');
      a.className = 'stage-arrow';
      a.hidden = true;
      this.el.append(a);
      this.arrows.set(id, a);
    }
    a.style.setProperty('--pad', colour);
    a.textContent = label;
    a.classList.toggle('resting', resting);
  }

  /** Whether creature `id` has an arrow. */
  has(id: string): boolean {
    return this.arrows.has(id);
  }

  /** Each frame, after the camera: every arrow over its creature (`at` gives its box as drawn; none: hidden). */
  update(at: (id: string) => { x: number; y: number; h: number } | undefined, view: View): void {
    for (const [id, a] of this.arrows) {
      const b = at(id);
      const on = !!b && arrowSpot(b.x, b.y, b.h, view, _spot);
      if (a.hidden !== !on) a.hidden = !on;
      if (!on) continue;
      a.style.left = `${(_spot.left * 100).toFixed(2)}%`;
      a.style.top = `${(_spot.top * 100).toFixed(2)}%`;
    }
  }

  dispose(): void {
    this.el.remove();
    this.arrows.clear();
  }
}
