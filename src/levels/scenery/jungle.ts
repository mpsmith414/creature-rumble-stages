import { Color, Euler, Group, Matrix4, Mesh, Object3D, Quaternion, Vector3, type Material } from 'three/webgpu';
import { untone } from '../../render/tone';
import { platformsAt, type Level, type Platform } from '../../stage/level';
import { RIVER_SPEED, type Vine } from '../../stage/mischief';
import {
  addBackdrop, at, Batch, disposer, flatMaterial, geometryOf, gradient, instanced, layoutRng, type LevelScenery, plain,
  litMaterial, MischiefClock, meshOf, platformGroup, rod, safeTime, Shapes, v3, waterMaterial, type MischiefView,
} from './kit';

/**
 * The jungle on the TV: a mossy earth bank to fight on, tree branches above it on mossy logs, a little leafy branch at
 * the top swinging on two ropes, a big friendly jungle tree behind holding them all, an overhead bough the vines hang
 * from, and a river running under everything (falling in is the splash). Behind: palms and leafy hills, far mountains,
 * a waterfall, clouds and a smiling sun. Butterflies flutter about. The mischief: the vines drop from the bough and
 * swing (a rider's hands sit on the grip), and the river floods the bank, flowing the way it sweeps everyone, pouring
 * off the bank's downstream end.
 */

/** The bank (the solid floor): how deep it is toward and away from the camera (m) and how far its front comes forward. */
const BANK_DEPTH_Z = 6, BANK_FRONT = 1.6;
/** A branch's depth (m, toward and away from the camera), its moss lip's thickness (m) and overhang (m). */
const BRANCH_DEPTH_Z = 1.6, MOSS_H = 0.12, MOSS_OUT = 0.06;
/** The river under the level: its surface height (m) and how fast it runs along (m/s). */
export const RIVER_Y = -7.2;
const RIVER_FLOW = 1.1;
/**
 * A vine leans back toward its top by this share of its length (z), so its grip swings on the play plane while the rope
 * above passes behind the crown branch where the two cross (about x ±5.5 at the branch's top, 10.5 m: the branch
 * reaches back to z −0.86; the rope there, leaves and all, stays behind it even seen from above).
 */
const VINE_LEAN = 0.6;
/** The overhead bough the vines hang from: its radius (m; its underside is the vines' top). */
const BOUGH_R = 0.45;
/** The crown branch's ropes: how far back (z) they leave the branch (sloping back up to the bough) and how far in from its ends (m). */
const ROPE_Z = -0.9, ROPE_IN = 0.45;
/** The vines drop in over this long and roll back up over this long (s). */
const VINE_DROP = 0.35, VINE_ROLL = 0.5;
/** The flood rises over this long and drains over this long (s); how high its water stands on the bank (m). */
const FLOOD_RISE = 0.6, FLOOD_DRAIN = 0.8, FLOOD_H = 0.08;
/** Butterflies: how many, how fast they flap (rad/s). */
const BUTTERFLIES = 7, FLAP = 15;

const C = {
  skyLow: '#c9f4e6', skyMid: '#a6e4f6', skyHigh: '#5cc0ef', skyTop: '#3ea8e6',
  sun: '#ffe45c', sunHalo: '#fff0a0', sunFace: '#9a6a2c', cheek: '#ffb0a0', cloud: '#ffffff',
  mountain: '#b3dccd', hillFar: '#96d3a8', hillNear: '#77c48e',
  trunk: '#a8764c', trunkDark: '#8c603c', bark: '#8a5a3c', barkDark: '#6b4329', woodEnd: '#e9c492',
  leafDark: '#2f9a55', leaf: '#47b562', leafLight: '#7bd65c', leafPale: '#9fe28a',
  grass: '#6fd04f', grassDark: '#55b83f', dirt: '#b47c48', dirtDark: '#94633a', stone: '#d2cabb', root: '#8a5d3a',
  moss: '#7fd552', petalPink: '#ff78ad', petalYellow: '#ffd23f', petalOrange: '#ff9a3c', petalLilac: '#b98cff',
  mushroom: '#ff5f5f', spot: '#ffffff', stem: '#4fa04a',
  rock: '#a9b4b0', cliff: '#9cb3a6', fall: '#e4f9ff', fallDark: '#a8e4f7',
  river: '#2fa6d8', riverLight: '#5cc9ec', foam: '#f2fdff', lily: '#5cc46a',
  vine: '#3f9a2c', vineLeaf: '#8fe85a', vineLoop: '#ffd23f', liana: '#7cb87a',
};

