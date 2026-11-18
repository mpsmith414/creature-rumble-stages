import { describe, expect, it, test } from 'vitest';
import { packRegions } from '../../src/skin/patterns';
import { Color, Mesh } from 'three/webgpu';
import {
  createToonMaterial, GLOW_KEY, HEAT_FROM, HEAT_KEY, setGlow, setTint, TOON_BANDS, toonBand, toonGradient, WARM_KEY, WARM_MAX, warmSkin,
} from '../../src/render/toon';
import { loadFixture } from '../fixtures/fighters';

describe('toonBand', () => {
  test('toon bands are hard steps', () => {
    expect(toonBand(0.2)).toBe(0.35);
    expect(toonBand(0.5)).toBe(0.7);
    expect(toonBand(0.9)).toBe(1);
  });

  it('covers the whole range with exactly three shades, darkest facing away', () => {
    expect(TOON_BANDS).toEqual([0.35, 0.7, 1]);
    expect(toonBand(0)).toBe(0.35);
    expect(toonBand(1)).toBe(1);
    expect(toonBand(-0.5)).toBe(0.35);
    expect(toonBand(1.5)).toBe(1);
    const seen = new Set<number>();
    for (let u = 0; u <= 1; u += 0.01) seen.add(toonBand(u));
    expect([...seen]).toEqual([0.35, 0.7, 1]);
  });
});

describe('the toon gradient the shader reads', () => {
  it('is the same three shades, one texel each, unfiltered (so the GPU steps exactly as toonBand)', () => {
    const t = toonGradient();
    expect(t.image.width).toBe(3);
    expect([...(t.image.data as Uint8Array)]).toEqual([89, 179, 255]); // 0.35, 0.7, 1
    expect(t.minFilter).toBe(t.magFilter);
    expect(t.magFilter).toBe(1003); // NearestFilter
    expect(toonGradient()).toBe(t); // one for every fighter
  });
});

describe('createToonMaterial', () => {
  const r = loadFixture('fists');
  const pack = packRegions(r, r.skin.regions.map((x) => x.id));

  it('paints the region colours, lit in hard bands, with a rim and no relief', () => {
    const m = createToonMaterial(pack);
    expect((m as unknown as { isMeshToonNodeMaterial?: boolean }).isMeshToonNodeMaterial).toBe(true);
    expect(m.gradientMap).toBe(toonGradient());
    expect(m.colorNode).not.toBeNull();
    expect(m.emissiveNode).not.toBeNull(); // the rim
    expect(m.normalNode).toBeNull(); // no bump relief
    expect(m.aoNode).toBeNull(); // no cavity darkening
  });
});

describe("a special's glow", () => {
  it('is a level kept on the object, clamped to 0 … 1, so the material never changes', () => {
    const r = loadFixture('fists');
    const m = createToonMaterial(packRegions(r, r.skin.regions.map((x) => x.id)));
    const mesh = new Mesh(undefined, m);
    const before = m.emissiveNode;
    const version = m.version;
    setGlow(mesh, 0.6);
    expect(mesh.userData[GLOW_KEY]).toBe(0.6);
    setGlow(mesh, 3);
    expect(mesh.userData[GLOW_KEY]).toBe(1);
    setGlow(mesh, -1);
    expect(mesh.userData[GLOW_KEY]).toBe(0);
    setGlow(mesh, Number.NaN);
    expect(mesh.userData[GLOW_KEY]).toBe(0);
    expect(m.emissiveNode).toBe(before);
    expect(m.version).toBe(version); // no recompile
  });
});


/** A colour's hue (0 … 1) and how far two hues are apart round the wheel (0 … 0.5). */
const hueOf = (c: Color) => c.getHSL({ h: 0, s: 0, l: 0 }).h;
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));

describe('the damage look on the skin', () => {
  it('is kept on the object (clamped), never in the skin\'s own `tint` (its species colour shift), and never recompiles', () => {
    const r = loadFixture('fists');
    const m = createToonMaterial(packRegions(r, r.skin.regions.map((x) => x.id)));
    const mesh = new Mesh(undefined, m);
    const version = m.version;
    setTint(mesh, 0.2, 0.5);
    expect(mesh.userData[WARM_KEY]).toBe(0.2);
    expect(mesh.userData[HEAT_KEY]).toBe(0.5);
    setTint(mesh, 2, 3);
    expect(mesh.userData[WARM_KEY]).toBe(WARM_MAX);
    expect(mesh.userData[HEAT_KEY]).toBe(1);
    setTint(mesh, Number.NaN, -1);
    expect(mesh.userData[WARM_KEY]).toBe(0);
    expect(mesh.userData[HEAT_KEY]).toBe(0);
    expect(mesh.userData.tint).toBeUndefined(); // a number there turned every body black
    expect([WARM_KEY, HEAT_KEY]).not.toContain('tint');
    expect(m.version).toBe(version);
  });

  it('keeps the creature\'s own colours: even fully warmed, cyan stays cyan, green green, pink pink (kids find theirs by colour)', () => {
    expect(WARM_MAX).toBeLessThanOrEqual(0.3);
    // the red band of the heat stays at the silhouette: the body's middle (facing the camera within ~45°) is never painted
    expect(HEAT_FROM).toBeGreaterThanOrEqual(1 - Math.cos(Math.PI / 4));
    for (const hex of ['#3ec7e0', '#3fbf5f', '#ff7eb6', '#4da6ff', '#f28c28', '#8e5bd6']) {
      const c = new Color(hex), w = warmSkin(c, WARM_MAX);
      expect(hueGap(hueOf(c), hueOf(w)), hex).toBeLessThan(12 / 360);
      // no channel moves by more than a third of itself: the same colour, a little warmer
      for (const k of ['r', 'g', 'b'] as const) expect(Math.abs(w[k] - c[k]), `${hex} ${k}`).toBeLessThanOrEqual(c[k] / 3 + 1e-9);
      expect(w.r).toBeCloseTo(c.r, 9); // warmer: red is untouched, green and blue a little less
    }
    expect(warmSkin(new Color('#3ec7e0'), 5).equals(warmSkin(new Color('#3ec7e0'), WARM_MAX))).toBe(true);
  });
});
