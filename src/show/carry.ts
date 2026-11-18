import { solidAt, type Platform } from '../stage/level';
import type { V2 } from '../stage/types';

/**
 * The champion's carry up to the top platform (spec §9.2), as a path its box (bottom centre; w × h) follows: a smooth
 * arc from where it stood when nothing is in the way, else a route clear of every solid platform (no creature is ever
 * drawn passing through a solid: the owner's first rule, at the moment everyone watches). The route goes sideways first
 * to get out from under anything solid overhead, then up, over and down onto the top spot. Pure; display only.
 */

/** The arc rises this high (m) over the straight way there; the route crosses this high over the highest solid or the top spot. */
export const CARRY_ARC = 1.5;
/** The arc is checked against the solids at this spacing along it (m) at least, and at this many points at least. */
const CHECK_EVERY = 0.02, CHECK_MIN = 64;
/** The sideways search: steps of this many metres, up to this far either way. */
const SIDE_STEP = 0.25, SIDE_MAX = 40;
/**
 * Room kept from every solid (m) to the box's sides and top (not its feet: it starts standing on a floor and ends on
 * the top spot), so the arc never grazes a corner between the points it is checked at.
 */
const ROOM = 0.05;

const smooth = (k: number) => k * k * (3 - 2 * k);

/**
 * Where the carry is at `k` (0 … 1 of its time) into `out`: along `route` (from `carryRoute`), or with a null route the
 * plain arc from `from` to `to`. Eased in and out; it starts on `from` and ends exactly on `to`.
 */
export function carryAt(from: V2, to: V2, route: readonly V2[] | null, k: number, out: V2): V2 {
  const t = Math.min(1, Math.max(0, k)), e = smooth(t);
  if (!route) {
    out.x = from.x + (to.x - from.x) * e;
    out.y = from.y + (to.y - from.y) * e + Math.sin(Math.PI * t) * CARRY_ARC;
    return out;
  }
  let total = 0;
  for (let i = 1; i < route.length; i++) total += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
  let left = e * total;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i], len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len && len > 0) {
      const s = left / len;
      out.x = a.x + (b.x - a.x) * s;
      out.y = a.y + (b.y - a.y) * s;
      return out;
    }
    left -= len;
  }
  const end = route[route.length - 1] ?? to;
  out.x = end.x;
  out.y = end.y;
  return out;
}

/**
 * The way a `w` × `h` box is carried from `from` to `to` among platforms `ps`: null when the plain arc overlaps no solid
 * anywhere along it; else the corners of a route clear of them (sideways out from under any solid overhead, up to a
 * height over every solid and the top spot, across, down onto `to`). Should no way out be found (it never is on our
 * levels), the straight way.
 */
export function carryRoute(ps: readonly Platform[], from: V2, to: V2, w: number, h: number): V2[] | null {
  const at: V2 = { x: 0, y: 0 };
  /** The box (bottom centre x, y; `bw` wide, `bh` tall) with room kept round it overlaps a solid. */
  const blocked = (x: number, y: number, bw: number, bh: number) => solidAt(ps, x, y, bw + 2 * ROOM, bh + ROOM) !== null;
  const n = Math.max(CHECK_MIN, Math.ceil((Math.hypot(to.x - from.x, to.y - from.y) + 2 * CARRY_ARC) / CHECK_EVERY));
  let clear = true;
  for (let i = 0; i <= n && clear; i++) {
    carryAt(from, to, null, i / n, at);
    clear = !blocked(at.x, at.y, w, h);
  }
  if (clear) return null;

  // over every solid's top (a box standing at or above a solid's top never overlaps it) and the top spot
  let cruise = Math.max(from.y, to.y + CARRY_ARC);
  for (const p of ps) if (p.kind === 'solid') cruise = Math.max(cruise, p.y + CARRY_ARC);
  /** The box rising (or sinking) at `x` between heights `a` and `b` meets no solid. */
  const column = (x: number, a: number, b: number) => !blocked(x, Math.min(a, b), w, Math.abs(b - a) + h);
  /** The box moving along at height `y` from `a` to `b` meets no solid. */
  const along = (y: number, a: number, b: number) => !blocked((a + b) / 2, y, Math.abs(b - a) + w, h);
  const over = (x: number): V2[] => [{ x, y: cruise }, { x: to.x, y: cruise }, { x: to.x, y: to.y }];

  if (column(from.x, from.y, cruise)) return [{ ...from }, ...over(from.x)];
  // sideways first (toward the top spot on a tie), till nothing solid is overhead
  const toward = to.x >= from.x ? 1 : -1;
  for (let d = SIDE_STEP; d <= SIDE_MAX; d += SIDE_STEP) {
    for (const dir of [toward, -toward]) {
      const x = from.x + dir * d;
      if (along(from.y, from.x, x) && column(x, from.y, cruise)) return [{ ...from }, { x, y: from.y }, ...over(x)];
    }
  }
  return [{ ...from }, { ...to }];
}