const FLOWERS = [C.petalPink, C.petalYellow, C.petalOrange, C.petalLilac];

export function jungleScenery(level: Level): LevelScenery {
  const root = new Group();
  root.name = 'scenery:jungle';
  const mats: Material[] = [];
  const keep = <M extends Material>(m: M) => (mats.push(m), m);
  const lit = keep(litMaterial()), flat = keep(flatMaterial());
  const cam = level.camera, rng = layoutRng(11);
  const s = new Shapes();

  // ---- the platforms ----
  const groups = new Map<string, Group>();
  for (const p of level.platforms) {
    const g = platformGroup(p.id, lit, (b, sh) => (p.kind === 'solid' ? bank(b, sh, p, rng) : branch(b, sh, p, rng)));
    groups.set(p.id, g);
    root.add(g);
  }

  // ---- everything that stands still: sky, sun, hills, trees, the bough, the flowers ----
  const back = new Batch('flat');
  backdrop(back, s, cam, rng);
  trees(back, s, level, rng);
  bankTop(back, s, level.platforms.find((p) => p.kind === 'solid')!, rng);
  riverBanks(back, s, rng);
  root.add(meshOf(back, flat, 'scenery:back'));

  // ---- the river under everything, always running ----
  const river = waterMaterial(C.river, C.riverLight, C.foam, 'x', 2.6);
  keep(river.material);
  const riverGeo = new Batch('flat').add(s.box, at(0, RIVER_Y - 0.1, -16, 200, 0.2, 52), '#ffffff').build();
  const riverMesh = new Mesh(riverGeo, river.material);
  riverMesh.name = 'scenery:river';
  root.add(riverMesh);

  // ---- the crown branch's ropes, moving with it ----
  const crown = level.platforms.find((p) => p.path);
  const ropes = new Mesh(geometryOf('flat', (b, sh) => {
    if (!crown) return;
    const top = boughY(level) - crown.y, bz = boughZ(level);
    for (const side of [-1, 1]) {
      const x = side * (crown.w / 2 - ROPE_IN);
      rod(b, sh, v3(x, -0.05, ROPE_Z), v3(x, top, bz), 0.05, C.vine);
      for (let y = 0.6; y < top; y += 0.9) {
        const z = ROPE_Z + (bz - ROPE_Z) * ((y + 0.05) / (top + 0.05));
        b.add(sh.lowBall, at(x + side * 0.12, y, z, 0.2, 0.09, 0.05, 0, 0, side * 0.6), C.vineLeaf);
      }
    }
  }), flat);
  ropes.name = 'scenery:crown-ropes';
  ropes.visible = !!crown;
  root.add(ropes);

  // ---- the vines (mischief): hung from the bough, dropped in and swinging ----
  const vines = vinesOf(level);
  const vineLen = Math.max(1, ...vines.map((v) => v.length));
  const vineGroup = new Group();
  vineGroup.name = 'play:vines';
  vineGroup.visible = false;
  const vineMesh = instanced(geometryOf('flat', (b, sh) => vineShape(b, sh, vineLen)), flat, Math.max(1, vines.length), 'play:vine');
  vineGroup.add(vineMesh);
  const tips = vines.map((_, i) => {
    const o = new Object3D();
    o.name = `play:vine-tip:${i}`;
    vineGroup.add(o);
    return o;
  });
  root.add(vineGroup);

  // ---- the flood (mischief): water over the bank, running along, pouring off the downstream end ----
  const ground = level.platforms.find((p) => p.kind === 'solid')!;
  const floodTop = waterMaterial(C.river, C.riverLight, C.foam, 'x', 1.8);
  const floodFall = waterMaterial(C.riverLight, C.fall, C.foam, 'y', 1.4);
  keep(floodTop.material);
  keep(floodFall.material);
  const flood = new Group();
  flood.name = 'play:flood';
  flood.visible = false;
  const zMid = BANK_FRONT - BANK_DEPTH_Z / 2;
  const topGeo = new Batch('flat')
    .add(s.box, at(ground.x, ground.y + FLOOD_H / 2 - 0.02, zMid, ground.w + 0.2, FLOOD_H + 0.04, BANK_DEPTH_Z + 0.2), '#ffffff')
    // spilling over the front edge
    .add(s.box, at(ground.x, ground.y - 0.55, BANK_FRONT + 0.16, ground.w + 0.2, 1.2, 0.04), '#ffffff')
    .build();
  flood.add(new Mesh(topGeo, floodTop.material));
  // the fall off the right end (mirrored to the left when the river runs that way)
  const fall = new Group();
  const fallH = ground.y - RIVER_Y;
  fall.add(new Mesh(new Batch('flat')
    .add(s.box, at(ground.x + ground.w / 2 + 0.25, ground.y - fallH / 2, zMid, 0.3, fallH + 0.1, BANK_DEPTH_Z), '#ffffff')
    .build(), floodFall.material));
  // foam where it lands
  fall.add(new Mesh(geometryOf('flat', (b, sh) => {
    for (let i = 0; i < 6; i++) b.add(sh.lowBall, at(ground.x + ground.w / 2 + 0.4 + i * 0.25, RIVER_Y + 0.1, zMid - 2.4 + i * 0.95, 0.9, 0.35, 0.7), C.foam);
  }), flat));
  flood.add(fall);
  root.add(flood);

  // ---- butterflies, fluttering behind the play ----
  const fly = instanced(geometryOf('flat', (b, sh) => {
    const white = (_p: Vector3, _n: Vector3, out: Color) => out.setRGB(1, 1, 1);
    const dim = (_p: Vector3, _n: Vector3, out: Color) => out.setRGB(0.35, 0.3, 0.3);
    for (const side of [-1, 1]) {
      b.add(sh.lowBall, at(side * 0.2, 0.06, 0, 0.2, 0.16, 0.02), white);
      b.add(sh.lowBall, at(side * 0.15, -0.1, 0, 0.13, 0.1, 0.02), white);
    }
    b.add(sh.lowBall, at(0, 0, 0, 0.04, 0.17, 0.04), dim);
  }), flat, BUTTERFLIES, 'scenery:butterflies');
  const flyAt: Vector3[] = [];
  for (let i = 0; i < BUTTERFLIES; i++) {
    flyAt.push(v3(cam.left + 3 + (i + rng() * 0.6) * ((cam.right - cam.left - 6) / BUTTERFLIES), 2 + rng() * 11, -2.6 - rng() * 3.5));
    fly.setColorAt(i, untone(FLOWERS[i % FLOWERS.length]));
  }
  root.add(fly);

  s.dispose();

  // ---- moving it all ----
  const clock = new MischiefClock();
  const now: Platform[] = [];
  const m4 = new Matrix4(), q = new Quaternion(), e = new Euler(0, 0, 0, 'ZYX'), pos = new Vector3(), size = new Vector3();
  const tilt = Math.atan2(-vinePivotZ(vineLen), vineLen); // leaning back at the top, so the grip is on the play plane
  let floodSide: 1 | -1 = 1;

  const update = (time: number, cues: Parameters<LevelScenery['update']>[1], live?: MischiefView) => {
    const t = safeTime(time);
    clock.take(t, cues, live);
    platformsAt(level, t, now);
    for (const p of now) {
      groups.get(p.id)?.position.set(p.x, p.y, 0);
      if (crown && p.id === crown.id) ropes.position.set(p.x, p.y, 0);
    }

    river.flow.value = RIVER_FLOW * t;

    // vines: dropped down from the bough (scaled along their length), swinging as the fight has them
    const drop = clock.level('vines', t, VINE_DROP, VINE_ROLL);
    vineGroup.visible = drop > 0.01 || clock.on('vines', t);
    for (let i = 0; i < vines.length; i++) {
      const v = vines[i], a = v.swing * Math.sin((2 * Math.PI * t) / v.period + v.phase), k = Math.max(drop, 1e-3);
      const len = (v.length / vineLen) * k;
      e.set(-tilt, 0, a);
      m4.compose(pos.set(v.x, v.y, vinePivotZ(v.length)), q.setFromEuler(e), size.set(1, len / Math.cos(tilt), 1));
      vineMesh.setMatrixAt(i, m4);
      tips[i].position.set(v.x + v.length * k * Math.sin(a), v.y - v.length * k * Math.cos(a), vinePivotZ(v.length) * (1 - k));
    }
    vineMesh.instanceMatrix.needsUpdate = true;

    // flood: rises over the bank and runs the way the river sweeps everyone
    const water = clock.level('river', t, FLOOD_RISE, FLOOD_DRAIN);
    if (live?.active === 'river') floodSide = live.side;
    flood.visible = water > 0.01 || clock.on('river', t);
    flood.scale.set(1, Math.max(water, 1e-3), 1);
    fall.scale.set(floodSide, 1, 1);
    const since = clock.since('river');
    floodTop.flow.value = Number.isFinite(since) ? floodSide * RIVER_SPEED * (t - since) : 0;
    floodFall.flow.value = 3 * t;

    for (let i = 0; i < BUTTERFLIES; i++) {
      const c = flyAt[i], ph = i * 1.7;
      const flap = 0.25 + 0.75 * Math.abs(Math.sin(FLAP * t + ph));
      const x = c.x + 2.4 * Math.sin(0.45 * t + ph), y = c.y + 0.8 * Math.sin(0.9 * t + 2 * ph);
      const dir = Math.cos(0.45 * t + ph) >= 0 ? 1 : -1;
      m4.compose(pos.set(x, y, c.z), q.setFromEuler(e.set(0, dir > 0 ? 0.5 : -0.5, 0.15 * Math.sin(3 * t + ph))),
        size.set(flap * 1.3, 1.3, 1.3));
      fly.setMatrixAt(i, m4);
    }
    fly.instanceMatrix.needsUpdate = true;
  };
  update(0, []);

  return {
    root,
    update,
    state: () => ({ airlock: { left: 0, right: 0 }, tint: 0 }),
    dispose: disposer(root, mats),
  };
}

