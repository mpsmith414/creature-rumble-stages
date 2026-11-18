import {
  Color, CylinderGeometry, Euler, Group, Matrix4, Quaternion, Vector3, type InstancedMesh, type Material,
} from 'three/webgpu';
import { untone } from '../../render/tone';
import { platformsAt, type Level, type Platform } from '../../stage/level';
import {
  addBackdrop, at, Batch, disposer, flatMaterial, geometryOf, gradient, instanced, layoutRng, type LevelScenery,
  litMaterial, MischiefClock, meshOf, plain, platformGroup, rod, safeTime, Shapes, v3, type MischiefView,
} from './kit';

/**
 * Our own space ship on the TV: a bright hangar deck to fight on, catwalks and the bridge walkway above it in white
 * and orange, teal lifts riding up and down their rails at each end, a big window wall at the back looking out on
 * stars, planets and soft nebulas, a ceiling of lamps, and a round airlock hatch in the bulkhead at each side. Little
 * lights blink on the consoles and the deck's thrusters glow underneath. The mischief: the airlock's hatch opens on
 * the side it pulls toward (its lamp flashes, a swirl shows through, streaks rush toward it), and low gravity fills
 * the hangar with floating sparkles and a lilac tint.
 */

/** The deck (the solid floor): its depth toward and away from the camera (m), how far its front comes forward. */
const DECK_DEPTH_Z = 6, DECK_FRONT = 1.6;
/** A catwalk's (and lift's) depth toward and away from the camera (m) and its top's thickness (m). */
const WALK_DEPTH_Z = 2, WALK_TOP = 0.1;
/** The window wall's depth (z), the bulkheads' inner face (x, each side), thickness (m) and front edge (z). */
const WALL_Z = -14, BULKHEAD_X = 19, BULKHEAD_T = 0.6, BULKHEAD_FRONT = -1.5;
/** The airlock hatch in each bulkhead: its centre's height and depth (m) and radius (m). */
const HATCH_Y = 4.5, HATCH_Z = -7, HATCH_R = 3.2;
/** The hatch opens over this long and shuts over this long (s); the swirl's turn (rad/s). */
const HATCH_OPEN = 0.6, HATCH_SHUT = 0.8, SWIRL_SPIN = 2.4;
/** Streaks rushing to the airlock: how many, how fast (m/s). */
const STREAKS = 36, STREAK_SPEED = 14;
/** Low gravity: how many sparkles float, how fast they rise (m/s), how long the tint takes to come and go (s). */
const SPARKLES = 50, SPARKLE_RISE = 0.7, SPARKLE_SIZE = 0.85, TINT_IN = 0.8, TINT_OUT = 1;
/** The tint low gravity puts on the hangar (× its colours). */
const TINT = new Color(0.86, 0.76, 1.25);

const C = {
  spaceLow: '#4b3a9e', spaceMid: '#3d3592', spaceHigh: '#2c2f80', spaceTop: '#22286c',
  nebulaPink: '#6a4aa0', nebulaTeal: '#3a5f9e', star: '#ffffff', starWarm: '#fff1a8', starCool: '#c4f2ff',
  planet: '#ff9f6b', planetBand: '#ffc08a', planetRing: '#ffd27a', moon: '#8de6d2', crater: '#6cc9b6',
  hull: '#d3dcee', hullDark: '#c2cbdc', beam: '#a9b6cf', beamDark: '#8b98b4', teal: '#36c2c0', orange: '#ff9f43',
  yellow: '#ffe36b', glow: '#8ff8ff', screen: '#5fe0d8',
  deckTop: '#c5cfe1', deckBody: '#e3e8f6', porthole: '#5fe0d8', portholeRim: '#ff9f43', deckStripe: '#36c2c0', seam: '#b4bed2',
  walkTop: '#ff9f43', walkBody: '#e4e9f2', liftTop: '#eafffd', liftBody: '#36c2c0',
  hatch: '#ffb347', hatchFace: '#ffd27a', hatchStripe: '#36c2c0', swirlDeep: '#2a2470', swirl: '#bba6ff', swirlLight: '#ffffff',
  lampOff: '#b0623a', lampOn: '#ff7a3a', streak: '#dffcff',
};

