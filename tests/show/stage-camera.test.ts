import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { TEST_LEVEL } from '../../src/levels/test';
import { BUBBLE_INSET, bubbleSpot, type BubbleSpot, type View } from '../../src/show/edge-bubbles';
import { CAM, framing, StageCamera, type Framing } from '../../src/show/stage-camera';

const BOUNDS = TEST_LEVEL.camera;
/** A TV's shape. */
const TV = 16 / 9;
type T = { x: number; y: number; h: number };
const t = (x: number, y: number, h = 1.5): T => ({ x, y, h });

/** The view's rectangle on the plane z = 0. */
const rect = (f: Framing, aspect: number) => ({
  left: f.cx - (f.height * aspect) / 2, right: f.cx + (f.height * aspect) / 2,
  bottom: f.cy - f.height / 2, top: f.cy + f.height / 2,
});
const EPS = 1e-9;

describe('framing: one side view that keeps everyone in shot', () => {
  test('frames everyone with a margin, inside the camera bounds', () => {
    const targets = [t(-5, 0), t(4, 3.5, 1.2), t(0, 7, 1)];
    const f = framing(targets, BOUNDS, TV);
    expect(f.height).toBeGreaterThanOrEqual(CAM.minHeight);
    expect(f.height).toBeLessThanOrEqual(CAM.maxHeight);
    const r = rect(f, TV);
    for (const a of targets) {
      expect(a.x - CAM.margin).toBeGreaterThanOrEqual(r.left - EPS);
      expect(a.x + CAM.margin).toBeLessThanOrEqual(r.right + EPS);
      expect(a.y - CAM.margin).toBeGreaterThanOrEqual(r.bottom - EPS);
      expect(a.y + a.h + CAM.margin).toBeLessThanOrEqual(r.top + EPS);
    }
    for (const r2 of [r, rect(framing([t(12, 0), t(14, 0)], BOUNDS, TV), TV)]) {
      // near the right edge the view slides back in rather than show past the bounds
      expect(r2.left).toBeGreaterThanOrEqual(BOUNDS.left - EPS);
      expect(r2.right).toBeLessThanOrEqual(BOUNDS.right + EPS);
      expect(r2.bottom).toBeGreaterThanOrEqual(BOUNDS.bottom - EPS);
      expect(r2.top).toBeLessThanOrEqual(BOUNDS.top + EPS);
    }
  });

  test('zooms in when close, out when spread', () => {
    const close = framing([t(-0.5, 0), t(0.5, 0)], BOUNDS, TV).height;
    const apart = framing([t(-8, 0), t(8, 0)], BOUNDS, TV).height;
    const tall = framing([t(0, 0), t(0, 10)], BOUNDS, TV).height;
    const far = framing([t(-14, 0), t(14, 0)], BOUNDS, TV).height;
    expect(close).toBe(CAM.minHeight);
    expect(apart).toBeGreaterThan(close);
    expect(far).toBeGreaterThan(apart);
    expect(tall).toBeGreaterThan(close);
    // a narrower screen needs a taller view to fit the same spread
    expect(framing([t(-8, 0), t(8, 0)], BOUNDS, 1).height).toBeGreaterThan(apart);
  });

  test('the size floor holds: a spread too wide stops at the largest view (edge bubbles take over)', () => {
    expect(framing([t(-30, 0), t(30, 0)], BOUNDS, TV).height).toBe(CAM.maxHeight);
    expect(framing([t(0, -20), t(0, 30)], BOUNDS, TV).height).toBe(CAM.maxHeight);
  });

  test('reuses out and allocates nothing new', () => {
    const out: Framing = { cx: 0, cy: 0, height: 0 };
    expect(framing([t(1, 0)], BOUNDS, TV, out)).toBe(out);
  });

  test('camera edge cases: none, one, and one far past the bounds', () => {
    const none = framing([], BOUNDS, TV);
    expect(none).toEqual({ cx: (BOUNDS.left + BOUNDS.right) / 2, cy: (BOUNDS.bottom + BOUNDS.top) / 2, height: CAM.maxHeight });
    const one = framing([t(2, 0, 1.5)], BOUNDS, TV);
    expect(one.height).toBe(CAM.minHeight);
    expect(one.cx).toBeCloseTo(2, 9);
    expect(one.cy).toBeCloseTo(0.75, 9);
    for (const ts of [[t(500, -500)], [t(0, 0), t(500, -500)], [t(NaN, 0), t(0, Infinity)]]) {
      const f = framing(ts, BOUNDS, TV);
      expect(Number.isFinite(f.cx) && Number.isFinite(f.cy) && Number.isFinite(f.height), JSON.stringify(ts)).toBe(true);
      expect(f.height).toBeGreaterThanOrEqual(CAM.minHeight);
      expect(f.height).toBeLessThanOrEqual(CAM.maxHeight);
    }
    expect(framing([t(0, 0), t(500, -500)], BOUNDS, TV).height).toBe(CAM.maxHeight);
    // a bad aspect (a zero-size canvas) does not poison the view
    const flat = framing([t(-8, 0), t(8, 0)], BOUNDS, 0);
    expect(Number.isFinite(flat.cx) && Number.isFinite(flat.height)).toBe(true);
  });
});

