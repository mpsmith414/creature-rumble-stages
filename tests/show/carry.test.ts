import { describe, expect, test } from 'vitest';
import { LEVELS } from '../../src/levels';
import { TEST_LEVEL } from '../../src/levels/test';
import { carryAt, carryRoute } from '../../src/show/carry';
import { topSpot } from '../../src/show/drop-in';
import { platformsAt, solidAt } from '../../src/stage/level';
import type { V2 } from '../../src/stage/types';

/** Points along a carry, from start (k 0) to end (k 1). */
const SAMPLES = 240;
/** A small creature's box and the biggest's (m). */
const BOXES = [{ w: 0.8, h: 1.1 }, { w: 1.8, h: 2.4 }];

describe('the champion carried up to the top platform (final review #3)', () => {
  test('on every level, from a sweep of start spots, the carried box never overlaps a solid, and it ends on the top spot', () => {
    for (const level of [...Object.values(LEVELS), TEST_LEVEL]) {
      const ps = platformsAt(level, 0), to = topSpot(level), c = level.camera;
      const at: V2 = { x: 0, y: 0 };
      let starts = 0;
      for (const { w, h } of BOXES) {
        for (let x = c.left; x <= c.right; x += 0.75) {
          for (let y = c.bottom; y <= c.top; y += 0.75) {
            const from = { x, y };
            if (solidAt(ps, x, y, w, h)) continue; // nobody stands inside a solid
            starts++;
            const route = carryRoute(ps, from, to, w, h);
            for (let i = 0; i <= SAMPLES; i++) {
              carryAt(from, to, route, i / SAMPLES, at);
              const hit = solidAt(ps, at.x, at.y, w, h);
              if (hit) throw new Error(`${level.id}: from (${x}, ${y}) a ${w}×${h} box passes through ${hit.id} at (${at.x.toFixed(2)}, ${at.y.toFixed(2)})`);
            }
            expect(carryAt(from, to, route, 0, at)).toEqual(from);
            carryAt(from, to, route, 1, at);
            expect(at.x).toBeCloseTo(to.x, 9);
            expect(at.y).toBeCloseTo(to.y, 9);
          }
        }
      }
      expect(starts).toBeGreaterThan(500);
    }
  });

  test('the toy room: a champion under a toy block goes out from under it before it rises (it never passes through the block)', () => {
    const level = LEVELS.toyroom, ps = platformsAt(level, 0), to = topSpot(level);
    const from = { x: -9, y: 0 }, w = 1, h = 1.6;
    const route = carryRoute(ps, from, to, w, h);
    expect(route).not.toBeNull(); // the plain arc would pass through blockL
    const at: V2 = { x: 0, y: 0 };
    let rose = false;
    for (let i = 0; i <= SAMPLES; i++) {
      carryAt(from, to, route, i / SAMPLES, at);
      if (at.y > 1) {
        rose = true;
        expect(Math.abs(at.x - -9)).toBeGreaterThanOrEqual(1.5 + w / 2 - 1e-6); // out from under the block
        break;
      }
    }
    expect(rose).toBe(true);
  });

  test('where nothing is in the way it keeps the plain arc (from one block top to the crayon)', () => {
    const level = LEVELS.toyroom, ps = platformsAt(level, 0), to = topSpot(level);
    const from = { x: -9, y: 3.5 };
    expect(carryRoute(ps, from, to, 1, 1.6)).toBeNull();
    const mid = carryAt(from, to, null, 0.5, { x: 0, y: 0 });
    expect(mid.x).toBeCloseTo((from.x + to.x) / 2, 9);
    expect(mid.y).toBeGreaterThan(to.y + 1); // lifted over the straight way
  });
});
