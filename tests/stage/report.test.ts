import { describe, expect, it } from 'vitest';
import { STILL_LONG, STILL_SPEED, StillClock, standingStill, summarize, type BoutResult } from '../../src/stage/report';
import { DT } from '../../src/stage/types';

/** A fighter as the still clock sees it. */
const who = (id: string, action: string, speed = 0, ground = true) =>
  ({ id, action, mover: { vel: { x: speed, y: 0 }, ground: ground ? {} : null } }) as never;

describe('standing still (spec §5.4: nobody stands still for long)', () => {
  it('is on the ground, slow, idle, landing or attacking where it stands', () => {
    expect(standingStill(who('a', 'idle'))).toBe(true);
    expect(standingStill(who('a', 'land'))).toBe(true);
    expect(standingStill(who('a', 'attack'))).toBe(true);
    expect(standingStill(who('a', 'idle', STILL_SPEED + 0.1))).toBe(false); // walking
    expect(standingStill(who('a', 'idle', 0, false))).toBe(false); // in the air
    for (const a of ['run', 'hitstun', 'tumble', 'held', 'special', 'dodge']) expect(standingStill(who('a', a)), a).toBe(false);
  });

  it('counts whole stretches longer than STILL_LONG only, per fighter, closing on a move, on leaving and at the end', () => {
    const c = new StillClock();
    const run = (from: number, to: number, f: (t: number) => never[]) => {
      for (let t = from; t < to - 1e-9; t += DT) c.step(f(t), t);
    };
    // a stands 2 s (short), moves; b stands 4 s then is gone; a stands again from 5 s to the end at 9 s
    run(0, 2, () => [who('a', 'idle'), who('b', 'idle')]);
    run(2, 4, () => [who('a', 'run', 3), who('b', 'idle')]);
    run(4, 5, () => [who('a', 'run', 3)]);
    run(5, 9, () => [who('a', 'idle')]);
    c.end(9);
    expect(c.total).toBeCloseTo(4 + 4, 1);
    expect(STILL_LONG).toBe(3);
  });

  it('the report pools it over all the fighter-time', () => {
    const bout = (still: number, fighterTime: number): BoutResult =>
      ({ winner: 'f0', seconds: 60, firstOut: 30, quiet: 0, outs: ['f1', 'f2', 'f3'], still, fighterTime });
    const r = summarize([bout(6, 200), bout(0, 100)], [['fists', 'legs', 'tiny', 'blob'], ['wings', 'tail', 'horns', 'fists']]);
    expect(r.still).toBeCloseTo(6 / 300, 9);
  });
});
