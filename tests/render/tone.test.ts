import { Color } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { agx, untone } from '../../src/render/tone';

/** What the screen shows for linear colour `c`, as an sRGB 0 … 255 triple. */
function shown(c: Color): number[] {
  const out = agx([c.r, c.g, c.b]);
  const s = new Color().setRGB(out[0], out[1], out[2]).convertLinearToSRGB();
  return [s.r, s.g, s.b].map((x) => x * 255);
}

const srgb255 = (hex: string) => {
  const c = new Color(hex).convertLinearToSRGB();
  return [c.r, c.g, c.b].map((x) => x * 255);
};

describe('the TV tone mapping and its way back', () => {
  test('a plain colour drawn as it is comes out paler (why the scenery needs untone)', () => {
    const sky = new Color('#4aa8ec');
    const [r, g, b] = shown(sky), [wr, wg, wb] = srgb255('#4aa8ec');
    // the blue's lead over the red shrinks a lot
    expect(b - r).toBeLessThan((wb - wr) * 0.7);
    expect(Math.abs(g - wg) + Math.abs(b - wb)).toBeGreaterThan(10);
  });

  test('untone gives the colour that shows as the one wanted (within 2 of 255 a channel)', () => {
    for (const hex of ['#ffffff', '#2b2f6b', '#c99a6b', '#808080', '#101830', '#a8d8f0']) {
      const got = shown(untone(hex)), want = srgb255(hex);
      for (let i = 0; i < 3; i++) expect(Math.abs(got[i] - want[i]), `${hex}[${i}]`).toBeLessThanOrEqual(2);
    }
  });

  test('a colour too saturated to reach comes out nearer than drawing it plainly', () => {
    for (const hex of ['#4aa8ec', '#7ed957', '#ffd23f', '#ff8fb8']) {
      const want = srgb255(hex), err = (c: Color) => shown(c).reduce((s, x, i) => s + Math.abs(x - want[i]), 0);
      expect(err(untone(hex)), hex).toBeLessThan(err(new Color(hex)) * 0.85);
    }
  });

  test('a shade darkens what shows, and light divides the colour to draw', () => {
    const full = shown(untone('#c99a6b')), half = shown(untone('#c99a6b', 0.5));
    for (let i = 0; i < 3; i++) expect(Math.abs(half[i] - full[i] / 2)).toBeLessThan(2);
    const lit = untone('#7ed957', 1, 2), plain = untone('#7ed957');
    expect(lit.g).toBeCloseTo(plain.g / 2, 6);
  });

  test('the same question gives the same colour object', () => {
    expect(untone('#123456', 0.8)).toBe(untone('#123456', 0.8));
  });
});
