import { Color, DataTexture, MeshToonNodeMaterial, NearestFilter, RedFormat, type Node, type Object3D } from 'three/webgpu';
import { float, mix, normalView, positionViewDirection, smoothstep, uniform, vec3 } from 'three/tsl';
import { markedColor, regionNodes } from '../skin/material';
import { untone } from './tone';
import type { RegionPack } from '../skin/patterns';

/**
 * The three hard shades of the cartoon look (× the light), from facing away to facing the light (the spike's
 * gradient, 90/170/255, rounded).
 */
export const TOON_BANDS = [0.35, 0.7, 1] as const;

/**
 * The shade for `u` = N·L × ½ + ½ (0 facing away from the light … 1 facing it): the darkest band below ⅓, the middle
 * one below ⅔, full above. The CPU twin of what the GPU reads from `toonGradient` (three's toon lighting samples it at u).
 */
export function toonBand(u: number): number {
  const i = Math.min(TOON_BANDS.length - 1, Math.max(0, Math.floor(u * TOON_BANDS.length)));
  return TOON_BANDS[i];
}

let gradient: DataTexture | null = null;
/** The bands as a 3 × 1 texture, unfiltered, so the shader steps hard between them. One for every fighter. */
export function toonGradient(): DataTexture {
  if (gradient) return gradient;
  const t = new DataTexture(new Uint8Array(TOON_BANDS.map((b) => Math.round(b * 255))), TOON_BANDS.length, 1, RedFormat);
  t.minFilter = t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return (gradient = t);
}

/** A toon material with the emissive node every lit node material reads (three r186's types leave it off the toon one). */
export type ToonMaterial = MeshToonNodeMaterial & { emissiveNode: Node | null };

/** Where the rim starts (1 − N·V: 0 facing the camera … 1 at the silhouette) and how bright it gets at the edge. */
const RIM_FROM = 0.55, RIM_STRENGTH = 0.35;
/** The rim's light: the body's own colour, half way to white. */
const RIM_WHITE = 0.5;

/**
 * A special's glow (big-fights design §3): the body's own colour, this far toward white, lit over the whole body at
 * GLOW_BODY and strongly round the silhouette (GLOW_RIM, from GLOW_RIM_FROM), × the object's glow level (0 … 1).
 */
const GLOW_WHITE = 0.55, GLOW_BODY = 0.3, GLOW_RIM = 1.4, GLOW_RIM_FROM = 0.25;
/** Where a fighter's body mesh keeps its glow level (`userData`), read by its material each time it is drawn. */
export const GLOW_KEY = 'glow';

/**
 * Sets how strongly a fighter's body glows (0 … 1, clamped). It is a uniform read per object as it is drawn, so the
 * shader is never rebuilt: every fighter's material keeps the same code (and pipeline) whatever its glow.
 */
