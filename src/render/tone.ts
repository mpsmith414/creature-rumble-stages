import { Color } from 'three/webgpu';

/**
 * The TV's tone mapping on the CPU, and its way back. The renderer maps every pixel through AgX (`renderer.ts`), which
 * greys and pales bright, saturated colours (a sky of #4aa8ec shows as a dull grey-blue, a white cloud as light grey),
 * and on this pipeline a material cannot opt out. So the scenery picks its colours as they should look on the screen
 * and asks `untone` for the colour to draw that comes out as that colour after the tone mapping.
 */

/** The renderer's tone mapping exposure. */
export const TONE_EXPOSURE = 0.95;

/** A 3 × 3 matrix as its three columns (as three's `mat3(c0, c1, c2)`). */
type M3 = readonly [readonly number[], readonly number[], readonly number[]];
type V3 = [number, number, number];

// three's AgX (nodes/display/ToneMappingFunctions.js), column by column
const SRGB_TO_2020: M3 = [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.088], [0.0433, 0.0113, 0.8956]];
const REC2020_TO_SRGB: M3 = [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]];
const INSET: M3 = [
  [0.856627153315983, 0.137318972929847, 0.11189821299995],
  [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
  [0.0482516061458583, 0.101439036467562, 0.811302368396859],
];
const OUTSET: M3 = [
  [1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
  [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
  [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405],
];
const MIN_EV = -12.47393, MAX_EV = 4.026069;

function mul(m: M3, v: readonly number[]): V3 {
  return [
    m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
    m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
    m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
  ];
}

/** The inverse of a column matrix. */
function inverse(m: M3): M3 {
  // rows of the plain matrix: a[r][c] = m[c][r]
  const a = (r: number, c: number) => m[c][r];
  const det = a(0, 0) * (a(1, 1) * a(2, 2) - a(1, 2) * a(2, 1)) - a(0, 1) * (a(1, 0) * a(2, 2) - a(1, 2) * a(2, 0))
    + a(0, 2) * (a(1, 0) * a(2, 1) - a(1, 1) * a(2, 0));
  const inv = (r: number, c: number) => {
    // cofactor of (c, r) over the determinant
    const rr = [0, 1, 2].filter((i) => i !== c), cc = [0, 1, 2].filter((i) => i !== r);
    const minor = a(rr[0], cc[0]) * a(rr[1], cc[1]) - a(rr[0], cc[1]) * a(rr[1], cc[0]);
    return (((r + c) % 2 ? -1 : 1) * minor) / det;
  };
  return [[inv(0, 0), inv(1, 0), inv(2, 0)], [inv(0, 1), inv(1, 1), inv(2, 1)], [inv(0, 2), inv(1, 2), inv(2, 2)]];
}

const INSET_INV = inverse(INSET), OUTSET_INV = inverse(OUTSET);
const TO_2020 = inverse(REC2020_TO_SRGB), FROM_2020 = inverse(SRGB_TO_2020);

/** AgX's contrast curve (rises over 0 … 1). */
function contrast(x: number): number {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

/** The x in 0 … 1 the contrast curve takes to `y` (by halving: the curve rises over the range). */
function uncontrast(y: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** What the screen shows (linear sRGB, 0 … 1) for linear colour `c` drawn: three's AgX at the TV's exposure. */
export function agx(c: readonly number[], exposure = TONE_EXPOSURE): V3 {
  let v = mul(SRGB_TO_2020, [c[0] * exposure, c[1] * exposure, c[2] * exposure]);
  v = mul(INSET, v);
  v = v.map((x) => Math.min(1, Math.max(0, (Math.log2(Math.max(x, 1e-10)) - MIN_EV) / (MAX_EV - MIN_EV)))) as V3;
  v = v.map(contrast) as V3;
  v = mul(OUTSET, v);
  v = v.map((x) => Math.max(0, x) ** 2.2) as V3;
  v = mul(REC2020_TO_SRGB, v);
  return v.map((x) => Math.min(1, Math.max(0, x))) as V3;
}

/** The furthest a wanted screen colour is kept from pure black and white (both lie at the tone mapping's ends). */
const EDGE = 0.004;

/** The plain way back through the tone mapping, for a target in reach (negative channels are left as they come). */
function back(want: readonly number[]): V3 {
  let v = mul(TO_2020, want.map((x) => Math.min(1 - EDGE, Math.max(EDGE, x))));
  v = v.map((x) => Math.max(0, x) ** (1 / 2.2)) as V3;
  v = mul(OUTSET_INV, v);
  v = v.map((x) => uncontrast(Math.min(contrast(1), Math.max(contrast(0), x)))) as V3;
  v = v.map((x) => 2 ** (x * (MAX_EV - MIN_EV) + MIN_EV)) as V3;
  v = mul(INSET_INV, v);
  v = mul(FROM_2020, v);
  return v.map((x) => Math.max(0, x / TONE_EXPOSURE)) as V3;
}

/** How many times an out-of-reach colour's aim is pushed further out to come nearer to it. */
const REACH_TRIES = 12;

/**
 * The linear colour to draw so the screen shows `want` (linear sRGB) after the tone mapping, for a surface lit `light`
 * times over (1 for an unlit one). A colour the tone mapping cannot reach (too saturated) comes back as near as a few
 * pushes of the aim get it. Fills `out`.
 */
export function untoneLinear(want: readonly number[], light = 1, out = new Color()): Color {
  const aim = [...want];
  let best = back(aim), bestErr = Infinity;
  for (let i = 0; i < REACH_TRIES; i++) {
    const v = back(aim), shown = agx(v);
    const err = Math.abs(shown[0] - want[0]) + Math.abs(shown[1] - want[1]) + Math.abs(shown[2] - want[2]);
    if (err < bestErr) {
      bestErr = err;
      best = v;
    }
    if (err < 1e-4) break;
    for (let k = 0; k < 3; k++) aim[k] += want[k] - shown[k];
  }
  const k = 1 / light;
  return out.setRGB(best[0] * k, best[1] * k, best[2] * k);
}

const cache = new Map<string, Color>();

/**
 * The colour to draw so the screen shows `hex` (as a designer picks it, sRGB), × `shade` (0 … 1, a darker side of
 * it), on a surface lit `light` times over (1 unlit). Remembered: the same question returns the same (shared, never
 * change it) colour.
 */
export function untone(hex: string, shade = 1, light = 1): Color {
  const key = `${hex}|${shade.toFixed(3)}|${light}`;
  let c = cache.get(key);
  if (!c) {
    const s = new Color(hex); // linear (three converts the sRGB hex)
    const want = new Color().setRGB(s.r, s.g, s.b).convertLinearToSRGB();
    want.multiplyScalar(shade).convertSRGBToLinear();
    cache.set(key, (c = untoneLinear([want.r, want.g, want.b], light)));
  }
  return c;
}
