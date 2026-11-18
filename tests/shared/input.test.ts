import { describe, expect, it } from 'vitest';
import { nextFocus, type Rect } from '../../src/shared/focus';
import { EMPTY_PAD, Input, KEY_PAD, STICK_REST, edges, firstPad, readPad, readPads, stickMoved, type Button, type PadState } from '../../src/shared/input';

describe('readPad', () => {
  const pad = (axes: number[], pressed: number[] = []) => ({ axes, buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i) })) });

  it('passes the sticks through as they are (each use takes out its own dead zone) and maps buttons', () => {
    const s = readPad(pad([0.1, -0.05, 0.9, 0], [0, 12]));
    expect(s.lx).toBeCloseTo(0.1);
    expect(s.ly).toBeCloseTo(-0.05);
    expect(s.rx).toBeCloseTo(0.9);
    expect(readPad(pad([3, -3, NaN, 0])).lx).toBe(1); // never past full; a broken axis is at rest
    expect(readPad(pad([3, -3, NaN, 0])).ly).toBe(-1);
    expect(readPad(pad([3, -3, NaN, 0])).rx).toBe(0);
    expect(s.a).toBe(true);
    expect(s.up).toBe(true);
    expect(s.b).toBe(false);
    expect(readPad(null)).toEqual(EMPTY_PAD);
  });

  it('stickMoved: small drift is at rest; past STICK_REST a stick has moved', () => {
    expect(stickMoved(readPad(pad([0.1, -0.05, 0.1, 0.12])))).toBe(false);
    expect(stickMoved(readPad(pad([STICK_REST + 0.05, 0, 0, 0])))).toBe(true);
    expect(stickMoved(readPad(pad([0, 0, 0, -0.5])))).toBe(true);
  });

  it('reports only newly pressed buttons', () => {
    const a = readPad(pad([0, 0, 0, 0], [0]));
    const b = readPad(pad([0, 0, 0, 0], [0, 1]));
    expect(edges(a, b)).toEqual(['b']);
    expect(edges(b, b)).toEqual([]);
  });
});

describe('firstPad', () => {
  const gp = (id: string) => ({ id, axes: [], buttons: [] });
  it('is the first connected controller, wherever the browser put it', () => {
    expect(firstPad([null, gp('b'), gp('c')])?.id).toBe('b');
    expect(firstPad([gp('a'), gp('b')])?.id).toBe('a');
    expect(firstPad([null, null, null, null])).toBeNull();
    expect(firstPad([])).toBeNull();
    expect(firstPad(undefined)).toBeNull();
  });
});

describe('readPads: every controller, by its place in the browser’s list', () => {
  const gp = (pressed: number[]) => ({ axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i) })) });

  it('keeps each pad at its index, with null where none is plugged in', () => {
    const pads = readPads([null, gp([0]), null, gp([9])]);
    expect(pads).toHaveLength(4);
    expect(pads[0]).toBeNull();
    expect(pads[1]?.a).toBe(true);
    expect(pads[2]).toBeNull();
    expect(pads[3]?.start).toBe(true);
    expect(readPads(undefined)).toEqual([]);
    // some browsers keep a pad that was unplugged in the list, marked not connected
    expect(readPads([{ ...gp([0]), connected: false }, { ...gp([0]), connected: true }])).toEqual([null, expect.objectContaining({ a: true })]);
    expect(readPads(null)).toEqual([]);
  });
});