export function setGlow(mesh: Object3D, level: number): void {
  mesh.userData[GLOW_KEY] = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

/**
 * Where a fighter's body mesh keeps its damage look (`userData`): `warm`, how far its skin is warmed (0 … WARM_MAX),
 * and `heat`, how strongly a red glow rims its silhouette (0 … 1). Not `tint`: the skin's region colours already read
 * `userData.tint` (a species' colour shift, `skin/material.ts`).
 */
export const WARM_KEY = 'damageWarm', HEAT_KEY = 'damageHeat';
/**
 * The warming is a multiply that keeps the creature's own colours (kids find their creature by its colours): at full
 * warmth the skin's green and blue are × these, red untouched, so a cyan creature stays cyan, a little warmer. It never
 * goes past WARM_MAX. The danger is carried by the red rim (`heat`), sweat, steam and spinning eyes, not by repainting.
 */
export const WARM_MUL = [1, 0.7, 0.62] as const, WARM_MAX = 0.3;
/**
 * The heat's red band round the silhouette: its colour (through the tone map's inverse); where it starts and is full
 * (1 − N·V: 0 facing the camera … 1 at the edge), so the middle of the body is never touched; how much of the band's
 * skin it paints red and how brightly it glows (× the heat).
 */
export const HEAT_COLOUR = '#ff2a14';
export const HEAT_FROM = 0.3, HEAT_TO = 0.75;
const HEAT_PAINT = 0.9, HEAT_RIM = 0.5;
const HEAT_LIGHT = untone(HEAT_COLOUR);

/**
 * Sets a fighter's damage look: the skin warmed by `warm` (0 … WARM_MAX) and a red glow round its silhouette at `heat`
 * (0 … 1), both clamped. Like the glow, read per object as it is drawn, so the shader is never rebuilt.
 */
export function setTint(mesh: Object3D, warm: number, heat: number): void {
  mesh.userData[WARM_KEY] = Number.isFinite(warm) ? Math.min(WARM_MAX, Math.max(0, warm)) : 0;
  mesh.userData[HEAT_KEY] = Number.isFinite(heat) ? Math.min(1, Math.max(0, heat)) : 0;
}

/** The CPU twin of the warming the shader does: `c` (linear) warmed by `warm` (clamped as `setTint` does), into `out`. */
export function warmSkin(c: Color, warm: number, out = new Color()): Color {
  const w = Number.isFinite(warm) ? Math.min(WARM_MAX, Math.max(0, warm)) : 0;
  return out.setRGB(c.r * (1 - w * (1 - WARM_MUL[0])), c.g * (1 - w * (1 - WARM_MUL[1])), c.b * (1 - w * (1 - WARM_MUL[2])));
}

/**
 * A fighter's cartoon skin: the region colours, patterns and face marks (the valley's `regionNodes`, unchanged), lit in
 * three hard bands (`TOON_BANDS`) by three's toon lighting, plus a soft rim of light round the silhouette. No relief
 * (bump), no cavity darkening, no fur. Equal packs give equal shader code (named uniforms), so they share a pipeline.
 */
export function createToonMaterial(pack: RegionPack): ToonMaterial {
  const r = regionNodes(pack);
  const col = markedColor(r);
  const m = new MeshToonNodeMaterial() as ToonMaterial;
  m.gradientMap = toonGradient();
  // the damage look, read per object as it is drawn (`setTint`): the skin warmed (a multiply that keeps its colours)…
  const warm = uniform(0).onObjectUpdate(({ object }) => (object?.userData[WARM_KEY] as number | undefined) ?? 0);
  const heat = uniform(0).onObjectUpdate(({ object }) => (object?.userData[HEAT_KEY] as number | undefined) ?? 0);
  const keep = vec3(1, 1, 1).sub(vec3(1 - WARM_MUL[0], 1 - WARM_MUL[1], 1 - WARM_MUL[2]).mul(warm));
  const skin = col.mul(keep);
  const edge = float(1).sub(normalView.dot(positionViewDirection).clamp(0, 1));
  // …and a red band round the silhouette only, painted and glowing (the middle of the body keeps its own colours)
  const red = vec3(HEAT_LIGHT.r, HEAT_LIGHT.g, HEAT_LIGHT.b);
  const band = smoothstep(HEAT_FROM, HEAT_TO, edge).mul(heat);
  m.colorNode = mix(skin, red, band.mul(HEAT_PAINT));
  const rim = smoothstep(RIM_FROM, 1, edge).mul(RIM_STRENGTH);
  // the glow level is read per object as it is drawn (`setGlow`), so changing it never recompiles the shader
  const glow = uniform(0).onObjectUpdate(({ object }) => (object?.userData[GLOW_KEY] as number | undefined) ?? 0);
  const glowShape = smoothstep(GLOW_RIM_FROM, 1, edge).mul(GLOW_RIM).add(GLOW_BODY);
  const glowLight = mix(col, vec3(1, 1, 1), GLOW_WHITE).mul(glowShape).mul(glow);
  m.emissiveNode = mix(skin, vec3(1, 1, 1), RIM_WHITE).mul(rim).add(glowLight).add(red.mul(band.mul(HEAT_RIM)));
  return m;
}
