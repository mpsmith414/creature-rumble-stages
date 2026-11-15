export const MAX_IN_RING = 8;
export const ENTRANCE_S = 8.5;
export const GROUP_ENTRANCE_S = 5;
export const SHARE_WINDOW_S = 1.5;

export type MatchEvent =
  | { type: 'entranceStart'; ids: string[]; group: boolean }
  | { type: 'entranceEnd'; ids: string[] }
  | { type: 'ringOut'; ids: string[] }
  | { type: 'holdsRing'; id: string }
  | { type: 'lone'; id: string }
  | { type: 'tie'; ids: string[] }
  | { type: 'crowned'; id: string; others: string[] }
  | { type: 'again'; ids: string[] };

/** True when a fighter is no longer in play: broken numbers, fallen below the floor, or far outside the ring. */
export function isOut(p: { x: number; y: number; z: number }, ringRadius: number): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return true;
  if (p.y < -2.5) return true;
  return Math.hypot(p.x, p.z) > ringRadius + 4;
}

/** A torso this far (m) under the ring top is under the floor (a little lower is the solver still pushing it out). */
export const UNDER_FLOOR_Y = -0.15;
/** …when it is at least this far (m) in from the ring's edge (nearer the edge it may just be falling off). */
export const UNDER_FLOOR_IN = 0.3;

/**
 * True when a torso is under the ring's floor inside the ring: it has passed through the floor (the fight loop lifts
 * it back up). Broken numbers are not: `isOut` rules those out.
 */
export function isUnderFloor(p: { x: number; y: number; z: number }, ringRadius: number): boolean {
  return p.y < UNDER_FLOOR_Y && Math.hypot(p.x, p.z) < ringRadius - UNDER_FLOOR_IN;
}
