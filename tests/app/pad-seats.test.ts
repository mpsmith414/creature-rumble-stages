import { describe, expect, test } from 'vitest';
import { FREE_A_WAIT, PAD_COLOURS, PadSeats, REST_AFTER, routePress, SEND_WAIT, padColour, type PressDeps, type SeatEvent } from '../../src/app/pad-seats';
import { StageLoop } from '../../src/app/stage-loop';
import { TEST_LEVEL } from '../../src/levels/test';
import { BUTTONS, EMPTY_PAD, type Button, type PadState } from '../../src/shared/input';
import { bodyStats } from '../../src/stage/body';
import { StageSim } from '../../src/stage/sim';
import { mulberry32 } from '../../src/util/rng';
import { loadFixture } from '../fixtures/fighters';

const pad = (o: Partial<PadState> = {}): PadState => ({ ...EMPTY_PAD, ...o });
const FRAME = 1 / 60;

/** Seats over a set of creatures in play (`inPlay` can be changed by the test). */
function seatsOver(...ids: string[]) {
  const inPlay = new Set(ids);
  return { inPlay, seats: new PadSeats((id) => inPlay.has(id)) };
}

/** Pad `i` presses Start (one frame down, one up) with `rest` the other pads' states; returns the events. */
function pressStart(seats: PadSeats, pads: (PadState | null)[], i: number): SeatEvent[] {
  const down = pads.map((p, k) => (k === i ? pad({ ...p, start: true }) : p));
  const ev = seats.update(down, FRAME, true);
  seats.update(pads, FRAME, true);
  return ev;
}

