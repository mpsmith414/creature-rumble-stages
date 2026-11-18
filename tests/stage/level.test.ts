import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_LEVEL } from '../../src/levels/test';
import { platformsAt, topBelow, type Platform } from '../../src/stage/level';

describe('platformsAt', () => {
  it('is pure: same t, same result, the level untouched', () => {
    const before = JSON.stringify(TEST_LEVEL);
    expect(platformsAt(TEST_LEVEL, 1.7)).toEqual(platformsAt(TEST_LEVEL, 1.7));
    platformsAt(TEST_LEVEL, 2.2);
    expect(JSON.stringify(TEST_LEVEL)).toBe(before);
  });

  it('is periodic and moves the moving platform', () => {
    const centre = (t: number) => platformsAt(TEST_LEVEL, t).find((p) => p.id === 'centre')!;
    for (const t of [0, 0.4, 1.3, 2.9, 4.5]) {
      const a = centre(t), b = centre(t + 6);
      expect(b.x).toBeCloseTo(a.x, 9);
      expect(b.y).toBeCloseTo(a.y, 9);
    }
    expect(centre(1.5).x).toBeCloseTo(3, 9);
    expect(centre(4.5).x).toBeCloseTo(-3, 9);
    expect(centre(1.5).y).toBe(7);
    expect(platformsAt(TEST_LEVEL, 1.5).find((p) => p.id === 'main')!.x).toBe(0);
  });

  it('reuses out (the array and its platforms)', () => {
    const out: Platform[] = [];
    expect(platformsAt(TEST_LEVEL, 1, out)).toBe(out);
    const first = out[3];
    platformsAt(TEST_LEVEL, 2, out);
    expect(out[3]).toBe(first);
    expect(out).toHaveLength(TEST_LEVEL.platforms.length);
    expect(out).toEqual(platformsAt(TEST_LEVEL, 2));
  });
});

describe('topBelow (where confetti lies)', () => {
  const ps: Platform[] = [
    { id: 'ground', kind: 'solid', x: 0, y: 0, w: 20, h: 4 },
    { id: 'branch', kind: 'thin', x: 2, y: 5, w: 4, h: 0.4 },
  ];
  it('is the top of the highest platform under x at or below y, not one overhead; null where nothing is under', () => {
    expect(topBelow(ps, 2, 6)).toBe(5); // over the branch
    expect(topBelow(ps, 2, 4.9)).toBe(0); // under the branch: the ground, never the branch over it
    expect(topBelow(ps, 2, 5)).toBe(5); // lying on it
    expect(topBelow(ps, -5, 9)).toBe(0);
    expect(topBelow(ps, 2, -1)).toBeNull(); // under the ground
    expect(topBelow(ps, 30, 9)).toBeNull(); // past the ends
  });
});

describe('TEST_LEVEL', () => {
  it('is the plain test level of the brief', () => {
    const [main, ...thin] = TEST_LEVEL.platforms;
    expect(main).toMatchObject({ kind: 'solid', x: 0, y: 0, w: 24 });
    expect(thin.map((p) => [p.kind, p.y])).toEqual([['thin', 3.5], ['thin', 3.5], ['thin', 7]]);
    expect(thin[0].x).toBeLessThan(0);
    expect(thin[1].x).toBeGreaterThan(0);
    expect(thin[2]).toMatchObject({ x: 0, path: { dx: 3, dy: 0, period: 6 } });
    expect(TEST_LEVEL.bounds).toEqual({ left: -22, right: 22, bottom: -10, top: 20 });
    expect(TEST_LEVEL.camera).toEqual({ left: -16, right: 16, bottom: -4, top: 14 });
    expect(TEST_LEVEL.gravity).toBe(30);
    expect(new Set(TEST_LEVEL.platforms.map((p) => p.id)).size).toBe(TEST_LEVEL.platforms.length);
  });
});

/** Every source file under dir, subfolders included. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : /\.[cm]?[jt]sx?$/.test(e.name) ? [join(dir, e.name)] : []);
}

/** An import of three.js or Rapier in any form: `from '…'`, a bare `import '…'`, a dynamic `import('…')` or `require`. */
const ENGINE_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"`](?:three|@dimforge)[/'"`]/;

describe('src/stage', () => {
  it('the import guard catches every form of import', () => {
    for (const bad of [
      "import * as THREE from 'three';",
      "import { Mesh } from 'three/webgpu';",
      "import 'three';",
      "const R = await import('@dimforge/rapier3d-compat');",
      "const R = await import(\n  '@dimforge/rapier3d-compat');",
      'export { X } from "three";',
      'import type { World } from "@dimforge/rapier3d-compat";',
    ]) expect(bad, bad).toMatch(ENGINE_IMPORT);
    for (const ok of ["import { lerp } from './threeish';", "// three things from 'here'", "import { x } from '../threes';"])
      expect(ok, ok).not.toMatch(ENGINE_IMPORT);
  });

  it('imports neither three.js nor Rapier (subfolders too)', () => {
    const files = sourceFiles(join(__dirname, '../../src/stage'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(ENGINE_IMPORT);
  });
});
