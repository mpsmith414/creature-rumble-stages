import { describe, expect, test } from 'vitest';
import { EMPTY_PAD, readPad, type PadState } from '../../src/shared/input';
import { ALL_HELD, PAD_DEAD_ZONE, padIntent } from '../../src/stage/pad-intent';
import { NO_INTENT, type Intent } from '../../src/stage/types';

const pad = (o: Partial<PadState> = {}): PadState => ({ ...EMPTY_PAD, ...o });
const fresh = (): Intent => ({ ...NO_INTENT });

describe('padIntent: a controller as a fighter wants it', () => {
  test('the buttons: A jump, X attack, Y special, B grab, RB item, LB or RT dodge', () => {
    const none = pad();
    expect(padIntent(none, pad({ a: true })).jump).toBe(true);
    expect(padIntent(none, pad({ x: true })).attack).toBe(true);
    expect(padIntent(none, pad({ y: true })).special).toBe(true);
    expect(padIntent(none, pad({ b: true })).grab).toBe(true);
    expect(padIntent(none, pad({ rb: true })).item).toBe(true);
    expect(padIntent(none, pad({ lb: true })).dodge).toBe(true);
    expect(padIntent(none, pad({ rt: true })).dodge).toBe(true);
    // nothing else does anything
    expect(padIntent(none, pad({ lt: true, start: true, select: true }))).toEqual(NO_INTENT);
    // one button wants one thing
    const a = padIntent(none, pad({ a: true }));
    expect({ ...a, jump: false }).toEqual(NO_INTENT);
  });

  test('the left stick moves (x right, y up) and the d-pad does too, never past full', () => {
    const none = pad();
    expect(padIntent(none, pad({ lx: 1 })).mx).toBe(1);
    expect(padIntent(none, pad({ lx: -1 })).mx).toBe(-1);
    expect(padIntent(none, pad({ ly: -1 })).my).toBe(1); // the stick's y is down-positive; the fight's is up
    expect(padIntent(none, pad({ ly: 1 })).my).toBe(-1);
    expect(padIntent(none, pad({ right: true })).mx).toBe(1);
    expect(padIntent(none, pad({ left: true })).mx).toBe(-1);
    expect(padIntent(none, pad({ up: true })).my).toBe(1);
    expect(padIntent(none, pad({ down: true })).my).toBe(-1);
    expect(padIntent(none, pad({ right: true, lx: 1 })).mx).toBe(1);
    expect(padIntent(none, pad({ right: true, lx: -1 })).mx).toBe(0);
    // the right stick does not steer
    expect(padIntent(none, pad({ rx: 1, ry: 1 }))).toEqual(NO_INTENT);
  });

  test('one dead zone of 0.2 on the stick as the browser gives it: a half push is 0.375, full tilt is full', () => {
    const raw = (lx: number, ly = 0) => readPad({ axes: [lx, ly, 0, 0], buttons: [] });
    const none = pad();
    expect(padIntent(none, raw(0.5)).mx).toBeCloseTo(0.375);
    expect(padIntent(none, raw(-0.5)).mx).toBeCloseTo(-0.375);
    expect(padIntent(none, raw(0, -0.5)).my).toBeCloseTo(0.375);
    expect(padIntent(none, raw(1)).mx).toBe(1);
    expect(padIntent(none, raw(0.19)).mx).toBe(0);
    expect(padIntent(none, raw(0.21)).mx).toBeGreaterThan(0);
  });

  test('a dead zone of 0.2: a resting stick wants nothing, past it the stick counts from 0 to full', () => {
    expect(PAD_DEAD_ZONE).toBe(0.2);
    const none = pad();
    for (const v of [0.05, 0.19, 0.2, -0.2, -0.1]) {
      const i = padIntent(none, pad({ lx: v, ly: v }));
      expect([i.mx, i.my], String(v)).toEqual([0, 0]);
    }
    expect(padIntent(none, pad({ lx: 0.6 })).mx).toBeCloseTo(0.5);
    expect(padIntent(none, pad({ lx: -0.6 })).mx).toBeCloseTo(-0.5);
    expect(padIntent(none, pad({ ly: 0.6 })).my).toBeCloseTo(-0.5);
    expect(padIntent(none, pad({ lx: 0.21 })).mx).toBeGreaterThan(0);
  });

  test('press edges: a button counts from its press, held on for as long as it stays down', () => {
    const out = fresh();
    expect(padIntent(pad(), pad({ a: true }), out).jump).toBe(true); // pressed
    expect(padIntent(pad({ a: true }), pad({ a: true }), out).jump).toBe(true); // held on
    expect(padIntent(pad({ a: true }), pad(), out).jump).toBe(false); // let go
    expect(padIntent(pad(), pad({ a: true }), out).jump).toBe(true); // pressed again
  });

  test('press edges: a button already down when the pad took the fighter counts only once let go and pressed again', () => {
    // the A that picked the creature in the picker is still down: the creature must not jump at once
    const out = fresh();
    expect(padIntent(ALL_HELD, pad({ a: true, x: true }), out)).toEqual(NO_INTENT);
    expect(padIntent(pad({ a: true, x: true }), pad({ a: true, x: true }), out)).toEqual(NO_INTENT);
    expect(padIntent(pad({ a: true, x: true }), pad({ x: true }), out).jump).toBe(false);
    expect(padIntent(pad({ x: true }), pad({ a: true, x: true }), out)).toMatchObject({ jump: true, attack: false });
    // the stick is never held back: it is where it is
    expect(padIntent(ALL_HELD, pad({ lx: 1 }), fresh()).mx).toBe(1);
  });

  test('dodge on LB or RT: either one pressed counts, and it holds while either stays down', () => {
    const out = fresh();
    expect(padIntent(pad(), pad({ rt: true }), out).dodge).toBe(true);
    expect(padIntent(pad({ rt: true }), pad({ rt: true, lb: true }), out).dodge).toBe(true);
    expect(padIntent(pad({ rt: true, lb: true }), pad({ lb: true }), out).dodge).toBe(true);
    expect(padIntent(pad({ lb: true }), pad(), out).dodge).toBe(false);
  });

  test('fills and returns `out` (no allocation per step)', () => {
    const out = fresh();
    expect(padIntent(pad(), pad({ a: true }), out)).toBe(out);
  });
});
