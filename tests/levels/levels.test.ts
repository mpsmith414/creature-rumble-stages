import { describe, expect, it } from 'vitest';
import { LEVEL_ORDER, LEVELS, nextLevel } from '../../src/levels';
import { CAM } from '../../src/show/stage-camera';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { platformsAt, type Level, type Platform } from '../../src/stage/level';
import { lowGravity, MISCHIEF_TITLE, TRAIN_H, vineGrip } from '../../src/stage/mischief';
import { navGraph, route } from '../../src/stage/nav';
import { KINDS, loadFixture, type Kind } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<Kind, BodyStats>;
/** The TV's shape the camera bounds must fit at the widest view. */
const TV = 16 / 9;
/** Edge bounds lie at least this far (m) outside the camera bounds on every side. */
const BOUNDS_ROOM = 4;
/** Room for the scenery past the camera bounds (ruling R22): at the sides, and above and below (m). */
const SCENERY_SIDE = 6, SCENERY_UPDOWN = 3;
/** Taller than any fixture body (m): what hangs under a vine's grip. */
const TALLEST = 2.5;
const EPS = 1e-6;

/** Every platform of `level` at `n` moments through its longest swing. */
function sweep(level: Level, n = 48): Platform[][] {
  let period = 0;
  for (const p of level.platforms) if (p.path) period = Math.max(period, p.path.period);
  return Array.from({ length: period ? n : 1 }, (_, k) => platformsAt(level, (period * k) / n).map((p) => ({ ...p })));
}

/** The floors a fighter stands on (a bouncy bed throws everyone off, so it is no floor). */
const floors = (level: Level) => level.platforms.filter((p) => !p.bounce);

