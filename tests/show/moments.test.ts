import { describe, expect, it } from 'vitest';
import { TEST_LEVEL } from '../../src/levels/test';
import {
  KO_VIEW, MOMENT_EASE, MOMENT_GAP_S, MOMENT_SECONDS, MOMENT_SLOW, Moments, SPECIAL_VIEW, willFlyOut,
} from '../../src/show/moments';
import { bodyStats } from '../../src/stage/body';
import type { StageFighter, StageHit } from '../../src/stage/fighter';
import type { StageEvents, StageSpecialCue } from '../../src/stage/sim';
import { StageSim } from '../../src/stage/sim';
import { mulberry32 } from '../../src/util/rng';
import { loadFixture } from '../fixtures/fighters';

const STATS = bodyStats(loadFixture('fists'));

/** A fighter standing at `x` on the test level's main stage, settled, with `damage` taken. */
function standing(x: number, damage: number): { sim: StageSim; f: StageFighter } {
  const sim = new StageSim({ level: TEST_LEVEL, rng: mulberry32(3) });
  const f = sim.add('t', STATS, { x, y: 0 });
  for (let k = 0; k < 20; k++) sim.step(new Map());
  f.damage = damage;
  return { sim, f };
}

/** Hits `f` toward +x at 40° with `power` (as an attacker on its left would); returns the hit as the sim reports it. */
function launch(f: StageFighter, power: number): StageHit {
  const speed = f.takeHit({ power, damage: 5, angle: 40, from: 1 });
  return { attacker: 'a', target: f.id, at: { x: f.mover.pos.x - 0.3, y: f.mover.pos.y + 1 }, power, launch: speed,
    tumble: f.action === 'tumble' };
}

const events = (over: Partial<StageEvents> = {}): StageEvents => ({
  hits: [], outs: [], moves: [], specials: [], grabs: [], items: [], mischief: [], bumps: [], ...over,
});
const impact = (id = 's'): StageSpecialCue => ({ id, special: 'megaPunch', phase: 'impact', at: { x: -3, y: 1.5 } });

/** A knockout launch near the right edge, and the Moments watching its sim. */
function koSetup() {
  const { sim, f } = standing(10, 220);
  const hit = launch(f, 2);
  const moments = new Moments({ fighter: (id) => sim.get(id), level: () => sim.level, t: () => sim.t });
  return { sim, f, hit, moments };
}

describe('willFlyOut', () => {
  it('a big launch near the edge with lots of damage flies out; a light one in the middle does not', () => {
    expect(willFlyOut(koSetup().f, TEST_LEVEL, 0)).toBe(true);
    const { f, sim } = standing(0, 10);
    launch(f, 1);
    expect(willFlyOut(f, TEST_LEVEL, sim.t)).toBe(false);
  });

  it('agrees with the fight: the launch it calls really goes out, the one it does not lands back on the stage', () => {
    for (const [x, damage, out] of [[10, 220, true], [-2, 40, false]] as const) {
      const { sim, f } = standing(x, damage);
      launch(f, 2);
      expect(willFlyOut(f, sim.level, sim.t)).toBe(out);
      let gone = false;
      for (let k = 0; k < 180 && !gone; k++) gone = sim.step(new Map()).outs.includes('t');
      expect(gone, `x ${x}`).toBe(out);
    }
  });

  it('only a launched creature (tumbling or staggered) can fly out, and the fighter is never touched', () => {
    const { f, sim } = standing(10, 220);
    expect(willFlyOut(f, sim.level, sim.t)).toBe(false); // standing
    launch(f, 2);
    const before = JSON.stringify({ p: f.mover.pos, v: f.mover.vel, g: f.mover.ground, a: f.action, t: f.actionT });
    willFlyOut(f, sim.level, sim.t);
    expect(JSON.stringify({ p: f.mover.pos, v: f.mover.vel, g: f.mover.ground, a: f.action, t: f.actionT })).toBe(before);
  });
});

