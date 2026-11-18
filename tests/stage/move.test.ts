import { describe, expect, it } from 'vitest';
import { TEST_LEVEL } from '../../src/levels/test';
import { platformsAt, type Level, type Platform } from '../../src/stage/level';
import { makeMover, stepMover, type MoveEvent, type MoveInput, type MoveStats, type Mover } from '../../src/stage/move';
import { DT } from '../../src/stage/types';
import { between, mulberry32 } from '../../src/util/rng';

const STATS: MoveStats = { run: 7, accel: 60, airAccel: 30, jump: 13, airJump: 11, airJumps: 1, recovery: 14, fall: 18, fastFall: 26 };
const IDLE: MoveInput = { mx: 0, jump: false, down: false, recover: false };
const W = 1, H = 1.5;

/** Steps one mover on a level, keeping the level time and this step's events. */
class Run {
  t = 0;
  events: MoveEvent[] = [];
  constructor(public m: Mover, public level: Level = TEST_LEVEL) {}
  step(input: Partial<MoveInput> = {}) {
    this.events.length = 0;
    stepMover(this.m, { ...IDLE, ...input }, STATS, this.level, this.t, DT, this.events);
    this.t += DT;
    return this.events;
  }
  /** Steps until `done` (at most `max` steps); returns the steps taken. Fails if it never happens. */
  until(done: () => boolean, input: Partial<MoveInput> = {}, max = 600) {
    for (let i = 1; i <= max; i++) {
      this.step(input);
      if (done()) return i;
    }
    throw new Error('never happened');
  }
}

/** A mover already standing on the main stage at x. */
function standing(x: number, level: Level = TEST_LEVEL) {
  const run = new Run(makeMover({ x, y: 0.5 }, W, H), level);
  run.until(() => run.m.ground !== null);
  return run;
}

const at = (level: Level, t: number, id: string) => platformsAt(level, t).find((p) => p.id === id)!;

/** Overlap deeper than float noise between a mover's box and a platform's box. */
function overlaps(m: Mover, p: Platform) {
  const x = Math.min(m.pos.x + m.w / 2, p.x + p.w / 2) - Math.max(m.pos.x - m.w / 2, p.x - p.w / 2);
  const y = Math.min(m.pos.y + m.h, p.y) - Math.max(m.pos.y, p.y - p.h);
  return x > 1e-9 && y > 1e-9;
}