describe.each(LEVEL_ORDER.map((id) => [id, LEVELS[id as Exclude<typeof id, 'test'>]] as const))('the %s', (id, level) => {
  it('is its own level with its own id and a title', () => {
    expect(level.id).toBe(id);
    expect(level.name.length).toBeGreaterThan(2);
    expect(new Set(level.platforms.map((p) => p.id)).size).toBe(level.platforms.length);
  });

  it('fits the camera: every platform stays inside the camera bounds, which fit the widest view on a 16:9 TV', () => {
    const c = level.camera;
    expect(c.top - c.bottom).toBeLessThanOrEqual(CAM.maxHeight);
    expect(c.right - c.left).toBeLessThanOrEqual(CAM.maxHeight * TV);
    for (const ps of sweep(level)) {
      for (const p of ps) {
        expect(p.x - p.w / 2, p.id).toBeGreaterThanOrEqual(c.left - EPS);
        expect(p.x + p.w / 2, p.id).toBeLessThanOrEqual(c.right + EPS);
        expect(p.y - p.h, p.id).toBeGreaterThanOrEqual(c.bottom - EPS);
        expect(p.y, p.id).toBeLessThanOrEqual(c.top + EPS);
      }
    }
  });

  it(`has its edge bounds at least ${BOUNDS_ROOM} m outside the camera bounds`, () => {
    const b = level.bounds, c = level.camera;
    expect(c.left - b.left).toBeGreaterThanOrEqual(BOUNDS_ROOM);
    expect(b.right - c.right).toBeGreaterThanOrEqual(BOUNDS_ROOM);
    expect(c.bottom - b.bottom).toBeGreaterThanOrEqual(BOUNDS_ROOM);
    expect(b.top - c.top).toBeGreaterThanOrEqual(BOUNDS_ROOM);
  });

  it(`leaves room for its scenery: the edge bounds ${SCENERY_SIDE} m past the camera bounds at the sides, ${SCENERY_UPDOWN} m above and below (ruling R22)`, () => {
    const b = level.bounds, c = level.camera;
    expect(c.left - b.left).toBeGreaterThanOrEqual(SCENERY_SIDE);
    expect(b.right - c.right).toBeGreaterThanOrEqual(SCENERY_SIDE);
    expect(c.bottom - b.bottom).toBeGreaterThanOrEqual(SCENERY_UPDOWN);
    expect(b.top - c.top).toBeGreaterThanOrEqual(SCENERY_UPDOWN);
  });

  it('the toy train runs under every platform over its track, touching none', () => {
    for (const m of level.mischief) {
      if (m.name !== 'toyTrain') continue;
      const track = level.platforms.find((p) => p.id === m.track)!;
      for (const ps of sweep(level)) {
        for (const p of ps) {
          if (p.id === track.id || Math.abs(p.x - track.x) >= (p.w + track.w) / 2 || p.y <= track.y) continue;
          expect(p.y - p.h, p.id).toBeGreaterThanOrEqual(track.y + TRAIN_H);
        }
      }
    }
  });

  it('has several floors, some moving, and only thin platforms move (ruling R13)', () => {
    const heights = new Set(floors(level).map((p) => Math.round(p.y)));
    expect(heights.size).toBeGreaterThanOrEqual(3);
    expect(level.platforms.some((p) => p.path)).toBe(true);
    for (const p of level.platforms) if (p.path) expect(p.kind, p.id).toBe('thin');
  });

  it('has 8 entries, each standing on a floor and inside no solid platform', () => {
    expect(level.entries).toHaveLength(8);
    const ps = platformsAt(level, 0);
    for (const e of level.entries) {
      const on = ps.find((p) => !p.bounce && Math.abs(e.y - p.y) < EPS && Math.abs(e.x - p.x) <= p.w / 2 - 0.7);
      expect(on, `entry ${e.x}, ${e.y}`).toBeDefined();
      for (const p of ps) {
        if (p.kind !== 'solid') continue;
        const inside = Math.abs(e.x - p.x) < p.w / 2 && e.y < p.y - EPS && e.y > p.y - p.h;
        expect(inside, `entry ${e.x} in ${p.id}`).toBe(false);
      }
    }
    for (const x of level.drops) expect(Math.abs(x)).toBeLessThan(level.camera.right);
  });

  it('every floor is reachable from every floor for every fixture kind (low gravity too)', () => {
    const ids = floors(level).map((p) => p.id);
    const variants = level.mischief.some((m) => m.name === 'lowGravity') ? [level, lowGravity(level)] : [level];
    for (const l of variants) {
      for (const k of KINDS) {
        const g = navGraph(l, STATS[k].moves);
        for (const a of ids) for (const b of ids) expect(route(g, a, b), `${k} (g ${l.gravity}): ${a} → ${b}`).not.toBeNull();
      }
    }
  });

  it('has one or two bits of mischief, each with an announcer title', () => {
    expect(level.mischief.length).toBeGreaterThanOrEqual(1);
    expect(level.mischief.length).toBeLessThanOrEqual(2);
    for (const m of level.mischief) expect(MISCHIEF_TITLE[m.name]).toMatch(/^[A-Z ]+$/);
  });

  it('mischief data points at real platforms; vines swing over the ground, clear of every solid', () => {
    const ids = new Set(level.platforms.map((p) => p.id));
    for (const m of level.mischief) {
      if (m.name === 'river') expect(ids.has(m.floor)).toBe(true);
      if (m.name === 'toyTrain') expect(ids.has(m.track)).toBe(true);
      if (m.name !== 'vines') continue;
      const ground = level.platforms[0];
      for (const v of m.vines) {
        for (let k = 0; k < 64; k++) {
          const g = vineGrip(v, (v.period * k) / 64, { x: 0, y: 0 });
          expect(Math.abs(g.x - ground.x), 'over the ground').toBeLessThan(ground.w / 2 - 0.5);
          for (const p of level.platforms) {
            if (p.kind !== 'solid') continue;
            const overlap = Math.abs(g.x - p.x) < p.w / 2 + 1 && g.y > p.y - p.h && g.y - TALLEST < p.y;
            expect(overlap, `a rider under ${p.id}`).toBe(false);
          }
        }
      }
    }
  });
});

describe('level order', () => {
  it('goes jungle, ship, toy room and round again; the test level leads into the jungle', () => {
    expect(LEVEL_ORDER).toEqual(['jungle', 'ship', 'toyroom']);
    expect(nextLevel('jungle')).toBe('ship');
    expect(nextLevel('ship')).toBe('toyroom');
    expect(nextLevel('toyroom')).toBe('jungle');
    expect(nextLevel('test')).toBe('jungle');
  });

  it('the jungle has vines and the river, the ship the airlock and low gravity, the toy room the train and a bouncy bed', () => {
    const names = (id: 'jungle' | 'ship' | 'toyroom') => LEVELS[id].mischief.map((m) => m.name).sort();
    expect(names('jungle')).toEqual(['river', 'vines']);
    expect(names('ship')).toEqual(['airlock', 'lowGravity']);
    expect(names('toyroom')).toEqual(['toyTrain']);
    const bed = LEVELS.toyroom.platforms.find((p) => p.bounce);
    expect(bed).toMatchObject({ kind: 'thin', bounce: 1.4 });
  });
});
