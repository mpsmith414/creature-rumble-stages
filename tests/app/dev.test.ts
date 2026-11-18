import { describe, expect, test } from 'vitest';
import { fillSpecial, FrameMeter } from '../../src/app/dev';

const fighter = (id: string) => ({ id, meter: 0 });

describe('the dev panel’s S key', () => {
  test('fills the next fighter’s special meter, round the stage in order', () => {
    const fs = [fighter('a'), fighter('b'), fighter('c')];
    expect(fillSpecial(fs, null)?.id).toBe('a');
    expect(fs[0].meter).toBe(1);
    expect(fillSpecial(fs, 'a')?.id).toBe('b');
    expect(fillSpecial(fs, 'c')?.id).toBe('a');
    expect(fs[2].meter).toBe(0);
  });

  test('does nothing with nobody on the stage', () => {
    expect(fillSpecial([], null)).toBeNull();
  });
});

describe('the dev panel’s frame-time readout (final review minor)', () => {
  test('the average frame time over the last second, given every quarter second', () => {
    const meter = new FrameMeter();
    const read: number[] = [];
    for (let i = 0; i <= 120; i++) {
      const ms = meter.frame(i * 20); // 50 frames a second
      if (ms !== null) read.push(ms);
    }
    expect(read.length).toBeGreaterThanOrEqual(8); // 2.4 s at 4 a second
    expect(read.length).toBeLessThanOrEqual(11);
    expect(read.at(-1)).toBeCloseTo(20, 6);
    // a slow second (25 ms frames) shows once it fills the last second
    for (let i = 1; i <= 50; i++) {
      const ms = meter.frame(2400 + i * 25);
      if (ms !== null) read.push(ms);
    }
    expect(read.at(-1)).toBeCloseTo(25, 6);
  });
});