const SPARKLE_COLOURS = ['#fff6b8', '#ffc8f0', '#c8f4ff', '#ffffff'];
const BLINK_COLOURS = ['#ff6b6b', '#ffe36b', '#5fe0a8', '#6bc4ff'];
const THRUSTER_GLOW = '#8ff8ff', CEILING_LAMP = '#fff4c4';

const SIDES = [-1, 1] as const;

/** A light that blinks: where, how big (m), its colour. */
type Blink = { at: Vector3; size: number; colour: string };

export function shipScenery(level: Level): LevelScenery {
  const root = new Group();
  root.name = 'scenery:ship';
  const mats: Material[] = [];
  const keep = <M extends Material>(m: M) => (mats.push(m), m);
  const lit = keep(litMaterial()), flat = keep(flatMaterial()), both = keep(flatMaterial(true)), back = keep(flatMaterial());
  const cam = level.camera, rng = layoutRng(23);
  const s = new Shapes();
  const blinks: Blink[] = [];

  // ---- the platforms ----
  const groups = new Map<string, Group>();
  for (const p of level.platforms) {
    const g = platformGroup(p.id, lit, (b, sh) => (p.kind === 'solid' ? deck(b, sh, p) : p.path ? lift(b, sh, p) : walk(b, sh, p)));
    groups.set(p.id, g);
    root.add(g);
  }

  // ---- what stands still: space, the hangar, rails, consoles, railings ----
  const b = new Batch('flat');
  space(b, s, cam, rng);
  hangar(b, s, level, blinks);
  root.add(meshOf(b, back, 'scenery:back'));

  // ---- the airlock: two hatch halves a side, a swirl behind, a lamp over it (built for the right; mirrored left) ----
  const halfDisc = new CylinderGeometry(HATCH_R, HATCH_R, 0.3, 24, 1, false, 0, Math.PI); // its round half toward +x
  const doors = instanced(geometryOf('flat', (bb, sh) => {
    bb.add(halfDisc, at(0, 0, 0, 1, 1, 1, 0, 0, Math.PI / 2), C.hatch); // round half up, facing along x
    bb.add(sh.box, at(-0.17, 0.1, 0, 0.04, 0.2, HATCH_R * 2 - 0.3), C.hatchStripe);
    bb.add(sh.cyl, at(-0.17, HATCH_R * 0.55, 0, 0.55, 0.04, 0.55, 0, 0, Math.PI / 2), plain(C.screen));
    bb.add(sh.torus, at(-0.17, HATCH_R * 0.55, 0, 0.6, 0.6, 0.6, 0, Math.PI / 2, 0), C.hatchFace);
  }), both, 4, 'scenery:airlock-doors');
  halfDisc.dispose();
  const swirl = instanced(geometryOf('flat', (bb, sh) => {
    bb.add(sh.cyl, at(0, 0, 0, HATCH_R, 0.1, HATCH_R, 0, 0, Math.PI / 2), plain(C.swirlDeep));
    for (let k = 0; k < 40; k++) {
      const a = k * 0.55, r = 0.2 + (k / 40) * (HATCH_R - 0.4), d = 0.12 + r * 0.05;
      bb.add(sh.lowBall, at(-0.1, Math.sin(a) * r, Math.cos(a) * r, 0.05, d, d), plain(k % 3 ? C.swirl : C.swirlLight));
    }
  }), both, 2, 'scenery:airlock-swirl');
  const white = (_p: Vector3, _n: Vector3, out: Color) => out.setRGB(1, 1, 1);
  const lamps = instanced(geometryOf('flat', (bb, sh) => bb.add(sh.ball, at(0, 0, 0, 0.55, 0.45, 0.55), white)), flat, 2, 'scenery:airlock-lamps');
  const streaks = instanced(geometryOf('flat', (bb, sh) => bb.add(sh.lowBall, at(0, 0, 0, 1, 0.05, 0.05), plain(C.streak))),
    flat, STREAKS, 'scenery:airlock-pull');
  root.add(doors, swirl, lamps, streaks);
  const airlockMeshes = [doors, swirl, lamps, streaks];

  // ---- low gravity: sparkles floating up through the hangar ----
  const sparkles = instanced(geometryOf('flat', (bb, sh) => bb.add(sh.sparkle, at(0, 0, 0, 1), white)), flat, SPARKLES, 'scenery:low-gravity');
  const sparkleAt: Vector3[] = [];
  for (let i = 0; i < SPARKLES; i++) {
    sparkleAt.push(v3(cam.left + rng() * (cam.right - cam.left), cam.bottom + rng() * (cam.top - cam.bottom), -0.8 - rng() * 7));
    sparkles.setColorAt(i, untone(SPARKLE_COLOURS[i % SPARKLE_COLOURS.length]));
  }
  root.add(sparkles);

  // ---- blinking lights: console buttons, thruster glows, ceiling lamps ----
  const blinkers = instanced(geometryOf('flat', (bb, sh) => bb.add(sh.lowBall, at(0, 0, 0, 1), white)), flat, blinks.length, 'scenery:blinkers');
  blinks.forEach((k, i) => blinkers.setColorAt(i, untone(k.colour)));
  root.add(blinkers);

  s.dispose();

  // ---- moving it all ----
  const clock = new MischiefClock();
  const now: Platform[] = [];
  const m4 = new Matrix4(), q = new Quaternion(), e = new Euler(), pos = new Vector3(), size = new Vector3();
  const lampOff = untone(C.lampOff), lampOn = untone(C.lampOn), lampC = new Color();
  const state = { airlock: { left: 0, right: 0 }, tint: 0 };
  let hatchSide: 1 | -1 = 1;
  const put = (im: InstancedMesh, i: number, x: number, y: number, z: number, sx: number, sy = sx, sz = sx, rx = 0, rz = 0) => {
    m4.compose(pos.set(x, y, z), q.setFromEuler(e.set(rx, 0, rz)), size.set(sx, sy, sz));
    im.setMatrixAt(i, m4);
  };

  const update = (time: number, cues: Parameters<LevelScenery['update']>[1], live?: MischiefView) => {
    const t = safeTime(time);
    clock.take(t, cues, live);
    platformsAt(level, t, now);
    for (const p of now) groups.get(p.id)?.position.set(p.x, p.y, 0);

    // the airlock: the hatch on its side opens, its lamp flashes, the swirl turns, streaks rush toward it
    if (live?.active === 'airlock') hatchSide = live.side;
    const open = clock.level('airlock', t, HATCH_OPEN, HATCH_SHUT);
    state.airlock.left = hatchSide < 0 ? open : 0;
    state.airlock.right = hatchSide > 0 ? open : 0;
    for (const side of SIDES) {
      const o = side === hatchSide ? open : 0, k = side < 0 ? 0 : 1, x = side * (BULKHEAD_X + BULKHEAD_T / 2);
      put(doors, 2 * k, x, HATCH_Y + o * (HATCH_R + 0.4), HATCH_Z, side, 1, 1);
      put(doors, 2 * k + 1, x, HATCH_Y - o * (HATCH_R + 0.4), HATCH_Z, side, 1, 1, Math.PI);
      put(swirl, k, side * (BULKHEAD_X + BULKHEAD_T + 0.05), HATCH_Y, HATCH_Z, o > 0.01 ? side : 0, 1, 1, t * SWIRL_SPIN * side);
      const flash = o > 0.01 ? 0.5 + 0.5 * Math.sin(t * 12) : 0;
      put(lamps, k, side * (BULKHEAD_X - 0.1), HATCH_Y + HATCH_R + 1.4, HATCH_Z, 1 + 0.25 * flash);
      lamps.setColorAt(k, lampC.copy(lampOff).lerp(lampOn, o > 0.01 ? 0.4 + 0.6 * flash : 0));
    }
    const span = BULKHEAD_X * 2;
    for (let j = 0; j < STREAKS; j++) {
      const x0 = (j * 7.3) % span, y = cam.bottom + 1 + ((j * 3.7) % (cam.top - cam.bottom - 1));
      const z = -0.9 - ((j * 2.3) % 9);
      const u = ((((x0 + hatchSide * STREAK_SPEED * t) % span) + span) % span) - BULKHEAD_X; // −X … X
      const near = 1 - Math.abs(u - hatchSide * BULKHEAD_X) / span; // longer close to the hatch
      put(streaks, j, u, y + (HATCH_Y - y) * near * near * 0.4, z, open * (0.6 + 2.4 * near), open, open);
    }
    for (const im of airlockMeshes) im.instanceMatrix.needsUpdate = true;
    if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
    swirl.visible = streaks.visible = open > 0.01;

    // low gravity: sparkles drift up and twinkle; the hangar takes a lilac tint
    const low = clock.level('lowGravity', t, TINT_IN, TINT_OUT);
    state.tint = low;
    sparkles.visible = low > 0 || clock.on('lowGravity', t);
    const h = cam.top - cam.bottom + 4;
    for (let j = 0; j < SPARKLES; j++) {
      const c = sparkleAt[j], y = cam.bottom - 2 + ((((c.y - cam.bottom) + SPARKLE_RISE * t) % h) + h) % h;
      const k = SPARKLE_SIZE * (0.6 + 0.4 * Math.sin(t * 5 + j * 1.9)) * low;
      put(sparkles, j, c.x + 0.5 * Math.sin(t * 0.8 + j), y, c.z, k, k, k, 0, t * 0.8 + j);
    }
    sparkles.instanceMatrix.needsUpdate = true;
    back.color.setRGB(1, 1, 1).lerp(TINT, low);

    // blinking lights, each at its own beat
    for (let j = 0; j < blinks.length; j++) {
      const k = blinks[j], on = Math.sin(t * (2 + (j % 5) * 0.7) + j * 2.3) > -0.2 ? 1 : 0.55;
      put(blinkers, j, k.at.x, k.at.y, k.at.z, k.size * on);
    }
    blinkers.instanceMatrix.needsUpdate = true;
  };
  update(0, []);

  return { root, update, state: () => state, dispose: disposer(root, mats) };
}