/** How far back (z) a vine of `length` hangs from: its top leans back so its grip swings on the play plane. */
const vinePivotZ = (length: number) => -VINE_LEAN * length;

/** The level's vines (none without the vines mischief). */
function vinesOf(level: Level): Vine[] {
  const v = level.mischief.find((m) => m.name === 'vines');
  return v?.name === 'vines' ? v.vines : [];
}

/** The bough's centre height: just over the vines' tops (or 15 m with no vines). */
function boughY(level: Level): number {
  const vs = vinesOf(level);
  return (vs.length ? Math.max(...vs.map((x) => x.y)) : 15) + BOUGH_R;
}

/** How far back (z) the bough runs: where the vines' tops hang from. */
function boughZ(level: Level): number {
  const vs = vinesOf(level);
  return vs.length ? vinePivotZ(Math.max(...vs.map((x) => x.length))) : -2;
}

/** The bank: a mossy earth block, grass on top with a fringe over the front, strata and stones, roots hanging below. */
function bank(b: Batch, s: Shapes, p: Platform, rng: () => number): void {
  const z = BANK_FRONT - BANK_DEPTH_Z / 2;
  b.add(s.box, at(0, -0.15, z, p.w + 0.16, 0.3, BANK_DEPTH_Z + 0.16), C.grass);
  b.add(s.box, at(0, -0.3 - (p.h - 0.3) / 2, z, p.w, p.h - 0.3, BANK_DEPTH_Z), C.dirt);
  // a soft, scalloped grass edge hanging over the front
  for (let x = -p.w / 2 + 0.2; x < p.w / 2 - 0.1; x += 0.38) {
    b.add(s.lowBall, at(x, -0.3, BANK_FRONT + 0.06, 0.24, 0.16 + rng() * 0.08, 0.06), rng() < 0.5 ? C.grass : C.grassDark);
  }
  // wavy strata and stones on the front face
  for (const [y, k] of [[-1.3, 0.9], [-2.5, 0.7]] as const) {
    for (let x = -p.w / 2 + 0.5; x < p.w / 2 - 0.4; x += 0.9) {
      b.add(s.box, at(x, y + 0.14 * Math.sin(x * k), BANK_FRONT + 0.02, 0.95, 0.2, 0.04, 0, 0, 0.12 * Math.cos(x * k)), C.dirtDark);
    }
  }
  for (let i = 0; i < 14; i++) {
    const x = -p.w / 2 + 0.8 + rng() * (p.w - 1.6), y = -0.9 - rng() * (p.h - 1.4);
    b.add(s.lowBall, at(x, y, BANK_FRONT + 0.02, 0.22 + rng() * 0.2, 0.16 + rng() * 0.1, 0.08), C.stone);
  }
  // roots hanging under it toward the river
  for (let i = 0; i < 9; i++) {
    const x = -p.w / 2 + 1 + (i / 8) * (p.w - 2) + (rng() - 0.5);
    b.add(s.cone, at(x, -p.h - 1.1, z + (rng() - 0.5) * 3, 0.35, 2.2 + rng() * 1.6, 0.35, Math.PI, 0, (rng() - 0.5) * 0.3), C.root);
  }
}