/** A TV-shaped camera. */
const tvCamera = () => new PerspectiveCamera(50, TV, 0.1, 300);

describe('StageCamera: eases toward the framing', () => {
  test('starts on the level, centred, at the largest view', () => {
    const sc = new StageCamera(tvCamera(), TEST_LEVEL);
    expect(sc.view.cx).toBe(0);
    expect(sc.view.cy).toBe(5);
    expect(sc.view.height).toBe(CAM.maxHeight);
  });

  test('shows exactly the framed view on the plane z = 0', () => {
    const cam = tvCamera();
    const sc = new StageCamera(cam, TEST_LEVEL);
    sc.update([t(-3, 0), t(3, 3.5)], 100);
    cam.updateMatrixWorld();
    const r = rect(sc.view, TV);
    const ndc = (x: number, y: number) => new Vector3(x, y, 0).project(cam);
    const tl = ndc(r.left, r.top), br = ndc(r.right, r.bottom);
    expect(tl.x).toBeCloseTo(-1, 6);
    expect(tl.y).toBeCloseTo(1, 6);
    expect(br.x).toBeCloseTo(1, 6);
    expect(br.y).toBeCloseTo(-1, 6);
  });

  test('easing is frame-rate independent', () => {
    const goal = [t(8, 0), t(9, 0)];
    const a = new StageCamera(tvCamera(), TEST_LEVEL), b = new StageCamera(tvCamera(), TEST_LEVEL);
    for (let i = 0; i < 60; i++) a.update(goal, 1 / 60);
    for (let i = 0; i < 30; i++) b.update(goal, 1 / 30);
    for (const k of ['cx', 'cy', 'height'] as const) {
      expect(Math.abs(a.view[k] - b.view[k]), k).toBeLessThanOrEqual(0.01 * Math.max(1, Math.abs(a.view[k])));
    }
    // moved most of the way in a second, smoothly (not a cut)
    const f = framing(goal, BOUNDS, TV);
    expect(a.view.height).toBeLessThan(CAM.maxHeight);
    expect(a.view.height).toBeGreaterThan(f.height);
    expect(Math.abs(a.view.height - f.height)).toBeLessThan(0.1 * (CAM.maxHeight - f.height));
  });

  test('a far-off target never puts NaN into the camera', () => {
    const cam = tvCamera();
    const sc = new StageCamera(cam, TEST_LEVEL);
    for (let i = 0; i < 30; i++) sc.update([t(0, 0), t(500, -500)], 1 / 60);
    expect([cam.position.x, cam.position.y, cam.position.z].every(Number.isFinite)).toBe(true);
  });

  test('a close-up takes over for its time, still eased, then hands back', () => {
    const sc = new StageCamera(tvCamera(), TEST_LEVEL);
    const play = [t(-6, 0), t(6, 0)];
    sc.update(play, 100);
    const normal = sc.view.height;
    sc.closeUp({ x: 2, y: 1 }, 4, 1);
    sc.update(play, 1 / 60);
    expect(sc.view.height).toBeLessThan(normal);
    expect(sc.view.height).toBeGreaterThan(4); // eased, not a cut
    for (let i = 0; i < 50; i++) sc.update(play, 1 / 60);
    expect(sc.view.height).toBeLessThan(5);
    expect(sc.view.cx).toBeGreaterThan(1);
    for (let i = 0; i < 240; i++) sc.update(play, 1 / 60); // the close-up is over: back to everyone
    expect(sc.view.height).toBeCloseTo(normal, 1);
  });
});