/** The deck: pale plating on top, a white body with a teal band of glowing dots, seams, an orange stripe low down. */
function deck(b: Batch, s: Shapes, p: Platform): void {
  const z = DECK_FRONT - DECK_DEPTH_Z / 2;
  b.add(s.box, at(0, -0.125, z, p.w + 0.16, 0.25, DECK_DEPTH_Z + 0.16), C.deckTop);
  b.add(s.box, at(0, -0.25 - (p.h - 0.25) / 2, z, p.w, p.h - 0.25, DECK_DEPTH_Z), C.deckBody);
  b.add(s.box, at(0, -0.7, DECK_FRONT + 0.02, p.w - 0.1, 0.36, 0.04), C.deckStripe);
  for (let x = -p.w / 2 + 0.6; x < p.w / 2 - 0.4; x += 1.2) b.add(s.lowBall, at(x, -0.7, DECK_FRONT + 0.06, 0.09, 0.09, 0.04), C.glow, 1);
  b.add(s.box, at(0, -p.h + 0.55, DECK_FRONT + 0.02, p.w - 0.1, 0.2, 0.04), C.orange);
  for (let x = -p.w / 2 + 3; x < p.w / 2 - 1; x += 3) b.add(s.box, at(x, -2.2, DECK_FRONT + 0.02, 0.06, 2.6, 0.04), C.seam);
  // round portholes glowing teal between the seams
  for (let x = -p.w / 2 + 4.5; x < p.w / 2 - 1; x += 6) {
    b.add(s.cyl, at(x, -2.1, DECK_FRONT + 0.03, 0.62, 0.04, 0.62, Math.PI / 2, 0, 0), C.porthole, 0.6);
    b.add(s.torus, at(x, -2.1, DECK_FRONT + 0.05, 0.68, 0.68, 0.5), C.portholeRim);
  }
}