describe('Moments', () => {
  it('a knockout launch starts slow motion and a close-up near the hit', () => {
    const { hit, moments } = koSetup();
    const m = moments.moment(events({ hits: [hit] }), 100);
    expect(m).not.toBeNull();
    expect(m!.kind).toBe('knockout');
    expect(m!.slow).toBe(MOMENT_SLOW);
    expect(MOMENT_SLOW).toBe(0.3);
    expect(m!.seconds).toBe(MOMENT_SECONDS);
    expect(MOMENT_SECONDS).toBe(1.2);
    expect(m!.height).toBe(KO_VIEW);
    expect(Math.abs(m!.at.x - hit.at.x)).toBeLessThan(1.5);
  });

  it('a hit that will not carry anyone out is no moment; a special winding up is none either', () => {
    const { f, sim } = standing(0, 10);
    const moments = new Moments({ fighter: (id) => sim.get(id), level: () => sim.level, t: () => sim.t });
    const hit = launch(f, 1);
    expect(moments.moment(events({ hits: [hit] }), 0)).toBeNull();
    expect(moments.moment(events({ specials: [{ ...impact(), phase: 'charge' }] }), 0)).toBeNull();
  });

  it('a landed special is a moment at its blow', () => {
    const { moments } = koSetup();
    const m = moments.moment(events({ specials: [impact()] }), 5);
    expect(m?.kind).toBe('special');
    expect(m?.height).toBe(SPECIAL_VIEW);
    expect(m?.at).toEqual({ x: -3, y: 1.5 });
  });

  it('at most one every MOMENT_GAP_S (10 s)', () => {
    expect(MOMENT_GAP_S).toBe(10);
    const { moments } = koSetup();
    expect(moments.moment(events({ specials: [impact()] }), 20)).not.toBeNull();
    expect(moments.moment(events({ specials: [impact()] }), 25)).toBeNull();
    expect(moments.moment(events({ specials: [impact()] }), 29.9)).toBeNull();
    expect(moments.moment(events({ specials: [impact()] }), 30)).not.toBeNull();
  });

  it('a knockout wins over a special in the same step, and takes over a special still playing', () => {
    const a = koSetup();
    expect(a.moments.moment(events({ specials: [impact()], hits: [a.hit] }), 0)?.kind).toBe('knockout');
    const b = koSetup();
    expect(b.moments.moment(events({ specials: [impact()] }), 0)?.kind).toBe('special');
    expect(b.moments.moment(events({ hits: [b.hit] }), 0.5)?.kind).toBe('knockout');
    // …but not one that is over: then the gap holds
    const c = koSetup();
    c.moments.moment(events({ specials: [impact()] }), 0);
    expect(c.moments.moment(events({ hits: [c.hit] }), 2)).toBeNull();
    // and a knockout's own moment is never taken over
    const d = koSetup();
    d.moments.moment(events({ hits: [d.hit] }), 0);
    expect(d.moments.moment(events({ hits: [d.hit] }), 0.5)).toBeNull();
  });

  it('slow motion holds for the moment, then eases back to real time', () => {
    const { moments } = koSetup();
    expect(moments.timeScale(0)).toBe(1);
    moments.moment(events({ specials: [impact()] }), 10);
    expect(moments.timeScale(10)).toBe(MOMENT_SLOW);
    expect(moments.timeScale(10 + MOMENT_SECONDS - 0.01)).toBe(MOMENT_SLOW);
    const mid = moments.timeScale(10 + MOMENT_SECONDS + MOMENT_EASE / 2);
    expect(mid).toBeGreaterThan(MOMENT_SLOW);
    expect(mid).toBeLessThan(1);
    expect(moments.timeScale(10 + MOMENT_SECONDS + MOMENT_EASE)).toBeCloseTo(1, 9);
    expect(moments.timeScale(10 + MOMENT_SECONDS + 2 * MOMENT_EASE)).toBe(1);
    moments.reset();
    expect(moments.timeScale(10)).toBe(1);
  });
});
