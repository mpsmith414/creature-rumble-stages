import { describe, expect, it } from 'vitest';
import { buildBody, type BodyData, type BuildTimes } from '../../src/builder/build';
import { hashNumbers } from '../../src/util/hash';
import { hawk } from '../fixtures/cast/hawk';
import { trout } from '../fixtures/cast/trout';
import { biped, bird, blob, hexapod, quadruped, snake } from '../fixtures/recipes';
import { minValence, topology, unitNormals } from '../fixtures/mesh';

/** buildBody's whole-body checks over many bodies (apart from build.test.ts, so the two run side by side). */
describe('buildBody, every level', () => {
  let quad: BodyData | null = null;
  const full = (r: typeof quadruped) => (r === quadruped ? (quad ??= buildBody(r)) : buildBody(r)); // the quadruped serves two tests

  for (const r of [quadruped, snake, hexapod, blob, biped, bird])
    it(`makes three levels of detail, each closed: ${r.name}`, () => {
      const b = full(r);
      expect(b.lods).toHaveLength(3);
      const tris = b.lods.map((l) => l.indices.length / 3);
      expect(tris[0]).toBeGreaterThan(tris[1]);
      expect(tris[1]).toBeGreaterThan(tris[2]);
      expect(Math.abs(tris[1] / (tris[0] / 4) - 1)).toBeLessThan(0.3);
      expect(Math.abs(tris[2] / (tris[0] / 16) - 1)).toBeLessThan(0.4);
      expect(b.lods[0].positions.length / 3).toBeLessThanOrEqual(120_000);
      for (const l of b.lods) {
        for (const p of l.positions) expect(Number.isFinite(p)).toBe(true);
        expect(unitNormals(l.normals)).toBe(true);
        expect(minValence(l)).toBeGreaterThanOrEqual(3);
        const { edges } = topology(l);
        expect([...edges.values()].every((c) => c === 2)).toBe(true); // closed
      }
    }, 20_000); // sampled finely and simplified to three levels: several seconds when every test file runs at once

  it('keeps thin parts sound: small snaps, unit normals that agree with their triangles, no flaps', () => {
    for (const r of [trout, hawk]) {
      const times: BuildTimes = { sample: 0, mesh: 0, weigh: 0, simplify: 0, snap: 0, skin: 0, rawVertices: 0, maxSnap: 0 };
      const lods = buildBody(r, [0, 1, 2], times).lods;
      expect(times.maxSnap).toBeLessThanOrEqual(1 + 1e-9); // at most one fine cell
      for (const l of lods) {
        expect(unitNormals(l.normals)).toBe(true);
        expect(minValence(l)).toBeGreaterThanOrEqual(3); // no back-to-back fin flaps
      }
      const { positions: P, normals: N, indices: I } = lods[0];
      let flipped = 0; // triangles whose face opposes all three of their vertex normals
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
        if ([a, b, c].every((o) => fx * N[o] + fy * N[o + 1] + fz * N[o + 2] < 0)) flipped++;
      }
      expect(flipped / (I.length / 3)).toBeLessThanOrEqual(0.0005); // measured: trout 3 of 13358, hawk 0
    }
  }, 20_000);

  it('gives one level alone exactly as the full set does', () => {
    const two = buildBody(quadruped, [2]).lods[0], whole = full(quadruped).lods[2];
    expect(hashNumbers(two.positions)).toBe(hashNumbers(whole.positions));
    expect(hashNumbers(two.indices)).toBe(hashNumbers(whole.indices));
  }, 20_000);
});