/** A branch: a bark log with a mossy top, ridges, cut ends, leaves hanging under it (and a few flowers). */
function branch(b: Batch, s: Shapes, p: Platform, rng: () => number): void {
  const body = p.h - MOSS_H;
  b.add(s.box, at(0, -MOSS_H / 2, 0, p.w + 2 * MOSS_OUT, MOSS_H, BRANCH_DEPTH_Z + 2 * MOSS_OUT), C.moss);
  b.add(s.box, at(0, -MOSS_H - body / 2, 0, p.w, body, BRANCH_DEPTH_Z), C.bark);
  for (const y of [-0.2, -0.31]) b.add(s.box, at(0, y, BRANCH_DEPTH_Z / 2 + 0.01, p.w - 0.3, 0.04, 0.03), C.barkDark);
  for (const side of [-1, 1]) {
    b.add(s.cyl, at(side * (p.w / 2 - 0.02), -MOSS_H - body / 2, 0, 0.13, 0.03, 0.6, 0, 0, Math.PI / 2), C.woodEnd);
  }
  // leaves hanging under the log
  for (let x = -p.w / 2 + 0.35; x < p.w / 2 - 0.2; x += 0.5 + rng() * 0.3) {
    const g = [C.leaf, C.leafLight, C.leafDark][Math.floor(rng() * 3)];
    b.add(s.lowBall, at(x, -p.h - 0.12, (rng() - 0.5) * 1.1, 0.28, 0.14, 0.24, 0, rng() * 3, 0), g);
    if (rng() < 0.35) b.add(s.cone, at(x + 0.1, -p.h - 0.45, 0.4, 0.12, 0.5, 0.05, Math.PI, 0, 0), C.leafLight);
  }
  if (p.path) {
    // the crown: flowers on its front
    for (const x of [-p.w / 4, p.w / 5]) {
      b.add(s.lowBall, at(x, -0.24, BRANCH_DEPTH_Z / 2 + 0.05, 0.17, 0.17, 0.05), C.petalPink);
      b.add(s.lowBall, at(x, -0.24, BRANCH_DEPTH_Z / 2 + 0.09, 0.07, 0.07, 0.03), C.petalYellow);
    }
  }
}

