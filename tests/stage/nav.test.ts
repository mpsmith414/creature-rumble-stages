import { describe, expect, it } from 'vitest';
import { TEST_LEVEL } from '../../src/levels/test';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import type { Level } from '../../src/stage/level';
import type { MoveStats } from '../../src/stage/move';
import { navGraph, route } from '../../src/stage/nav';
import { KINDS, loadFixture, type Kind } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<Kind, BodyStats>;
const IDS = TEST_LEVEL.platforms.map((p) => p.id);
/** The average body's movement (as `bodyStats` gives a 1.4 m body). */
const AVERAGE: MoveStats = { run: 7, accel: 60, airAccel: 30, jump: 13, airJump: 11, airJumps: 1, recovery: 14, fall: 18, fastFall: 26 };

/** The test level with extra platforms. */
const withPlatforms = (...extra: Level['platforms']): Level => ({ ...TEST_LEVEL, platforms: [...TEST_LEVEL.platforms, ...extra] });

describe('navGraph and route', () => {
  it('every floor of the test level is reachable for every fixture kind', () => {
    for (const k of KINDS) {
      const g = navGraph(TEST_LEVEL, STATS[k].moves);
      for (const a of IDS) for (const b of IDS) expect(route(g, a, b), `${k}: ${a} → ${b}`).not.toBeNull();
    }
  });

  it('routes up and down', () => {
    const g = navGraph(TEST_LEVEL, AVERAGE);
    const up = route(g, 'main', 'centre')!;
    expect(up.map((l) => l.to)).toHaveLength(2);
    expect(['left', 'right']).toContain(up[0].to);
    expect(up[0]).toMatchObject({ from: 'main', how: 'airJump' });
    expect(up[1]).toMatchObject({ from: up[0].to, to: 'centre' });
    const down = route(g, 'centre', 'main')!;
    expect(down).toEqual([{ from: 'centre', to: 'main', how: 'drop' }]);
    expect(route(g, 'left', 'main')).toEqual([{ from: 'left', to: 'main', how: 'drop' }]);
    expect(route(g, 'left', 'left')).toEqual([]);
  });

  it('a floor out of reach has no way there; one in reach of a single jump is a jump', () => {
    const level = withPlatforms(
      { id: 'sky', kind: 'thin', x: 0, y: 20, w: 4, h: 0.4 },
      { id: 'step', kind: 'solid', x: 9, y: 1.2, w: 2, h: 1.2 },
    );
    const g = navGraph(level, AVERAGE);
    expect(route(g, 'main', 'sky')).toBeNull();
    expect(route(g, 'main', 'step')).toEqual([{ from: 'main', to: 'step', how: 'jump' }]);
    expect(route(g, 'step', 'main')).toEqual([{ from: 'step', to: 'main', how: 'drop' }]);
  });

  it('a lower floor across a gap too wide to step off onto is reached by a jump', () => {
    // 4 m past the stage's right edge and 2 m lower: falling off the edge drifts only ~1.5 m.
    const level = withPlatforms({ id: 'ledge', kind: 'thin', x: 18, y: -2, w: 4, h: 0.4 });
    const g = navGraph(level, AVERAGE);
    expect(route(g, 'main', 'ledge')).toEqual([{ from: 'main', to: 'ledge', how: 'jump' }]);
    expect(route(g, 'ledge', 'main')).toEqual([{ from: 'ledge', to: 'main', how: 'airJump' }]);
  });

  it('a lower floor under a solid platform gets no link from it (no jump in place into its underside; ruling R28)', () => {
    const level = withPlatforms(
      { id: 'roof', kind: 'solid', x: 9, y: 6, w: 4, h: 1 },
      { id: 'under', kind: 'thin', x: 9, y: 1.5, w: 2, h: 0.4 },
    );
    const g = navGraph(level, AVERAGE);
    expect(g.find((l) => l.from === 'roof' && l.to === 'under')).toBeUndefined();
    // still reachable the long way round (off its edge onto another floor first)
    const way = route(g, 'roof', 'under')!;
    expect(way.length).toBeGreaterThan(1);
    expect(way.at(-1)!.to).toBe('under');
  });

  it('a bouncy platform is no floor: no links to or from it', () => {
    const level = withPlatforms({ id: 'bed', kind: 'thin', x: 9, y: 1.2, w: 3, h: 0.4, bounce: 1.4 });
    const g = navGraph(level, AVERAGE);
    expect(g.some((l) => l.from === 'bed' || l.to === 'bed')).toBe(false);
  });

  it('a body that jumps low cannot reach the side floors', () => {
    const low: MoveStats = { ...AVERAGE, jump: 9, airJump: 8 };
    expect(route(navGraph(TEST_LEVEL, low), 'main', 'left')).toBeNull();
  });

  it('is worked out once per level and body', () => {
    expect(navGraph(TEST_LEVEL, AVERAGE)).toBe(navGraph(TEST_LEVEL, AVERAGE));
  });
});