describe('stepMover', () => {
  it('lands and stands on the main stage', () => {
    const run = new Run(makeMover({ x: 0, y: 5 }, W, H));
    let lowest = Infinity;
    const steps = run.until(() => {
      lowest = Math.min(lowest, run.m.pos.y);
      return run.m.ground !== null;
    });
    expect(steps * DT).toBeLessThanOrEqual(2);
    expect(run.m.pos.y).toBe(0);
    expect(run.m.ground).toBe('main');
    expect(run.events).toContain('land');
    // Standing still: the same y every step, exactly the top (no jitter).
    for (let i = 0; i < 120; i++) {
      run.step();
      lowest = Math.min(lowest, run.m.pos.y);
      expect(run.m.pos.y).toBe(0);
      expect(run.m.ground).toBe('main');
    }
    expect(lowest).toBeGreaterThanOrEqual(0);
  });

  it('neither slides nor sticks at an edge', () => {
    // Half the box over the right edge (the stage ends at x = 12): it stays put.
    const run = standing(12);
    for (let i = 0; i < 60; i++) {
      run.step();
      expect(run.m.pos).toEqual({ x: 12, y: 0 });
      expect(run.m.ground).toBe('main');
    }
    // Walking off: it leaves the edge without catching, then falls every step.
    run.until(() => run.m.ground === null, { mx: 1 });
    expect(run.m.pos.x - W / 2).toBeGreaterThanOrEqual(12);
    let y = run.m.pos.y, x = run.m.pos.x;
    for (let i = 0; i < 30; i++) {
      run.step({ mx: 1 });
      expect(run.m.pos.y).toBeLessThan(y);
      expect(run.m.pos.x).toBeGreaterThan(x);
      y = run.m.pos.y;
      x = run.m.pos.x;
    }
  });

  it('runs and stops quickly', () => {
    const run = standing(-6);
    const start = run.m.pos.x;
    const up = run.until(() => run.m.vel.x >= 0.95 * STATS.run, { mx: 1 });
    expect(up * DT).toBeLessThanOrEqual(0.2);
    for (let i = 0; i < 20; i++) run.step({ mx: 1 });
    expect(run.m.vel.x).toBe(STATS.run);
    expect(run.m.pos.x).toBeGreaterThan(start + 1);
    const stop = run.until(() => run.m.vel.x === 0);
    expect(stop * DT).toBeLessThanOrEqual(0.25);
    const x = run.m.pos.x;
    run.step();
    expect(run.m.pos.x).toBe(x);
  });

  it('jump and double jump', () => {
    const one = standing(0);
    expect(one.step({ jump: true })).toContain('jump');
    let peak = 0;
    one.until(() => {
      peak = Math.max(peak, one.m.pos.y);
      return one.m.ground !== null;
    });
    expect(peak).toBeGreaterThanOrEqual(2.6);

    const two = standing(0);
    two.step({ jump: true });
    two.until(() => two.m.vel.y <= 0);
    expect(two.step({ jump: true })).toContain('airJump');
    peak = 0;
    two.until(() => {
      peak = Math.max(peak, two.m.pos.y);
      return two.m.vel.y < 0;
    });
    expect(peak).toBeGreaterThanOrEqual(4.6);
    // A third press does nothing: no event, still falling as before.
    const vy = two.m.vel.y;
    expect(two.step({ jump: true })).toEqual([]);
    expect(two.m.vel.y).toBeLessThan(vy);
    expect(two.m.airJumpsLeft).toBe(0);
  });

  it('thin platforms: up through, stand on, drop down through', () => {
    const run = standing(6); // under the right platform (top y = 3.5)
    run.step({ jump: true });
    run.until(() => run.m.vel.y <= 0);
    run.step({ jump: true });
    let passedThrough = false;
    run.until(() => {
      if (run.m.pos.y < 3.5 && run.m.pos.y + H > 3.5) passedThrough = true;
      return run.m.ground !== null;
    });
    expect(passedThrough).toBe(true);
    expect(run.m.ground).toBe('right');
    expect(run.m.pos.y).toBe(3.5);
    for (let i = 0; i < 30; i++) {
      run.step();
      expect(run.m.pos.y).toBe(3.5);
    }

    expect(run.step({ down: true })).toContain('drop');
    run.until(() => run.m.ground !== null);
    expect(run.m.ground).toBe('main');
    expect(run.m.pos.y).toBe(0);
  });

  it('never passes a solid platform from below or above', () => {
    const block: Platform = { id: 'block', kind: 'solid', x: 0, y: 4, w: 4, h: 1 }; // bottom at y = 3
    const level: Level = { ...TEST_LEVEL, platforms: [TEST_LEVEL.platforms[0], block] };
    const below = standing(0, level);
    below.step({ jump: true });
    let top = 0;
    for (let i = 0; i < 20; i++) {
      below.step({ jump: i === 5 });
      top = Math.max(top, below.m.pos.y + H);
    }
    expect(top).toBeLessThanOrEqual(3 + 1e-9);
    expect(top).toBeGreaterThan(2.99); // it did reach the block
    below.until(() => below.m.ground !== null);
    expect(below.m.ground).toBe('main');

    const above = new Run(makeMover({ x: 0, y: 4.5 }, W, H), level);
    above.until(() => above.m.ground !== null);
    expect(above.m.ground).toBe('block');
    for (let i = 0; i < 30; i++) {
      expect(above.step({ down: true })).not.toContain('drop');
      expect(above.m.pos.y).toBe(4);
    }
  });

  it('moving platform carries its rider', () => {
    const run = new Run(makeMover({ x: 0, y: 7 }, W, H));
    run.until(() => run.m.ground !== null);
    expect(run.m.ground).toBe('centre');
    const offset = run.m.pos.x - at(TEST_LEVEL, run.t, 'centre').x;
    let travel = 0;
    for (let i = 0; i < 180; i++) {
      run.step();
      const centre = at(TEST_LEVEL, run.t, 'centre');
      travel = Math.max(travel, Math.abs(centre.x));
      expect(Math.abs(run.m.pos.x - centre.x - offset)).toBeLessThanOrEqual(0.05);
      expect(run.m.pos.y).toBe(7);
      expect(run.m.ground).toBe('centre');
    }
    expect(travel).toBeGreaterThan(2.9);
  });

  it('recovery leap once per air trip', () => {
    const run = standing(11);
    run.until(() => run.m.ground === null, { mx: 1 });
    expect(run.step({ jump: true })).toContain('airJump');
    expect(run.step({ recover: true })).toContain('recover');
    expect(run.m.vel.y).toBeGreaterThanOrEqual(12);
    run.step();
    const vy = run.m.vel.y;
    expect(run.step({ recover: true })).toEqual([]);
    expect(run.m.vel.y).toBeLessThan(vy);
    expect(run.step({ jump: true })).toEqual([]);

    run.until(() => run.m.ground !== null, { mx: -1 });
    expect(run.m.ground).toBe('main');
    expect(run.m.airJumpsLeft).toBe(STATS.airJumps);
    expect(run.m.recoveryUsed).toBe(false);

    run.until(() => run.m.ground === null, { mx: -1 });
    expect(run.step({ recover: true })).toContain('recover');
  });

  it('never tunnels at launch speed', () => {
    const down = new Run(makeMover({ x: 0, y: 3 }, W, H));
    down.m.vel.y = -80;
    down.until(() => {
      expect(down.m.pos.y).toBeGreaterThanOrEqual(0);
      return down.m.ground !== null;
    });
    expect(down.m.ground).toBe('main');
    expect(down.m.pos.y).toBe(0);

    const slant = new Run(makeMover({ x: 2, y: 6 }, W, H));
    slant.m.vel.x = 60;
    slant.m.vel.y = -60;
    slant.until(() => slant.m.ground !== null);
    expect(slant.m.ground).toBe('right');
    expect(slant.m.pos.y).toBe(3.5);

    const rng = mulberry32(1234);
    const solids = (t: number) => platformsAt(TEST_LEVEL, t).filter((p) => p.kind === 'solid');
    for (let launch = 0; launch < 1000; launch++) {
      const w = between(rng, 0.4, 2), h = between(rng, 0.5, 2.5);
      let m: Mover;
      do m = makeMover({ x: between(rng, -20, 20), y: between(rng, -9, 18) }, w, h);
      while (solids(0).some((p) => overlaps(m, p)));
      const speed = between(rng, 0, 90), angle = between(rng, 0, Math.PI * 2);
      m.vel.x = Math.cos(angle) * speed;
      m.vel.y = Math.sin(angle) * speed;
      const run = new Run(m);
      for (let i = 0; i < 90; i++) {
        run.step({ mx: between(rng, -1, 1), down: rng() < 0.3, jump: rng() < 0.05, recover: rng() < 0.02 });
        expect(Number.isFinite(m.pos.x) && Number.isFinite(m.pos.y)).toBe(true);
        for (const p of solids(run.t)) if (overlaps(m, p)) throw new Error(`launch ${launch} step ${i} overlaps ${p.id}`);
      }
    }
  });
});