/** The vine as it hangs, `len` long down from its top (y 0 … −len): a rope with leaves and a loop to hold at the end. */
function vineShape(b: Batch, s: Shapes, len: number): void {
  b.add(s.cyl, at(0, -len / 2, 0, 0.11, len, 0.11), C.vine);
  let side = 1;
  for (let y = -0.45; y > -len + 0.5; y -= 0.42) {
    b.add(s.lowBall, at(side * 0.22, y, 0.02, 0.3, 0.13, 0.06, 0, 0, side * 0.5), C.vineLeaf);
    side = -side;
  }
  b.add(s.torus, at(0, -len + 0.2, 0, 0.22, 0.22, 0.3, 0, Math.PI / 2, 0), C.vineLoop);
}

/** Sky, sun, clouds, mountains, a waterfall and leafy hills, far behind. */
function backdrop(b: Batch, s: Shapes, cam: Level['camera'], rng: () => number): void {
  const cx = (cam.left + cam.right) / 2, cy = (cam.bottom + cam.top) / 2;
  addBackdrop(b, -62, cx, cy, gradient([[-25, C.skyLow], [2, C.skyMid], [28, C.skyHigh], [60, C.skyTop]]));
  // a friendly sun: rays, a round face, smiling
  const sx = cx - 26, sy = cy + 17, sz = -58, R = 4;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    b.add(s.cone, at(sx + Math.cos(a) * (R + 1.1), sy + Math.sin(a) * (R + 1.1), sz - 0.3, 0.7, 1.8, 0.1, 0, 0, a - Math.PI / 2), plain(C.sunHalo));
  }
  b.add(s.cyl, at(sx, sy, sz, R, 0.2, R, Math.PI / 2, 0, 0), plain(C.sun));
  for (const ex of [-1.3, 1.3]) b.add(s.lowBall, at(sx + ex, sy + 0.7, sz + 0.2, 0.35, 0.5, 0.1), plain(C.sunFace));
  for (const ex of [-2.3, 2.3]) b.add(s.lowBall, at(sx + ex, sy - 0.5, sz + 0.2, 0.6, 0.4, 0.1), plain(C.cheek));
  for (let k = 0; k <= 6; k++) {
    const a = Math.PI * (1.2 + (k / 6) * 0.6);
    b.add(s.lowBall, at(sx + Math.cos(a) * 1.6, sy - 0.1 + Math.sin(a) * 1.6, sz + 0.2, 0.2, 0.2, 0.1), plain(C.sunFace));
  }
  // clouds
  for (let i = 0; i < 9; i++) {
    const x = cx - 80 + i * 20 + rng() * 8, y = cy + 14 + rng() * 14, z = -52 - rng() * 4;
    for (let k = 0; k < 5; k++) {
      const r = 1.6 + rng() * 1.6;
      b.add(s.lowBall, at(x + (k - 2) * 1.9, y + Math.sin(k * 1.3) * 0.8 + (k === 2 ? 0.8 : 0), z, r * 1.3, r, r * 0.6), C.cloud);
    }
  }
  // far mountains, then leafy hills
  for (let i = 0; i < 9; i++) {
    const w = 18 + rng() * 10;
    b.add(s.cone, at(cx - 96 + i * 24 + rng() * 6, -12 + 9, -54, w, 18 + rng() * 8, 6), C.mountain);
  }
  for (let i = 0; i < 16; i++) {
    b.add(s.lowBall, at(cx - 100 + i * 13 + rng() * 5, -9 + rng() * 3, -44 - rng() * 3, 9 + rng() * 4, 7 + rng() * 3, 4), C.hillFar);
  }
  // a waterfall off a cliff, far to the right
  const fx = cx + 36, fz = -40;
  b.add(s.box, at(fx, 1, fz, 14, 26, 6), C.cliff);
  b.add(s.box, at(fx - 2, 14.3, fz, 15, 1, 7), C.leaf);
  for (let k = 0; k < 7; k++) b.add(s.box, at(fx - 3.3 + k * 0.55, 0.5, fz + 3.05, 0.55, 26, 0.1), k % 2 ? C.fall : C.fallDark);
  for (let k = 0; k < 6; k++) b.add(s.lowBall, at(fx - 3.5 + k * 1.3, -12, fz + 3.3, 1.2, 0.8, 0.8), C.foam);
  // near hills and palms at the far edges of the view
  for (let i = 0; i < 14; i++) {
    b.add(s.lowBall, at(cx - 70 + i * 11 + rng() * 4, -6 + rng() * 2, -30 - rng() * 4, 7 + rng() * 3, 5 + rng() * 3, 3), C.hillNear);
  }
  for (let i = 0; i < 10; i++) {
    const x = cx - 52 + i * 11.5 + rng() * 4, z = -24 - rng() * 6;
    palm(b, s, x, -8, z, 14 + rng() * 6, rng);
  }
}

