import type { MischiefData } from './mischief';
import type { V2 } from './types';

/**
 * A platform is a box. `x, y` is the centre of its top edge (at path phase 0), `w, h` its width and depth below the
 * top. A solid platform blocks from every side; a thin one is only stood on from above (jump up through it, drop down
 * through it). A platform with a path swings back and forth: offset = (dx, dy) × sin(2π t / period). A `bounce` platform
 * (the toy room's bed) springs whoever lands on it straight back up at their jump speed × `bounce`: nobody stands on it,
 * so it is no floor for the brains' routes.
 */
export type Platform = {
  id: string;
  kind: 'solid' | 'thin';
  x: number;
  y: number;
  w: number;
  h: number;
  path?: { dx: number; dy: number; period: number };
  bounce?: number;
};

/** An axis-aligned rectangle (m). */
export type Bounds = { left: number; right: number; bottom: number; top: number };

export type LevelId = 'test' | 'jungle' | 'ship' | 'toyroom';

/**
 * A level as data: its platforms, gravity (m/s²), the edge bounds (crossing them is out), the area the camera keeps
 * in view, where fighters enter, the x positions presents drop at, and the mischief it has (what each needs to know
 * about the level: see `mischief.ts`). A level object is never changed once made (the brains' route graphs are cached
 * by it); low gravity swaps in another level object.
 */
export type Level = {
  id: LevelId;
  name: string;
  gravity: number;
  platforms: Platform[];
  bounds: Bounds;
  camera: Bounds;
  entries: V2[];
  drops: number[];
  mischief: MischiefData[];
};

const TAU = Math.PI * 2;

/**
 * The level's platforms placed where they are at time t (s): moving ones along their path, the rest as they are.
 * Same order as `level.platforms`. Pure; reuses `out` and the platform objects already in it, so a caller stepping
 * every frame allocates nothing.
 */
export function platformsAt(level: Level, t: number, out: Platform[] = []): Platform[] {
  const ps = level.platforms;
  out.length = ps.length;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const o = out[i] ?? (out[i] = { ...p });
    o.id = p.id;
    o.kind = p.kind;
    o.w = p.w;
    o.h = p.h;
    o.path = p.path;
    o.bounce = p.bounce;
    if (p.path) {
      const s = Math.sin((TAU * t) / p.path.period);
      o.x = p.x + p.path.dx * s;
      o.y = p.y + p.path.dy * s;
    } else {
      o.x = p.x;
      o.y = p.y;
    }
  }
  return out;
}

/** Slack for "inside a solid" checks (m), far below anything visible. */
const SOLID_EPS = 1e-6;

/** The solid platform a box (bottom centre x, y; w × h) would overlap among `ps`, or null. */
export function solidAt(ps: readonly Platform[], x: number, y: number, w: number, h: number): Platform | null {
  for (const p of ps) {
    if (p.kind !== 'solid') continue;
    if (x - w / 2 < p.x + p.w / 2 - SOLID_EPS && x + w / 2 > p.x - p.w / 2 + SOLID_EPS && y < p.y - SOLID_EPS
      && y + h > p.y - p.h + SOLID_EPS) return p;
  }
  return null;
}

/**
 * The top of the highest platform among `ps` under `x` whose top is at or below height `y`, or null where nothing is
 * under (what something falling at (x, y) lands on: never a platform over its head).
 */
export function topBelow(ps: readonly Platform[], x: number, y: number): number | null {
  let top: number | null = null;
  for (const p of ps) {
    if (Math.abs(x - p.x) <= p.w / 2 && p.y <= y && (top === null || p.y > top)) top = p.y;
  }
  return top;
}
