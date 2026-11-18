import { BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, Vector3, type Material } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { LEVELS } from '../../src/levels';
import { TEST_LEVEL } from '../../src/levels/test';
import { exitSide, KO_SECONDS, koKind, koSpot, KoFx, type ExitSide, type KoKind } from '../../src/show/ko-fx';
import type { View } from '../../src/show/stage-camera';

const view: View = { cx: 0, cy: 6, height: 20, aspect: 16 / 9 };

/** How many instances of the effects' meshes are drawn at more than a speck's size. */
function drawn(root: Group): number {
  let n = 0;
  const m4 = new Matrix4(), s = new Vector3();
  root.traverse((o) => {
    if (!(o instanceof InstancedMesh) || !o.visible) return;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m4);
      s.setFromMatrixScale(m4);
      if (s.x > 1e-3) n++;
    }
  });
  return n;
}

describe('knockout effects', () => {
  test('ko kind by level and exit side', () => {
    const table: [string, ExitSide, KoKind][] = [
      ['jungle', 'top', 'star'], ['jungle', 'bottom', 'splash'], ['jungle', 'left', 'poof'], ['jungle', 'right', 'poof'],
      ['ship', 'top', 'star'], ['ship', 'bottom', 'space'], ['ship', 'left', 'space'], ['ship', 'right', 'space'],
      ['toyroom', 'top', 'star'], ['toyroom', 'bottom', 'poof'], ['toyroom', 'left', 'poof'], ['toyroom', 'right', 'poof'],
      ['test', 'top', 'star'], ['test', 'bottom', 'poof'], ['test', 'left', 'poof'],
    ];
    for (const [level, side, kind] of table) expect(koKind(level as never, side), `${level} ${side}`).toBe(kind);
  });

  test('the exit side is the edge the creature went out past (the furthest past when two)', () => {
    const b = LEVELS.jungle.bounds;
    expect(exitSide(b, { x: 0, y: b.top + 0.1 })).toBe('top');
    expect(exitSide(b, { x: 0, y: b.bottom - 0.1 })).toBe('bottom');
    expect(exitSide(b, { x: b.left - 0.1, y: 3 })).toBe('left');
    expect(exitSide(b, { x: b.right + 0.1, y: 3 })).toBe('right');
    expect(exitSide(b, { x: b.right + 3, y: b.bottom - 0.5 })).toBe('right');
    expect(exitSide(b, { x: b.right + 0.2, y: b.top + 4 })).toBe('top');
    // not out at all, or broken: the nearest edge, never a crash
    expect(['top', 'bottom', 'left', 'right']).toContain(exitSide(b, { x: Number.NaN, y: 0 }));
  });

  test('every effect shows inside the view, near the edge it went out by', () => {
    const halfW = (view.height * view.aspect) / 2;
    const left = view.cx - halfW, right = view.cx + halfW, bottom = view.cy - view.height / 2, top = view.cy + view.height / 2;
    const inside = (p: { x: number; y: number }) => p.x > left && p.x < right && p.y > bottom && p.y < top;
    const star = koSpot('star', { x: 5, y: 40 }, view);
    expect(inside(star)).toBe(true);
    expect(star.y).toBeGreaterThan(view.cy + view.height * 0.3);
    expect(star.x).toBeCloseTo(5, 6);
    const splash = koSpot('splash', { x: -50, y: -30 }, view);
    expect(inside(splash)).toBe(true);
    expect(splash.y).toBeLessThan(view.cy - view.height * 0.3);
    expect(splash.x).toBeLessThan(left + halfW * 0.3);
    const space = koSpot('space', { x: 40, y: 3 }, view);
    expect(inside(space)).toBe(true);
    expect(space.x).toBeGreaterThan(right - halfW * 0.3);
    expect(space.y).toBeCloseTo(3, 6);
    const poof = koSpot('poof', { x: Number.NaN, y: Number.POSITIVE_INFINITY }, view);
    expect(Number.isFinite(poof.x) && Number.isFinite(poof.y)).toBe(true);
  });

  test('an effect plays, then is gone after its time; many at once never break', () => {
    const root = new Group();
    const fx = new KoFx(root, view);
    expect(drawn(root)).toBe(0);
    for (const kind of ['star', 'splash', 'space', 'poof'] as const) {
      fx.play(kind, { x: 30, y: 3 });
      fx.update(0.1);
      expect(drawn(root), kind).toBeGreaterThan(0);
      for (let t = 0; t < KO_SECONDS + 0.2; t += 1 / 60) fx.update(1 / 60);
      expect(drawn(root), kind).toBe(0);
    }
    for (let i = 0; i < 30; i++) fx.play((['star', 'splash', 'space', 'poof'] as const)[i % 4], { x: i, y: -20 });
    fx.update(0.2);
    expect(drawn(root)).toBeGreaterThan(0);
    fx.update(Number.NaN);
    fx.update(-1);
    fx.dispose();
  });

  test('cheap: a few draw calls for every effect at once, and dispose frees them', () => {
    const root = new Group();
    const fx = new KoFx(root, view);
    const meshes: Mesh[] = [];
    root.traverse((o) => {
      if (o instanceof Mesh) meshes.push(o);
    });
    expect(meshes.length).toBeLessThanOrEqual(4);
    const things = new Set<BufferGeometry | Material>();
    for (const m of meshes) {
      things.add(m.geometry as BufferGeometry);
      things.add(m.material as Material);
    }
    const freed = new Set<unknown>();
    for (const x of things) x.addEventListener('dispose', () => freed.add(x));
    fx.dispose();
    for (const x of things) expect(freed.has(x)).toBe(true);
    expect(root.children.length).toBe(0);
  });

  test('behind the creatures (never covering one), yet shown where the camera puts koSpot on the screen', () => {
    const FOV = 30, dist = view.height / 2 / Math.tan((FOV * Math.PI) / 360);
    for (const kind of ['star', 'splash', 'space', 'poof'] as const) {
      const root = new Group(), fx = new KoFx(root, view, FOV);
      const at = { x: 40, y: kind === 'star' ? 40 : 3 };
      fx.play(kind, at);
      fx.update(0.05);
      const m4 = new Matrix4(), p = new Vector3(), sc = new Vector3();
      let n = 0;
      root.traverse((o) => {
        if (!(o instanceof InstancedMesh)) return;
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, m4);
          sc.setFromMatrixScale(m4);
          if (sc.x <= 1e-3) continue;
          p.setFromMatrixPosition(m4);
          expect(p.z, `${kind} ${o.name}`).toBeLessThanOrEqual(-0.5);
          n++;
        }
      });
      expect(n, kind).toBeGreaterThan(0);
      // the effect's middle seen from the camera (on the plane z = 0) lands on koSpot
      const spot = koSpot(kind, at, view), first = new Vector3();
      const mesh = (root.children.find((o) => o.name === (kind === 'splash' || kind === 'poof' ? 'ko:rings' : 'ko:stars')) as InstancedMesh);
      if (kind !== 'poof') {
        mesh.getMatrixAt(0, m4);
        first.setFromMatrixPosition(m4);
        const k = dist / (dist - first.z); // projected back onto the plane z = 0 from the camera
        expect(view.cx + (first.x - view.cx) * k, kind).toBeCloseTo(spot.x, 1);
        expect(view.cy + (first.y - view.cy) * k, kind).toBeCloseTo(spot.y, 1);
      }
      fx.dispose();
    }
  });

  test('the practice level is known too', () => {
    expect(koKind(TEST_LEVEL.id, 'right')).toBe('poof');
  });
});
