import { describe, expect, it } from 'vitest';
import { damageStep, knockback, STAGE_TUNE } from '../../src/stage/damage';

describe('knockback', () => {
  it('knockback grows with damage and power, shrinks with weight', () => {
    let last = 0;
    for (let d = 0; d <= 200; d += 10) {
      const k = knockback(1, d, 1);
      expect(k).toBeGreaterThan(last);
      last = k;
    }
    last = 0;
    for (let p = 0.5; p <= 2; p += 0.25) {
      const k = knockback(p, 50, 1);
      expect(k).toBeGreaterThan(last);
      last = k;
    }
    last = Infinity;
    for (let w = 0.6; w <= 1.6; w += 0.1) {
      const k = knockback(1, 50, w);
      expect(k).toBeLessThan(last);
      last = k;
    }
  });

  it('a fresh creature is pushed, a well-hit one flies (average weight)', () => {
    expect(knockback(1, 10, 1)).toBeLessThan(STAGE_TUNE.tumbleFrom);
    expect(knockback(1, 120, 1)).toBeGreaterThan(STAGE_TUNE.tumbleFrom);
  });

  it('takes its numbers from the tune it is given', () => {
    const soft = { ...STAGE_TUNE, kbGrowth: STAGE_TUNE.kbGrowth / 2 };
    expect(knockback(1, 100, 1, soft)).toBeLessThan(knockback(1, 100, 1));
  });
});

describe('damageStep', () => {
  it('damage steps at 40, 80, 125', () => {
    expect(STAGE_TUNE.damageSteps).toEqual([40, 80, 125]);
    expect(damageStep(0)).toBe(0);
    expect(damageStep(39)).toBe(0);
    expect(damageStep(40)).toBe(1);
    expect(damageStep(79.9)).toBe(1);
    expect(damageStep(80)).toBe(2);
    expect(damageStep(124)).toBe(2);
    expect(damageStep(125)).toBe(3);
    expect(damageStep(500)).toBe(3);
  });

  it('a hit freezes for 4 steps', () => {
    expect(STAGE_TUNE.hitFreeze).toBe(4);
  });
});
