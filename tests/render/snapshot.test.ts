import { Group, PerspectiveCamera, Scene, Vector3, type WebGPURenderer } from 'three/webgpu';
import { describe, expect, test, vi } from 'vitest';
import type { BodyData } from '../../src/builder/build';
import type { Recipe } from '../../src/recipe/schema';

// the creature drawn is a stand-in (this checks how the TV's canvas is borrowed, not how a creature looks)
const disposed = vi.fn();
vi.mock('../../src/render/fighter-object', () => ({ createFighterObject: () => ({ root: new Group(), dispose: disposed }) }));
vi.mock('../../src/anim/layout', () => ({ bodyLayout: () => ({ scale: 1 }) }));
vi.mock('../../src/fight/moves', () => ({ planFor: () => ({}) }));

const { renderView } = await import('../../src/render/snapshot');

/** A fake renderer over a 1920 × 1080 canvas at pixel ratio 2 (a CSS size of 960 × 540), like the TV's. */
function tv(o: { failOn?: 'studio' | 'compile' } = {}) {
  const canvas = { width: 1920, height: 1080, toDataURL: () => 'data:image/png;base64,AAAA' };
  let ratio = 2, css = { w: 960, h: 540 };
  const stage = new Scene();
  const renders: Scene[] = [];
  const renderer = {
    domElement: canvas,
    getPixelRatio: () => ratio,
    setPixelRatio(r: number) {
      ratio = r;
      canvas.width = css.w * r;
      canvas.height = css.h * r;
    },
    setSize(w: number, h: number) {
      css = { w, h };
      canvas.width = w * ratio;
      canvas.height = h * ratio;
    },
    async compileAsync() {
      if (o.failOn === 'compile') throw new Error('lost the GPU');
    },
    render(scene: Scene) {
      renders.push(scene);
      if (scene !== stage && o.failOn === 'studio') throw new Error('lost the GPU');
    },
  };
  const ctx = { renderer: renderer as unknown as WebGPURenderer, scene: stage, camera: new PerspectiveCamera() };
  return { ctx, canvas, stage, renders, ratio: () => ratio };
}

const body = { skeleton: { min: new Vector3(-0.5, 0, -0.5), max: new Vector3(0.5, 1, 0.5) } } as unknown as BodyData;
const recipe = {} as Recipe;
const VIEW = { angle: 'threeQuarter', facing: 'right' } as const;

describe('renderView borrows the TV canvas and always gives it back (final review #4)', () => {
  test('a picture: drawn at its size, then the canvas back at its own size and pixel ratio with the stage drawn', async () => {
    disposed.mockClear();
    const t = tv();
    const img = await renderView(t.ctx, body, recipe, VIEW, 160);
    expect(img).toEqual({ base64: 'AAAA', mediaType: 'image/png' });
    expect(t.canvas).toMatchObject({ width: 1920, height: 1080 });
    expect(t.ratio()).toBe(2);
    expect(t.renders.at(-1)).toBe(t.stage);
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  test('a render that throws still puts the canvas back (never left at 160 px) and frees the creature', async () => {
    disposed.mockClear();
    const t = tv({ failOn: 'studio' });
    await expect(renderView(t.ctx, body, recipe, VIEW, 160)).rejects.toThrow('lost the GPU');
    expect(t.canvas).toMatchObject({ width: 1920, height: 1080 });
    expect(t.ratio()).toBe(2);
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  test('a compile that throws frees the creature and leaves the canvas alone', async () => {
    disposed.mockClear();
    const t = tv({ failOn: 'compile' });
    await expect(renderView(t.ctx, body, recipe, VIEW, 160)).rejects.toThrow('lost the GPU');
    expect(t.canvas).toMatchObject({ width: 1920, height: 1080 });
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