/** A palm tree from (x, y, z) up `h`. */
function palm(b: Batch, s: Shapes, x: number, y: number, z: number, h: number, rng: () => number): void {
  const lean = (rng() - 0.5) * 0.25;
  rod(b, s, v3(x, y, z), v3(x + lean * h, y + h, z), 0.5, C.trunk);
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    b.add(s.lowBall, at(x + lean * h + Math.cos(a) * 2.2, y + h - 0.3 - Math.abs(Math.sin(a)) * 0.4, z + Math.sin(a) * 1.2,
      2.6, 0.45, 0.9, 0, -a, Math.cos(a) * -0.35), k % 2 ? C.leaf : C.leafLight);
  }
}

/**
 * The big jungle tree behind the middle and the trees at the sides, holding the branches (each branch has a limb back
 * to a trunk), the overhead bough between the side trees (the vines hang from it), its leaves, and hanging lianas.
 */
function trees(b: Batch, s: Shapes, level: Level, rng: () => number): void {
  const cam = level.camera, by = boughY(level), bz = boughZ(level);
  // the big tree behind the middle
  const tz = -9, tr = 2;
  b.add(s.cyl, at(0, 6, tz, tr, 36, tr), C.trunk);
  for (let k = 0; k < 5; k++) b.add(s.box, at(-1.4 + k * 0.7, 6, tz + tr - 0.12, 0.12, 34, 0.3), C.trunkDark);
  canopy(b, s, 0, by + 5, tz - 1, 18, rng);
  // limbs from each static branch back to the nearest trunk
  for (const p of level.platforms) {
    if (p.kind !== 'thin' || p.path) continue;
    const inner = Math.abs(p.x) < 1 ? 0 : p.x - Math.sign(p.x) * (p.w / 2 - 0.8);
    rod(b, s, v3(inner, p.y - 0.25, -0.9), v3(inner * 0.25, p.y + 1.2, tz + 0.5), 0.32, C.bark);
    b.add(s.lowBall, at(inner * 0.6, p.y + 0.7, -3.5, 1.1, 0.7, 0.8), C.leaf);
  }
  // the side trees at the edges of the camera bounds and the bough between them
  for (const side of [-1, 1]) {
    const x = side * (cam.right + 4);
    b.add(s.cyl, at(x, 6, -3.5, 1.5, 36, 1.5), C.trunk);
    canopy(b, s, x, by + 4, -7, 9, rng);
    b.add(s.cyl, at(side * (cam.right + 13), 4, -14, 1.3, 30, 1.3), C.trunkDark);
    canopy(b, s, side * (cam.right + 13), by + 2, -14, 8, rng);
    // lianas hanging at the sides, well behind the play
    for (let k = 0; k < 2; k++) {
      const lx = side * (cam.right - 1.5 - k * 3.4), len = 4 + rng() * 4, z = -4 - k * 1.5;
      rod(b, s, v3(lx, by, z), v3(lx + side * 0.3, by - len, z), 0.05, C.liana);
      for (let y = by - 0.8; y > by - len; y -= 0.8) b.add(s.lowBall, at(lx + 0.15, y, z, 0.18, 0.08, 0.05, 0, 0, 0.5), C.leafPale);
    }
  }
  rod(b, s, v3(-(cam.right + 4), by, bz), v3(cam.right + 4, by, bz), BOUGH_R, C.bark);
  for (let x = cam.left - 2; x <= cam.right + 2; x += 1.6 + rng()) {
    b.add(s.lowBall, at(x, by + 0.45 + rng() * 0.4, bz - 0.6 - rng(), 1 + rng() * 0.6, 0.6, 0.7), rng() < 0.5 ? C.leaf : C.leafLight);
  }
  // knots on the bough where the vines are tied
  for (const vine of vinesOf(level)) b.add(s.lowBall, at(vine.x, by - 0.15, bz + 0.25, 0.42, 0.42, 0.42), C.vine);
}

