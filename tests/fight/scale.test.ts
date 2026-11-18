import { describe, expect, it } from 'vitest';
import { fightScale } from '../../src/fight/scale';

describe('fightScale', () => {
  it('brings every creature to a ring height between 0.7 m and 2.4 m', () => {
    expect(0.02 * fightScale(0.02)).toBeCloseTo(0.7, 6);
    expect(1 * fightScale(1)).toBeCloseTo(1.4, 6);
    expect(8 * fightScale(8)).toBeCloseTo(2.4, 6);
  });
  it('keeps taller creatures taller in the ring (until the cap)', () => {
    const ring = (h: number) => h * fightScale(h);
    expect(ring(0.5)).toBeLessThan(ring(1));
    expect(ring(1)).toBeLessThan(ring(2));
  });
});
