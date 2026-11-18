import { describe, expect, it } from 'vitest';
import { buildSkeleton } from '../../src/builder/skeleton';
import { TEST_LEVEL } from '../../src/levels/test';
import type { Recipe } from '../../src/recipe/schema';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { KINDS, loadFixture, type Kind } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<Kind, BodyStats>;

/** How high a jump at speed v rises on the test level (m). */
const peak = (v: number) => (v * v) / (2 * TEST_LEVEL.gravity);
/** The floors of the test level are this far apart (m); a hop must clear one with a little to spare. */
const FLOOR_GAP = 3.5, CLIMB = 3.9;
/** A creature knocked off the side starts its way back this far below the stage's top (m). */
const BELOW_EDGE = 2;

/** The recipe with every length, thickness and offset scaled by f (a bigger or smaller copy of the same body). */
function scaled(r: Recipe, f: number): Recipe {
  const v = (p: { x: number; y: number; z: number }) => ({ x: p.x * f, y: p.y * f, z: p.z * f });
  return { ...r, parts: r.parts.map((p) => ({ ...p, offset: v(p.offset), length: p.length * f, r0: p.r0 * f, r1: p.r1 * f })) };
}

describe('bodyStats', () => {
  it('every fixture kind has finite, positive stats', () => {
    for (const k of KINDS) {
      const s = STATS[k];
      for (const [name, n] of Object.entries({ height: s.height, w: s.w, h: s.h, weight: s.weight, reach: s.reach, ...s.moves })) {
        expect(Number.isFinite(n), `${k}.${name}`).toBe(true);
        expect(n, `${k}.${name}`).toBeGreaterThan(0);
      }
      expect(s.weight, k).toBeGreaterThanOrEqual(0.6);
      expect(s.weight, k).toBeLessThanOrEqual(1.6);
      expect(s.height, k).toBeGreaterThanOrEqual(0.7);
      expect(s.height, k).toBeLessThanOrEqual(2.4);
      expect(s.h, k).toBeLessThanOrEqual(s.height + 1e-9);
      expect(s.moves.fastFall, k).toBeGreaterThan(s.moves.fall);
      expect(s.layout.segments.length, k).toBeGreaterThan(0);
    }
    expect(STATS.blob.move).toBe('bump');
    expect(STATS.legs.move).toBe('kick');
  });

  it('bigger and rounder is heavier, tiny is lightest', () => {
    expect(STATS.blob.weight).toBeGreaterThan(STATS.tiny.weight);
    expect(STATS.blob.weight).toBeGreaterThan(STATS.fists.weight);
    for (const k of KINDS) expect(STATS[k].weight, k).toBeGreaterThanOrEqual(STATS.tiny.weight);
    expect(STATS.blob.w).toBeGreaterThan(STATS.legs.w);
  });

  it('the box is the body, not the wings', () => {
    const sk = buildSkeleton(loadFixture('wings'));
    const s = STATS.wings;
    expect(s.w).toBeLessThan((sk.max.x - sk.min.x) * s.layout.scale);
    // and not the tail: it sticks out far behind (front to back is z), the box stays about the torso's size
    const tailSk = buildSkeleton(loadFixture('tail'));
    expect(STATS.tail.w).toBeLessThan(0.5 * (tailSk.max.z - tailSk.min.z) * STATS.tail.layout.scale);
  });

  it('every fixture kind can climb a floor and recover', () => {
    for (const k of KINDS) {
      const m = STATS[k].moves;
      expect(peak(m.jump) + peak(m.airJump), k).toBeGreaterThanOrEqual(CLIMB);
      expect(peak(m.airJump) + peak(m.recovery), k).toBeGreaterThanOrEqual(BELOW_EDGE);
    }
    expect(CLIMB).toBeGreaterThan(FLOOR_GAP);
  });

  it('reach comes from the weapons: a kicking leg and a tail reach further than a tiny jab', () => {
    expect(STATS.legs.reach).toBeGreaterThan(STATS.tiny.reach);
    expect(STATS.tail.reach).toBeGreaterThan(STATS.tiny.reach);
    for (const k of KINDS) expect(STATS[k].reach, k).toBeGreaterThanOrEqual(STATS[k].w / 2);
  });

  it('extremes', () => {
    const small = bodyStats(scaled(loadFixture('fists'), 0.05));
    const large = bodyStats(scaled(loadFixture('fists'), 6));
    expect(small.height).toBeCloseTo(0.7, 6);
    expect(large.height).toBeCloseTo(2.4, 6);
    for (const s of [small, large]) {
      for (const n of [s.w, s.h, s.weight, s.reach, ...Object.values(s.moves)]) expect(Number.isFinite(n)).toBe(true);
      expect(s.moves.run).toBeGreaterThanOrEqual(5);
      expect(s.moves.run).toBeLessThanOrEqual(10);
      expect(peak(s.moves.jump) + peak(s.moves.airJump)).toBeGreaterThanOrEqual(CLIMB);
    }
    // small creatures run a little faster and jump relatively higher (in body heights)
    expect(small.moves.run).toBeGreaterThan(large.moves.run);
    expect(peak(small.moves.jump) / small.height).toBeGreaterThan(peak(large.moves.jump) / large.height);
    expect(small.weight).toBeLessThan(large.weight);
  });
});

describe('bodyStats from a built body (Task 15)', () => {
  it('lays the body out from the skeleton it is given (the worker’s), so its looks always fit that body’s bones', () => {
    const recipe = loadFixture('fists'), other = buildSkeleton(loadFixture('tail'));
    const own = bodyStats(recipe), given = bodyStats(recipe, other);
    expect(own.layout.boneSegment).toHaveLength(buildSkeleton(recipe).bones.length);
    expect(given.layout.boneSegment).toHaveLength(other.bones.length);
    expect(other.bones.length).not.toBe(buildSkeleton(recipe).bones.length);
  });
});