/** A leafy crown of `n` balls round (x, y, z). */
function canopy(b: Batch, s: Shapes, x: number, y: number, z: number, n: number, rng: () => number): void {
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2, r = 3 + rng() * 3;
    b.add(s.ball, at(x + Math.cos(a) * (n * 0.55) * rng(), y + Math.sin(a) * 2.5 + rng() * 2, z - rng() * 3, r * 1.2, r * 0.8, r),
      [C.leafDark, C.leaf, C.leafLight][k % 3]);
  }
}

/** Flowers, ferns and mushrooms on the back of the bank's top, behind where the creatures stand. */
function bankTop(b: Batch, s: Shapes, p: Platform, rng: () => number): void {
  const zBack = BANK_FRONT - BANK_DEPTH_Z;
  for (let x = p.x - p.w / 2 + 0.6; x < p.x + p.w / 2 - 0.4; x += 0.7 + rng() * 0.6) {
    const z = zBack + 0.6 + rng() * 1.6, h = 0.35 + rng() * 0.5;
    if (rng() < 0.55) {
      b.add(s.cyl, at(x, p.y + h / 2, z, 0.03, h, 0.03), C.stem);
      b.add(s.lowBall, at(x, p.y + h, z, 0.2, 0.2, 0.08), FLOWERS[Math.floor(rng() * FLOWERS.length)]);
      b.add(s.lowBall, at(x, p.y + h, z + 0.06, 0.08, 0.08, 0.04), C.petalYellow);
    } else {
      for (let k = -1; k <= 1; k++) b.add(s.cone, at(x + k * 0.12, p.y + 0.3, z, 0.12, 0.7, 0.06, 0, 0, k * 0.45), C.leafLight);
    }
  }
  for (const side of [-1, 1]) {
    const x = p.x + side * (p.w / 2 - 0.8), z = zBack + 1.2;
    b.add(s.cyl, at(x, p.y + 0.25, z, 0.15, 0.5, 0.15), C.spot);
    b.add(s.ball, at(x, p.y + 0.55, z, 0.45, 0.3, 0.45), C.mushroom);
    for (const dx of [-0.2, 0.15]) b.add(s.lowBall, at(x + dx, p.y + 0.68, z + 0.3, 0.07, 0.07, 0.05), C.spot);
  }
}

/** Rocks and lily pads in the river, and the far bank. */
function riverBanks(b: Batch, s: Shapes, rng: () => number): void {
  b.add(s.box, at(0, RIVER_Y + 0.6, -44, 240, 2.4, 4), C.leafLight);
  for (const [x, z] of [[-15, -6], [16, -8], [-25, -14], [27, -12], [-8, -20], [9, -24], [33, -4], [-34, -5]] as const) {
    b.add(s.ball, at(x, RIVER_Y, z, 1.2 + rng() * 0.8, 0.7, 1.1), C.rock);
  }
  for (let i = 0; i < 12; i++) {
    const x = -40 + i * 7 + rng() * 3, z = -3 - rng() * 18;
    b.add(s.cyl, at(x, RIVER_Y + 0.03, z, 0.9, 0.05, 0.9), C.lily);
    if (i % 3 === 0) b.add(s.lowBall, at(x + 0.2, RIVER_Y + 0.25, z, 0.25, 0.2, 0.25), C.petalPink);
  }
}
