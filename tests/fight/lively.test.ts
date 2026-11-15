import { describe, expect, test } from 'vitest';
import { livelyOf, summarize, type BoutResult, type Lively } from '../../src/fight/sim';

/** A bout that only says how long it was fought and how lively it was (all `livelyOf` reads). */
const bout = (fightSeconds: number, l: Partial<Lively>): BoutResult => ({
  fightSeconds,
  lively: { leaps: 0, dashes: 0, dodges: 0, ropeSprings: 0, airChases: 0, metres: 0, still: 0, unstunned: 0, ...l },
}) as BoutResult;

describe('livelyOf (pooling bouts)', () => {
  test('rates are weighted by fighting time, `still` by unstunned time', () => {
    // 60 fighter-s at 10 leaps a minute and 300 fighter-s at 4: 10 + 20 leaps in 6 minutes = 5 a minute
    const a = bout(60, { leaps: 10, metres: 100, ropeSprings: 1, still: 0.5, unstunned: 20 });
    const b = bout(300, { leaps: 4, metres: 160, ropeSprings: 0, still: 0.1, unstunned: 180 });
    const l = livelyOf([a, b]);
    expect(l.leaps).toBeCloseTo(5);
    expect(l.metres).toBeCloseTo((100 * 60 + 160 * 300) / 360);
    expect(l.ropeSprings).toBeCloseTo(60 / 360);
    // 10 s still of 20 and 18 s of 180: 28 of 200
    expect(l.still).toBeCloseTo(28 / 200);
    expect(l.unstunned).toBe(200);
  });

  test('no fighting at all is all zeros, not NaN', () => {
    const l = livelyOf([bout(0, {})]);
    expect(l.leaps).toBe(0);
    expect(l.still).toBe(0);
    expect(livelyOf([]).metres).toBe(0);
  });
});

describe('summarize: grab and throw', () => {
  /** A finished bout with `outs` ring-outs, `throws` throws and `throwOuts` of the ring-outs straight from a throw. */
  const fought = (outs: number, throws: number, throwOuts: number, padJumps = 0, events = 0): BoutResult => ({
    ringOuts: Array.from({ length: outs }, (_, i) => ({ id: `x-${i}`, t: 10 * (i + 1) })), winner: null, longestQuiet: 1,
    hits: {}, end: 10 * outs, timedOut: false, launches: [], specials: {}, fightSeconds: 100, outDanger: [], dangerSamples: [],
    lively: { leaps: 0, dashes: 0, dodges: 0, ropeSprings: 0, airChases: 0, metres: 0, still: 0, unstunned: 0 }, throws, throwOuts,
    padJumps, events, bonks: events, bumps: 2 * events,
  });

  test('the median bout’s throws, throws a bout, and the share of ring-outs straight from a throw', () => {
    const r = summarize([fought(3, 0, 0), fought(3, 2, 1), fought(2, 5, 2)], [[], [], []], 240);
    expect(r.medianThrows).toBe(2);
    expect(r.throwsPerBout).toBeCloseTo(7 / 3);
    expect(r.throwOutShare).toBeCloseTo(3 / 8);
  });

  test('the wild ring per bout: pad jumps, events, bonks and post kicks', () => {
    const r = summarize([fought(3, 0, 0, 4, 1), fought(3, 0, 0, 2, 3)], [[], []], 240);
    expect(r.ring).toEqual({ padJumps: 3, events: 2, bonks: 2, bumps: 4 });
    expect(summarize([], [], 240).ring).toEqual({ padJumps: 0, events: 0, bonks: 0, bumps: 0 });
  });

  test('no ring-outs: no share, not NaN', () => {
    expect(summarize([fought(0, 1, 0)], [[]], 240).throwOutShare).toBe(0);
  });
});