/** A catwalk or the bridge: an orange top, a white body, a glowing strip underneath. */
function walk(b: Batch, s: Shapes, p: Platform): void {
  b.add(s.box, at(0, -WALK_TOP / 2, 0, p.w + 0.1, WALK_TOP, WALK_DEPTH_Z + 0.1), C.walkTop);
  b.add(s.box, at(0, -WALK_TOP - (p.h - WALK_TOP) / 2, 0, p.w, p.h - WALK_TOP, WALK_DEPTH_Z), C.walkBody);
  b.add(s.box, at(0, -p.h + 0.04, WALK_DEPTH_Z / 2 - 0.1, p.w - 0.4, 0.08, 0.1), C.glow, 1);
  for (let x = -p.w / 2 + 0.5; x < p.w / 2; x += 1) b.add(s.box, at(x, -0.24, WALK_DEPTH_Z / 2 + 0.01, 0.04, 0.2, 0.02), C.seam);
}

/** A lift: a teal body, a pale top, glowing yellow edges. */
function lift(b: Batch, s: Shapes, p: Platform): void {
  b.add(s.box, at(0, -WALK_TOP / 2, 0, p.w + 0.1, WALK_TOP, WALK_DEPTH_Z + 0.1), C.liftTop);
  b.add(s.box, at(0, -WALK_TOP - (p.h - WALK_TOP) / 2, 0, p.w, p.h - WALK_TOP, WALK_DEPTH_Z), C.liftBody);
  for (const side of [-1, 1]) b.add(s.box, at(side * (p.w / 2 - 0.08), -0.25, WALK_DEPTH_Z / 2 + 0.01, 0.12, 0.26, 0.04), C.yellow, 1);
  b.add(s.box, at(0, -0.25, WALK_DEPTH_Z / 2 + 0.01, p.w - 0.6, 0.06, 0.03), C.yellow, 1);
}

