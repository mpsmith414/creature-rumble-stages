import { describe, expect, test } from 'vitest';
import { TUNE } from '../../src/fight/tune';
import { bigLaunch, SlowMo } from '../../src/show/slowmo';

test('slow-mo fires once per cooldown', () => {
  const s = new SlowMo();
  expect(s.trigger(10)).toBe(true); expect(s.timeScale(10.4)).toBeCloseTo(0.25);
  expect(s.timeScale(11)).toBe(1); expect(s.trigger(12)).toBe(false); expect(s.trigger(16.1)).toBe(true);
});

describe('SlowMo', () => {
  test('runs at full speed until triggered', () => {
    const s = new SlowMo();
    expect(s.timeScale(0)).toBe(1);
    expect(s.timeScale(123)).toBe(1);
  });

  test('eases back to full speed over the last moment, never below the scale nor above 1', () => {
    const s = new SlowMo();
    s.trigger(0);
    let last = 0;
    for (let t = 0; t <= 0.8; t += 0.01) {
      const k = s.timeScale(t);
      expect(k).toBeGreaterThanOrEqual(0.25 - 1e-9);
      expect(k).toBeLessThanOrEqual(1);
      expect(k).toBeGreaterThanOrEqual(last - 1e-9);
      last = k;
    }
    expect(s.timeScale(0.7)).toBeGreaterThan(0.25);
    expect(s.timeScale(0.8)).toBe(1);
  });

  test('takes its scale, length and cooldown', () => {
    const s = new SlowMo({ scale: 0.5, seconds: 2, cooldown: 3 });
    expect(s.trigger(0)).toBe(true);
    expect(s.timeScale(1)).toBeCloseTo(0.5);
    expect(s.trigger(2.9)).toBe(false);
    expect(s.trigger(3)).toBe(true);
  });

  test('is not slowed before the moment it was triggered (a clock running backwards)', () => {
    const s = new SlowMo();
    s.trigger(10);
    expect(s.timeScale(9)).toBe(1);
  });
});

describe('bigLaunch: a big rag-doll flight near the edge', () => {
  const R = TUNE.ringRadius, B = TUNE.bigLaunch;
  const big = { reaction: 'big', launch: 6 }, pop = { reaction: 'pop', launch: B - 0.5 }, stagger = { reaction: 'stagger', launch: 3 };

  test('needs the target near the edge and a big reaction', () => {
    expect(bigLaunch({ x: R - 1.5, z: 0 }, R, big, B)).toBe(true);
    expect(bigLaunch({ x: 0, z: -(R - 1) }, R, big, B)).toBe(true);
    expect(bigLaunch({ x: R - 2.5, z: 0 }, R, big, B)).toBe(false); // too far in
    expect(bigLaunch({ x: R - 1, z: 0 }, R, pop, B)).toBe(false); // a pop lands on its feet: no slow-mo
    expect(bigLaunch({ x: R - 1, z: 0 }, R, stagger, B)).toBe(false);
  });

  test('a launch of bigLaunch m/s or faster counts whatever its reaction says', () => {
    expect(bigLaunch({ x: R - 1, z: 0 }, R, { reaction: 'none', launch: B }, B)).toBe(true);
    expect(bigLaunch({ x: 0, z: 0 }, R, { reaction: 'big', launch: 20 }, B)).toBe(false); // far from the edge
  });
});