describe('PadSeats: who steers what', () => {
  test('each pad has its own colour', () => {
    expect(new Set(PAD_COLOURS).size).toBe(PAD_COLOURS.length);
    expect(PAD_COLOURS.length).toBeGreaterThanOrEqual(5); // four pads and the dev keyboard
    expect(padColour(0)).toBe(PAD_COLOURS[0]);
    expect(padColour(1)).not.toBe(padColour(0));
  });

  test('Start on a free pad opens its picker; not while joining is shut (the TV menu up), not with Select held', () => {
    const { seats } = seatsOver('a');
    seats.update([pad()], FRAME, true);
    expect(seats.update([pad({ start: true })], FRAME, false)).toEqual([]); // the menu is up: Start is the menu's
    seats.update([pad()], FRAME, true);
    expect(seats.update([pad({ start: true, select: true })], FRAME, true)).toEqual([]);
    seats.update([pad()], FRAME, true);
    expect(seats.update([pad({ start: true })], FRAME, true)).toEqual([{ type: 'pick', pad: 0 }]);
    expect(seats.picking(0)).toBe(true);
    expect(seats.owns(0)).toBe(true);
    // held Start opens nothing more; Start again (a fresh press) shuts the picker
    expect(seats.update([pad({ start: true })], FRAME, true)).toEqual([]);
    seats.update([pad()], FRAME, true);
    expect(seats.update([pad({ start: true })], FRAME, true)).toEqual([{ type: 'cancel', pad: 0 }]);
    expect(seats.owns(0)).toBe(false);
    // the shut picker does not open again on the same press
    expect(seats.update([pad({ start: true })], FRAME, true)).toEqual([]);
  });

  test('the picker claims a creature: the pad steers it; a creature has one pad at most; cancel frees a picking pad', () => {
    const { seats } = seatsOver('a', 'b');
    const pads = [pad(), pad()];
    seats.update(pads, FRAME, true);
    pressStart(seats, pads, 0);
    pressStart(seats, pads, 1);
    expect(seats.claim(0, 'a')).toBe(true);
    expect(seats.playing(0)).toBe('a');
    expect(seats.steering('a')).toBe(0);
    expect(seats.picking(0)).toBe(false);
    expect(seats.owns(0)).toBe(true);
    expect(seats.source(0)).toBeTypeOf('function');
    expect(seats.claim(1, 'a')).toBe(false); // pad 0 has it
    expect(seats.picking(1)).toBe(true);
    seats.cancel(1);
    expect(seats.owns(1)).toBe(false);
    expect(seats.claim(1, 'b')).toBe(false); // a pad must be picking to claim
    expect(seats.source(1)).toBeNull();
  });

  test('Start + Select leaves: the AI takes the creature back', () => {
    const { seats } = seatsOver('a');
    seats.update([pad()], FRAME, true);
    pressStart(seats, [pad()], 0);
    seats.claim(0, 'a');
    seats.update([pad()], FRAME, true);
    // Start alone, or Select alone, does nothing while playing
    expect(seats.update([pad({ start: true })], FRAME, true)).toEqual([]);
    expect(seats.update([pad()], FRAME, true)).toEqual([]);
    expect(seats.update([pad({ select: true })], FRAME, true)).toEqual([]);
    // Select held, then Start: leave
    expect(seats.update([pad({ select: true, start: true })], FRAME, true)).toEqual([{ type: 'leave', pad: 0, id: 'a', why: 'left' }]);
    expect(seats.owns(0)).toBe(false);
    expect(seats.steering('a')).toBeUndefined();
    // the same press does not open the picker once both are let go and Start is pressed alone it does
    expect(seats.update([pad({ start: true })], FRAME, true)).toEqual([]);
    seats.update([pad()], FRAME, true);
    expect(seats.update([pad({ start: true })], FRAME, true)).toEqual([{ type: 'pick', pad: 0 }]);
  });

  test('a steered creature going out frees its pad (Start picks again)', () => {
    const { seats, inPlay } = seatsOver('a');
    seats.update([pad()], FRAME, true);
    pressStart(seats, [pad()], 0);
    seats.claim(0, 'a');
    expect(seats.update([pad()], FRAME, true)).toEqual([]);
    inPlay.delete('a');
    expect(seats.update([pad()], FRAME, true)).toEqual([{ type: 'leave', pad: 0, id: 'a', why: 'out' }]);
    expect(seats.owns(0)).toBe(false);
    expect(seats.steering('a')).toBeUndefined();
  });

  test('a pad unplugged mid-fight: the AI takes over; a picker unplugged shuts', () => {
    const { seats } = seatsOver('a');
    seats.update([pad(), pad()], FRAME, true);
    pressStart(seats, [pad(), pad()], 0);
    pressStart(seats, [pad(), pad()], 1);
    seats.claim(0, 'a');
    expect(seats.update([null], FRAME, true)).toEqual([
      { type: 'leave', pad: 0, id: 'a', why: 'unplugged' },
      { type: 'cancel', pad: 1 },
    ]);
    expect(seats.seats()).toEqual([]);
  });

  test('a creature sent in from the roster: claimed before it is in play, freed if it never arrives', () => {
    const { seats, inPlay } = seatsOver();
    seats.update([pad()], FRAME, true);
    pressStart(seats, [pad()], 0);
    expect(seats.claim(0, 'r1', true)).toBe(true);
    // still loading: kept, though not yet in play
    expect(seats.update([pad()], 1, true)).toEqual([]);
    inPlay.add('r1');
    expect(seats.update([pad()], 1, true)).toEqual([]);
    expect(seats.playing(0)).toBe('r1');
    // once arrived, it is an ordinary seat: out frees it
    inPlay.delete('r1');
    expect(seats.update([pad()], FRAME, true)).toEqual([{ type: 'leave', pad: 0, id: 'r1', why: 'out' }]);
    // one that never arrives is let go after SEND_WAIT
    pressStart(seats, [pad()], 0);
    seats.claim(0, 'r2', true);
    expect(seats.update([pad()], SEND_WAIT - 1, true)).toEqual([]);
    expect(seats.update([pad()], 2, true)).toEqual([{ type: 'leave', pad: 0, id: 'r2', why: 'out' }]);
  });

  test(`a pad put down rests after ${REST_AFTER} s: the AI drives its creature, the pad keeps it; a touch takes it back at once`, () => {
    expect(REST_AFTER).toBe(20);
    const { seats } = seatsOver('a');
    seats.update([pad()], FRAME, true);
    pressStart(seats, [pad()], 0);
    seats.claim(0, 'a');
    const source = seats.source(0)!;
    for (let t = 0; t < REST_AFTER - 1; t++) expect(seats.update([pad({ lx: 0.1 })], 1, true)).toEqual([]); // drift is no touch
    expect(seats.resting(0)).toBe(false);
    expect(source()).not.toBeNull();
    expect(seats.update([pad()], 2, true)).toEqual([{ type: 'rest', pad: 0, id: 'a' }]);
    expect(seats.resting(0)).toBe(true);
    expect(seats.owns(0)).toBe(true);
    expect(seats.playing(0)).toBe('a');
    expect(seats.steering('a')).toBe(0);
    expect(seats.seats()[0]).toMatchObject({ pad: 0, id: 'a', resting: true });
    expect(source()).toBeNull(); // the brain thinks for it
    expect(seats.update([pad()], 60, true)).toEqual([]); // stays resting
    // a touch of the stick wakes it at once: the very next step is the pad's
    expect(seats.update([pad({ lx: 1 })], FRAME, true)).toEqual([{ type: 'wake', pad: 0, id: 'a' }]);
    expect(seats.resting(0)).toBe(false);
    expect(source()!.mx).toBe(1);
    // so does any button
    seats.update([pad()], REST_AFTER + 1, true);
    expect(seats.resting(0)).toBe(true);
    expect(seats.update([pad({ x: true })], FRAME, true)).toEqual([{ type: 'wake', pad: 0, id: 'a' }]);
  });

  test('a held stick or button is never resting', () => {
    const { seats } = seatsOver('a');
    seats.update([pad()], FRAME, true);
    pressStart(seats, [pad()], 0);
    seats.claim(0, 'a');
    for (let t = 0; t < 60; t++) expect(seats.update([pad({ a: true })], 1, true)).toEqual([]);
    for (let t = 0; t < 60; t++) expect(seats.update([pad({ ly: -0.9 })], 1, true)).toEqual([]);
    expect(seats.resting(0)).toBe(false);
  });

  test('release (the send-in failed) frees the pad and says which creature it had', () => {
    const { seats } = seatsOver('a');
    seats.update([pad()], FRAME, true);
    pressStart(seats, [pad()], 0);
    seats.claim(0, 'a');
    expect(seats.release(0)).toBe('a');
    expect(seats.release(0)).toBeNull();
    expect(seats.owns(0)).toBe(false);
  });
});