/** Space far behind: a soft purple sky, nebulas, many stars, a ringed planet and a little minty moon. */
function space(b: Batch, s: Shapes, cam: Level['camera'], rng: () => number): void {
  const cx = (cam.left + cam.right) / 2, cy = (cam.bottom + cam.top) / 2;
  addBackdrop(b, -62, cx, cy, gradient([[-30, C.spaceLow], [0, C.spaceMid], [30, C.spaceHigh], [60, C.spaceTop]]));
  for (let i = 0; i < 9; i++) {
    const x = cx - 80 + rng() * 160, y = cy - 20 + rng() * 50;
    b.add(s.lowBall, at(x, y, -60, 14 + rng() * 10, 6 + rng() * 5, 1), plain(i % 2 ? C.nebulaPink : C.nebulaTeal));
  }
  for (let i = 0; i < 260; i++) {
    const r = 0.08 + rng() * rng() * 0.3;
    b.add(s.lowBall, at(cx - 100 + rng() * 200, cy - 45 + rng() * 100, -58 + rng() * 2, r, r, r), plain([C.star, C.starWarm, C.starCool][i % 3]));
  }
  // a ringed planet, a moon
  const px = cx + 28, py = cy + 14, pz = -54;
  b.add(s.ball, at(px, py, pz, 7, 7, 7), plain(C.planet));
  for (const dy of [-2.5, 1.2]) b.add(s.ball, at(px, py + dy, pz + 0.4, 6.9, 0.9, 6.9), plain(C.planetBand));
  b.add(s.torus, at(px, py, pz, 11, 11, 3, 1.25, 0, 0.35), plain(C.planetRing));
  const mx = cx - 30, my = cy + 18;
  b.add(s.ball, at(mx, my, pz, 3, 3, 3), plain(C.moon));
  for (const [dx, dy, r] of [[-1, 0.8, 0.6], [1.1, -0.4, 0.45], [0.2, -1.4, 0.35]] as const) {
    b.add(s.lowBall, at(mx + dx, my + dy, pz + 2.7, r, r, 0.2), plain(C.crater));
  }
}

/**
 * The hangar round the play: the window wall's struts and sills at the back, the ceiling with its lamps, the bulkheads
 * at the sides with a round hole for each airlock hatch (and its ring), the lifts' rails, consoles on the back of the
 * deck, railings behind the catwalks and the bridge, thrusters under the deck. The lights that blink go in `blinks`.
 */