describe('StageCamera: a broken frame time changes nothing (R23)', () => {
  test('a NaN, infinite, zero or negative dt neither moves the view nor runs the close-up down', () => {
    const sc = new StageCamera(tvCamera(), TEST_LEVEL);
    const play = [t(-6, 0), t(6, 0)];
    sc.update(play, 1);
    const before = { ...sc.view };
    sc.closeUp({ x: 2, y: 1 }, 4, 0.5);
    for (const bad of [NaN, Infinity, -Infinity, 0, -1]) {
      sc.update(play, bad);
      expect(sc.view).toEqual(before);
    }
    // the close-up still has its whole half second: 20 frames in, it is still on and closing in
    for (let i = 0; i < 20; i++) sc.update(play, 1 / 60);
    expect(sc.view.height).toBeLessThan(before.height - 2);
    for (const v of Object.values(sc.view)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('edge bubbles: a creature outside the view gets a bubble at the edge, pointing at it', () => {
  const view: View = { cx: 0, cy: 5, height: 10, aspect: 2 }; // shows x −10…10, y 0…10
  const spot = (): BubbleSpot => ({ left: 0, top: 0, angle: 0 });

  test('no bubble for a creature in view', () => {
    expect(bubbleSpot(3, 2, 1.5, view, spot())).toBe(false);
    expect(bubbleSpot(-9, 0, 1.5, view, spot())).toBe(false);
  });

  test('off the right side: a bubble on the right edge at its height, pointing right', () => {
    const s = spot();
    expect(bubbleSpot(14, 4.25, 1.5, view, s)).toBe(true);
    expect(s.left).toBeCloseTo(1 - BUBBLE_INSET / view.aspect, 9);
    expect(s.top).toBeCloseTo(0.5, 9);
    expect(s.angle).toBeCloseTo(0, 6);
  });

  test('above the top: a bubble on the top edge, pointing up', () => {
    const s = spot();
    expect(bubbleSpot(-2, 15, 1, view, s)).toBe(true);
    expect(s.top).toBeCloseTo(BUBBLE_INSET, 9);
    expect(s.left).toBeCloseTo(0.4, 9);
    expect(s.angle).toBeCloseTo(-90, 6);
  });

  test('off a corner: held in the corner, pointing toward it; far away stays finite', () => {
    const s = spot();
    expect(bubbleSpot(-30, -20, 1, view, s)).toBe(true);
    expect(s.left).toBeCloseTo(BUBBLE_INSET / view.aspect, 9);
    expect(s.top).toBeCloseTo(1 - BUBBLE_INSET, 9);
    expect(s.angle).toBeGreaterThan(90);
    expect(s.angle).toBeLessThan(180);
    expect(bubbleSpot(1e6, -1e6, 1, view, s)).toBe(true);
    expect([s.left, s.top, s.angle].every(Number.isFinite)).toBe(true);
  });
});