describe('PadSeats on the stage: the same moves and rules as the AI, only the wanting changes', () => {
  const FISTS = bodyStats(loadFixture('fists')), LEGS = bodyStats(loadFixture('legs'));
  /** Two fighters on the test level, two pads steering them through the loop. */
  function twoPads() {
    const rng = mulberry32(3);
    const sim = new StageSim({ level: TEST_LEVEL, rng });
    sim.add('a', FISTS, { x: -2, y: 0 });
    sim.add('b', LEGS, { x: 2, y: 0 });
    const loop = new StageLoop({ sim, rng });
    const seats = new PadSeats((id) => !!sim.get(id));
    const pads = [pad(), pad()];
    seats.update(pads, FRAME, true);
    pressStart(seats, pads, 0);
    pressStart(seats, pads, 1);
    seats.claim(0, 'a');
    seats.claim(1, 'b');
    loop.steer('a', seats.source(0));
    loop.steer('b', seats.source(1));
    /** Frames with these pad states (each frame: seats first, then the fight, as the TV does). */
    const run = (frames: number, p0: PadState, p1: PadState) => {
      for (let k = 0; k < frames; k++) {
        seats.update([p0, p1], FRAME, true);
        loop.frame(FRAME);
      }
    };
    return { sim, loop, seats, run };
  }

  test('two pads steer two fighters: one runs left, the other right, away from each other', () => {
    const { sim, run } = twoPads();
    run(40, pad({ lx: -1 }), pad({ right: true }));
    expect(sim.get('a')!.mover.pos.x).toBeLessThan(-3);
    expect(sim.get('a')!.facing).toBe(-1);
    expect(sim.get('b')!.mover.pos.x).toBeGreaterThan(3);
    expect(sim.get('b')!.facing).toBe(1);
  });

  test('press edges through the fight: A held down jumps once; let go and pressed again jumps again', () => {
    const { sim, run } = twoPads();
    const a = sim.get('a')!;
    run(5, pad(), pad());
    let jumps = 0, wasUp = false;
    const count = (frames: number, p: PadState) => {
      for (let k = 0; k < frames; k++) {
        run(1, p, pad());
        const up = a.mover.vel.y > 0.5;
        if (up && !wasUp) jumps++;
        wasUp = up;
      }
    };
    count(120, pad({ a: true })); // held two seconds: one jump (it lands and does not jump again)
    expect(jumps).toBe(1);
    count(10, pad());
    count(60, pad({ a: true }));
    expect(jumps).toBe(2);
  });

  test('a pad put down: its creature fights on with the AI, and a touch steers it again', () => {
    const { sim, run } = twoPads();
    const a = sim.get('a')!, b = sim.get('b')!;
    run(60, pad(), pad());
    const ax = a.mover.pos.x, bx = b.mover.pos.x;
    run(60 * (REST_AFTER - 2), pad(), pad());
    expect(a.mover.pos.x).toBeCloseTo(ax, 6); // nobody touches the pads: they stand
    expect(b.mover.pos.x).toBeCloseTo(bx, 6);
    run(60 * 4, pad(), pad()); // resting: the brains take over and go for each other
    expect(Math.abs(a.mover.pos.x - ax) + Math.abs(b.mover.pos.x - bx)).toBeGreaterThan(0.5);
    // touched: the pad steers again (once any knock it is taking has run its course, it runs left as told)
    let ranLeft = false;
    for (let k = 0; k < 120 && !ranLeft; k++) {
      run(1, pad({ lx: -1 }), pad());
      ranLeft = a.action === 'run' && a.mover.vel.x < -1;
    }
    expect(ranLeft).toBe(true);
  });

  test('the A that picked the creature does not make it jump', () => {
    const rng = mulberry32(3);
    const sim = new StageSim({ level: TEST_LEVEL, rng });
    sim.add('a', FISTS, { x: 0, y: 0 });
    const loop = new StageLoop({ sim, rng, brains: false });
    const seats = new PadSeats((id) => !!sim.get(id));
    seats.update([pad()], FRAME, true);
    pressStart(seats, [pad()], 0);
    seats.update([pad({ a: true })], FRAME, true); // A goes down in the picker…
    seats.claim(0, 'a'); // …and picks
    loop.steer('a', seats.source(0));
    for (let k = 0; k < 30; k++) {
      seats.update([pad({ a: true })], FRAME, true); // still held
      loop.frame(FRAME);
    }
    expect(sim.get('a')!.mover.pos.y).toBeCloseTo(0, 6);
  });
});

