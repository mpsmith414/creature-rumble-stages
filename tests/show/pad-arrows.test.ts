import { describe, expect, test } from 'vitest';
import { ARROW_ABOVE, arrowSpot } from '../../src/show/pad-arrows';

describe('arrowSpot: the arrow over a steered creature', () => {
  const view = { cx: 0, cy: 5, height: 10, aspect: 2 };
  test('floats just over its head, where it is on the screen', () => {
    const out = { left: 0, top: 0 };
    expect(arrowSpot(0, 0, 2, view, out)).toBe(true);
    expect(out.left).toBeCloseTo(0.5);
    expect(out.top).toBeCloseTo(0.5 - (2 + ARROW_ABOVE - 5) / 10);
    expect(arrowSpot(5, 0, 2, view, out)).toBe(true);
    expect(out.left).toBeCloseTo(0.75);
  });

  test('none while its head is off the screen (its edge bubble shows it), nor for a broken view', () => {
    const out = { left: 0, top: 0 };
    expect(arrowSpot(30, 0, 2, view, out)).toBe(false);
    expect(arrowSpot(0, 9.8, 2, view, out)).toBe(false);
    expect(arrowSpot(0, -20, 2, view, out)).toBe(false);
    expect(arrowSpot(NaN, 0, 2, view, out)).toBe(false);
  });
});