describe('Input: several controllers at once', () => {
  const pad = (o: Partial<PadState> = {}): PadState => ({ ...EMPTY_PAD, ...o });
  const keydown = (t: EventTarget, key: string) => t.dispatchEvent(Object.assign(new Event('keydown'), { key, repeat: false, preventDefault() {} }));
  const keyup = (t: EventTarget, key: string) => t.dispatchEvent(Object.assign(new Event('keyup'), { key }));

  it('pads() lists every pad by index; each pad’s presses come with its index', () => {
    const input = new Input(new EventTarget());
    const got: [Button, boolean | undefined, number | undefined][] = [];
    input.onPress = (b, repeat, i) => got.push([b, repeat, i]);
    input.padStubs = [pad(), null, pad()];
    input.poll(1 / 60, false);
    expect(got).toEqual([]);
    input.padStubs = [pad({ start: true }), null, pad({ a: true, x: true })];
    input.poll(1 / 60, false);
    expect(got).toEqual([['start', false, 0], ['a', false, 2], ['x', false, 2]]);
    expect(input.pads()).toHaveLength(3);
    expect(input.pads()[0]?.start).toBe(true);
    expect(input.pads()[1]).toBeNull();
    expect(input.pads()[2]?.x).toBe(true);
    // held: no new presses
    got.length = 0;
    input.poll(1 / 60, false);
    expect(got).toEqual([]);
    // the first connected pad is still `pad()`
    expect(input.pad().start).toBe(true);
  });

  it('a pad unplugged with a button down presses nothing; plugged in again, a held button counts as a press', () => {
    const input = new Input(new EventTarget());
    const got: [Button, number | undefined][] = [];
    input.onPress = (b, _r, i) => got.push([b, i]);
    input.padStubs = [pad({ a: true })];
    input.poll(1 / 60, false);
    input.padStubs = [null];
    input.poll(1 / 60, false);
    input.padStubs = [pad({ a: true })];
    input.poll(1 / 60, false);
    expect(got).toEqual([['a', 0], ['a', 0]]);
  });

  it('keyboard presses come with no pad index', () => {
    const t = new EventTarget(), input = new Input(t);
    const got: [Button, number | undefined][] = [];
    input.onPress = (b, _r, i) => got.push([b, i]);
    keydown(t, 'Enter');
    expect(got).toEqual([['a', undefined]]);
  });

  it('a held stick repeats as the d-pad only for the pads that are in a menu or a picker', () => {
    const input = new Input(new EventTarget());
    const got: [Button, number | undefined][] = [];
    input.onPress = (b, _r, i) => got.push([b, i]);
    input.padStubs = [pad({ lx: 1 }), pad({ ly: 1 })];
    input.poll(1 / 60, (i) => i === 1);
    expect(got).toEqual([['down', 1]]);
    got.length = 0;
    input.poll(1 / 60, true);
    expect(got.map(([, i]) => i)).toEqual([0]); // pad 1 is still waiting out its repeat
  });

  it('the keyboard as a controller (dev): with keyPad on it is one more pad, and its keys press no menu buttons', () => {
    const t = new EventTarget(), input = new Input(t);
    const got: [Button, number | undefined][] = [];
    input.onPress = (b, _r, i) => got.push([b, i]);
    input.padStubs = [];
    input.keyPad = true;
    keydown(t, 'Enter');
    expect(got).toEqual([]); // not the menu's A
    input.poll(1 / 60, false);
    expect(got).toEqual([['start', KEY_PAD]]);
    expect(input.pads()[KEY_PAD]?.start).toBe(true);
    keyup(t, 'Enter');
    for (const k of ['ArrowRight', ' ', 'j', 'k', 'h', ';', 'Shift', 'Backspace']) keydown(t, k);
    input.poll(1 / 60, false);
    expect(input.pads()[KEY_PAD]).toMatchObject({ right: true, a: true, x: true, y: true, b: true, rb: true, lb: true, select: true, start: false });
    input.keyPad = false;
    input.poll(1 / 60, false);
    expect(input.pads()[KEY_PAD]).toBeUndefined();
  });
});

describe('Input.mouse', () => {
  it('returns zero when nothing moved', () => {
    const input = new Input(new EventTarget());
    expect(input.mouse()).toEqual({ dx: 0, dy: 0 });
    expect(input.pad()).toEqual(EMPTY_PAD);
    expect(input.held('W')).toBe(false);
  });
});

describe('nextFocus', () => {
  // a 3 × 2 grid of buttons
  const grid: Rect[] = [0, 1, 2].flatMap((c) => [0, 1].map((r) => ({ id: `${r}${c}`, x: c * 100, y: r * 60, w: 80, h: 40 })));

  it('moves to the neighbour in the pressed direction', () => {
    expect(nextFocus(grid, '00', 'right')).toBe('01');
    expect(nextFocus(grid, '00', 'down')).toBe('10');
    expect(nextFocus(grid, '12', 'up')).toBe('02');
    expect(nextFocus(grid, '11', 'left')).toBe('10');
  });

  it('stays put when nothing lies that way', () => {
    expect(nextFocus(grid, '00', 'left')).toBe('00');
    expect(nextFocus(grid, '00', 'up')).toBe('00');
  });
});