describe('A free pad and the TV menu (final review #1): a child mashing A never crowns', () => {
  /**
   * The TV's routing of presses with a real PadSeats, a fake menu (its A presses the focused item: "Crown the
   * champion!" while the fight is open, "Again!" once crowned) and a fake picker (its A picks the first creature).
   * Each frame: the fresh presses go through `routePress`, then the seats update, as the Rumble's frame does.
   */
  function tv(...ids: string[]) {
    const { seats, inPlay } = seatsOver(...ids);
    const log = { shows: 0, crowns: 0, agains: 0, picks: [] as string[] };
    let crowned = false;
    const menu = {
      open: null as object | null,
      show() { if (!this.open) { this.open = {}; log.shows++; } },
      close() { this.open = null; },
      press(b: Button, repeat = false) {
        if (!this.open) {
          if (b !== 'start') return false;
          if (!repeat) this.show();
          return true;
        }
        if (b === 'start') this.close();
        else if (b === 'a' && !repeat) {
          if (crowned) log.agains++;
          else { log.crowns++; crowned = true; }
          this.close();
        }
        return true;
      },
    };
    const deps: PressDeps = {
      seats, menu,
      picker: (p, b) => {
        if (b !== 'a') return;
        const id = [...inPlay].find((i) => seats.steering(i) === undefined);
        if (id && seats.claim(p, id)) log.picks.push(id);
      },
    };
    let was = pad();
    /** One frame with pad 0 as `now`. */
    const frame = (now: PadState, dt = FRAME) => {
      for (const b of BUTTONS) if (now[b] && !was[b]) routePress(b, false, 0, deps);
      was = now;
      return seats.update([now], dt, !menu.open);
    };
    return { seats, inPlay, menu, log, frame };
  }

  test(`a free pad's A (like Start) opens its picker, never the TV menu; mashing A picks a creature and never crowns`, () => {
    const t = tv('a', 'b');
    t.frame(pad());
    expect(t.frame(pad({ a: true }))).toEqual([{ type: 'pick', pad: 0 }]);
    t.frame(pad());
    t.frame(pad({ a: true })); // the picker's A: it picks
    expect(t.log.picks).toEqual(['a']);
    for (let i = 0; i < 120; i++) t.frame(pad({ a: i % 4 < 2 })); // mashing A while playing: the creature's jumps
    expect(t.log).toMatchObject({ shows: 0, crowns: 0, agains: 0 });
    expect(t.menu.open).toBeNull();
  });

  test('a pad freed by its creature going out ignores A for 1 s; then A opens its picker; mashing never opens the menu or crowns', () => {
    expect(FREE_A_WAIT).toBe(1);
    const t = tv('a', 'b');
    t.frame(pad());
    t.frame(pad({ start: true }));
    t.frame(pad());
    t.frame(pad({ a: true }));
    expect(t.seats.playing(0)).toBe('a');
    t.frame(pad());
    t.inPlay.delete('a'); // knocked out: the pad is free
    expect(t.frame(pad())).toEqual([{ type: 'leave', pad: 0, id: 'a', why: 'out' }]);
    // the child keeps pressing A to jump: nothing for a second
    const events: SeatEvent[] = [];
    for (let i = 0; i < 54; i++) events.push(...t.frame(pad({ a: i % 4 < 2 })));
    expect(events).toEqual([]);
    expect(t.seats.owns(0)).toBe(false);
    // and then A picks again (its picker, then a creature): the menu never opens, nobody is crowned
    for (let i = 0; i < 120; i++) events.push(...t.frame(pad({ a: i % 4 < 2 })));
    expect(events[0]).toEqual({ type: 'pick', pad: 0 });
    expect(t.log.picks).toEqual(['a', 'b']);
    expect(t.log).toMatchObject({ shows: 0, crowns: 0, agains: 0 });
  });

  test('a pad that left with Start + Select, or shut its picker, also waits 1 s before A picks again; Start does not wait', () => {
    const { seats } = seatsOver('a');
    seats.update([pad()], FRAME, true);
    pressStart(seats, [pad()], 0);
    expect(seats.update([pad({ start: true })], FRAME, true)).toEqual([{ type: 'cancel', pad: 0 }]);
    seats.update([pad()], FRAME, true);
    expect(seats.update([pad({ a: true })], FRAME, true)).toEqual([]); // too soon
    seats.update([pad()], FREE_A_WAIT, true);
    expect(seats.update([pad({ a: true })], FRAME, true)).toEqual([{ type: 'pick', pad: 0 }]);
    seats.cancel(0);
    seats.update([pad()], FRAME, true);
    expect(seats.update([pad({ start: true })], FRAME, true)).toEqual([{ type: 'pick', pad: 0 }]); // Start at once
    // A held with Select (half of leaving) opens nothing, nor does A while joining is shut
    seats.cancel(0);
    seats.update([pad()], 2, true);
    expect(seats.update([pad({ a: true, select: true })], FRAME, true)).toEqual([]);
    seats.update([pad()], FRAME, true);
    expect(seats.update([pad({ a: true })], FRAME, false)).toEqual([]);
  });

  test('Select on a free pad opens the TV menu (and shuts it); the remote and Enter still open it; a playing pad never does', () => {
    const t = tv('a');
    t.frame(pad());
    t.frame(pad({ select: true }));
    expect(t.log.shows).toBe(1);
    expect(t.menu.open).not.toBeNull();
    // while it is up, the free pad drives it: Select shuts it
    t.frame(pad());
    t.frame(pad({ select: true }));
    expect(t.menu.open).toBeNull();
    // the keyboard (Enter is A) or the remote opens it
    routePress('a', false, undefined, { seats: t.seats, menu: t.menu, picker: () => {} });
    expect(t.log.shows).toBe(2);
    t.menu.close();
    // a playing pad's Select is half of leaving: never the menu
    t.frame(pad());
    t.frame(pad({ start: true }));
    t.frame(pad());
    t.frame(pad({ a: true }));
    expect(t.seats.playing(0)).toBe('a');
    t.frame(pad());
    t.frame(pad({ select: true }));
    expect(t.log.shows).toBe(2);
  });
});
