import { Box3, Mesh, type Object3D } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { testScenery, SCENERY_REACH } from '../../src/levels/scenery/test';
import { TEST_LEVEL } from '../../src/levels/test';
import { platformsAt } from '../../src/stage/level';

const L = TEST_LEVEL;

/** Every mesh in the scenery (each is one draw call). */
function meshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof Mesh) out.push(o);
  });
  return out;
}

describe('the test level drawn as grey-box scenery', () => {
  test('reaches well past the camera bounds, so a wide view never shows a bare edge (R22)', () => {
    expect(SCENERY_REACH.side).toBeGreaterThanOrEqual(6);
    expect(SCENERY_REACH.vertical).toBeGreaterThanOrEqual(3);
    const s = testScenery(L);
    s.group.updateMatrixWorld(true);
    const box = new Box3().setFromObject(s.group);
    expect(box.min.x).toBeLessThanOrEqual(L.camera.left - 6);
    expect(box.max.x).toBeGreaterThanOrEqual(L.camera.right + 6);
    expect(box.min.y).toBeLessThanOrEqual(L.camera.bottom - 3);
    expect(box.max.y).toBeGreaterThanOrEqual(L.camera.top + 3);
    // the near layer too (the cloud sea under the stage), not only the far sky
    const near = new Box3().setFromObject(s.group.getObjectByName('scenery:cloud-sea')!);
    expect(near.min.x).toBeLessThanOrEqual(L.camera.left - 6);
    expect(near.max.x).toBeGreaterThanOrEqual(L.camera.right + 6);
    s.dispose();
  });

  test('every platform stands where the level has it: its top on its y, its sides on its width', () => {
    const s = testScenery(L);
    s.update(0);
    s.group.updateMatrixWorld(true);
    for (const p of platformsAt(L, 0)) {
      const box = new Box3().setFromObject(s.group.getObjectByName(`platform:${p.id}`)!);
      expect(box.max.y, p.id).toBeCloseTo(p.y, 6);
      // the visible top may overhang a little (a lip), never more than 0.15 m a side, never short
      expect(box.min.x, p.id).toBeLessThanOrEqual(p.x - p.w / 2 + 1e-6);
      expect(box.min.x, p.id).toBeGreaterThan(p.x - p.w / 2 - 0.15);
      expect(box.max.x, p.id).toBeGreaterThanOrEqual(p.x + p.w / 2 - 1e-6);
      expect(box.max.x, p.id).toBeLessThan(p.x + p.w / 2 + 0.15);
    }
    s.dispose();
  });

  test('the moving platform is drawn where it is at the time given', () => {
    const s = testScenery(L);
    for (const t of [0, 1.5, 4.2]) {
      s.update(t);
      s.group.updateMatrixWorld(true);
      const p = platformsAt(L, t).find((q) => q.id === 'centre')!;
      const box = new Box3().setFromObject(s.group.getObjectByName('platform:centre')!);
      expect((box.min.x + box.max.x) / 2, `t=${t}`).toBeCloseTo(p.x, 6);
      expect(box.max.y).toBeCloseTo(p.y, 6);
    }
    s.dispose();
  });

  test('cheap to draw: a handful of draw calls', () => {
    const s = testScenery(L);
    expect(meshes(s.group).length).toBeLessThanOrEqual(30);
    s.dispose();
  });
});