function hangar(b: Batch, s: Shapes, level: Level, blinks: Blink[]): void {
  const cam = level.camera;
  const top = cam.top + 4, bottom = cam.bottom - 9;
  // the window wall
  for (let x = -40; x <= 40; x += 8) b.add(s.box, at(x, (top + bottom) / 2, WALL_Z, 1.2, top - bottom + 4, 1), x % 16 ? C.beam : C.beamDark);
  for (const y of [bottom + 2, cam.top + 1]) b.add(s.box, at(0, y, WALL_Z + 0.2, 84, 1.1, 1.2), C.beam);
  // the ceiling and its lamps
  b.add(s.box, at(0, top + 1.5, WALL_Z / 2, 84, 3, -WALL_Z), C.hullDark);
  for (let x = -16; x <= 16; x += 8) {
    b.add(s.box, at(x, top - 0.2, -4, 2.4, 0.4, 1.4), C.beamDark);
    blinks.push({ at: v3(x, top - 0.55, -4), size: 0.35, colour: CEILING_LAMP });
  }
  // the bulkheads, a hole in each for its hatch, a ring round the hole
  for (const side of [-1, 1]) {
    const x = side * (BULKHEAD_X + BULKHEAD_T / 2), front = BULKHEAD_FRONT, zb = WALL_Z;
    const y0 = HATCH_Y - HATCH_R, y1 = HATCH_Y + HATCH_R, z0 = HATCH_Z + HATCH_R, z1 = HATCH_Z - HATCH_R;
    b.add(s.box, at(x, (y1 + top + 2) / 2, (front + zb) / 2, BULKHEAD_T, top + 2 - y1, front - zb), C.hull);
    b.add(s.box, at(x, (bottom + y0) / 2, (front + zb) / 2, BULKHEAD_T, y0 - bottom, front - zb), C.hull);
    b.add(s.box, at(x, HATCH_Y, (front + z0) / 2, BULKHEAD_T, y1 - y0, front - z0), C.hull);
    b.add(s.box, at(x, HATCH_Y, (z1 + zb) / 2, BULKHEAD_T, y1 - y0, z1 - zb), C.hull);
    b.add(s.torus, at(x - side * 0.35, HATCH_Y, HATCH_Z, HATCH_R + 0.15, HATCH_R + 0.15, 1.6, 0, Math.PI / 2, 0), C.orange);
    for (const y of [y1 + 1.5, y0 - 1.5]) b.add(s.box, at(x - side * 0.32, y, (front + zb) / 2, 0.05, 0.5, front - zb - 0.4), C.teal);
  }
  // the lifts' rails
  for (const p of level.platforms) {
    if (!p.path) continue;
    const yTop = p.y + Math.abs(p.path.dy) + 2.5, yLow = cam.bottom - 2;
    for (const dx of [-1.25, 1.25]) rod(b, s, v3(p.x + dx, yLow, -1.4), v3(p.x + dx, yTop, -1.4), 0.12, C.teal);
    b.add(s.box, at(p.x, yTop, -1.4, 3.2, 0.3, 0.5), C.beamDark);
  }
  // consoles on the back of the deck, with screens and buttons
  const deckP = level.platforms.find((p) => p.kind === 'solid')!;
  for (const cx of [-8, 0, 8]) {
    const z = DECK_FRONT - DECK_DEPTH_Z + 1;
    b.add(s.box, at(cx, deckP.y + 0.55, z, 2.4, 1.1, 1), C.hullDark);
    b.add(s.box, at(cx, deckP.y + 1.25, z - 0.2, 2.2, 0.6, 0.15, -0.3, 0, 0), plain(C.screen));
    [-0.7, 0, 0.7].forEach((bx, k) => blinks.push({ at: v3(cx + bx, deckP.y + 0.85, z + 0.52), size: 0.12, colour: BLINK_COLOURS[(k + cx) & 3] }));
  }
  // railings behind the catwalks and the bridge
  for (const p of level.platforms) {
    if (p.kind !== 'thin' || p.path) continue;
    const z = -WALK_DEPTH_Z / 2 - 0.3;
    for (let x = p.x - p.w / 2 + 0.3; x <= p.x + p.w / 2 - 0.2; x += 1.1) rod(b, s, v3(x, p.y - 0.4, z), v3(x, p.y + 0.9, z), 0.04, C.beam);
    rod(b, s, v3(p.x - p.w / 2 + 0.2, p.y + 0.9, z), v3(p.x + p.w / 2 - 0.2, p.y + 0.9, z), 0.06, C.teal);
  }
  // thrusters under the deck, glowing
  for (const tx of [-9, -3, 3, 9]) {
    const y = deckP.y - deckP.h;
    b.add(s.cone, at(tx, y - 0.7, -1.4, 1, 1.4, 1, Math.PI, 0, 0), C.beamDark);
    blinks.push({ at: v3(tx, y - 1.5, -1.4), size: 0.45, colour: THRUSTER_GLOW });
  }
}
