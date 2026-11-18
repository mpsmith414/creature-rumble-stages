/** Fighting heights (m) are squeezed into this range, so a mouse and a dinosaur can share a level. */
const HEIGHT_MIN = 0.7, HEIGHT_MAX = 2.4;

/**
 * The factor a creature of `naturalHeight` metres is scaled by to fight: its fighting height is
 * clamp(1.4 × naturalHeight^0.35, 0.7, 2.4) m, so small creatures grow and big ones shrink, but order is kept.
 */
export function fightScale(naturalHeight: number): number {
  const height = Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, 1.4 * naturalHeight ** 0.35));
  return height / naturalHeight;
}
