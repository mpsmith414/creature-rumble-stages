import { Euler, Group, Matrix4, Mesh, Quaternion, Vector3, type InstancedMesh, type Material } from 'three/webgpu';
import { untone } from '../../render/tone';
import { platformsAt, type Level, type Platform } from '../../stage/level';
import type { TrainBox } from '../../stage/mischief';
import {
  addBackdrop, at, Batch, disposer, ease, flatMaterial, geometryOf, gradient, instanced, layoutRng, type LevelScenery,
  litMaterial, MischiefClock, meshOf, plain, platformGroup, rod, safeTime, Shapes, v3, type MischiefView,
} from './kit';

/**
 * The toy room on the TV: the fight is on top of a long wooden toy chest with a train track painted on it, in a kid's
 * bedroom. Two big wooden toy blocks float on their stands, crayons lie across as platforms (the top one slides), and
 * a little bouncy bed sits in the middle. Behind: striped wallpaper, a window on a sunny day with curtains, shelves of
 * toys, a big teddy, a toy rocket, a ball; a star mobile turns overhead; the bedroom floor and a rug far below. The
 * mischief: the toy train (a smiling engine and two wagons) chugs out of a toy tunnel at one end, along the track and
 * back, puffing smoke. The track curves away behind each end of the chest into its tunnel, so the train never hangs
 * in the air past the end.
 */

/** The toy chest (the solid floor): its depth toward and away from the camera (m), how far its front comes forward. */
const CHEST_DEPTH_Z = 6, CHEST_FRONT = 1.6;
/** A toy block's depth (z, m); a crayon's depth (z, m); the bed's depth (z, m). */
const BLOCK_DEPTH_Z = 2.4, CRAYON_DEPTH_Z = 1.1, BED_DEPTH_Z = 2.8;
/** The bedroom far below and behind: its floor's height, the back wall's depth (m). */
const ROOM_FLOOR_Y = -7.5, WALL_Z = -18;
/**
 * The track: its rails' spacing (m, either side of its middle line). It runs straight along the play plane, then from
 * BEND_FROM (|x|, m) bends back over the chest top, reaching END_Z (m behind the play plane) at the chest's end, and
 * runs on straight at that slope into the toy tunnel there. So nothing of it past the chest's ends comes nearer the
 * play plane than a creature's half-depth: a creature falling off an end passes in front of it, never through it.
 */
const RAIL_Z = 0.42, BEND_FROM = 10, END_Z = -1.3;
/** The toy tunnel at each end, its mouth at the chest's end: its length along the track (m), width and height (m). */
const TUNNEL_LEN = 4.4, TUNNEL_W = 1.4, TUNNEL_H = 1.25;
/** The trestle legs under the tunnel: how far apart along the track (m). */
const LEG_STEP = 0.9;
/** The train's cars: how far apart along the track (m), how much the train bobs as it chugs (m) and how fast (rad/s). */
const CAR_GAP = 1, CHUG = 0.03, CHUG_RATE = 18;
/** Smoke puffs: how many, how many a second leave the chimney, how high they rise (m); a puff squeezed under a platform smaller than this (m) is not drawn. */
const PUFFS = 7, PUFF_RATE = 2.2, PUFF_RISE = 1.4, PUFF_MIN = 0.03;
/**
 * Smoke puffs rise this far behind the play plane (m) at the most forward (the chimney may be further back on the
 * track's bends), so a puff (up to 0.42 m in radius) never covers a creature by the train.
 */
const SMOKE_Z = -1;
/** The engine's chimney top (m over the track), kept with the chug's bob under 1 m: under the bed's 1.1 m underside. */
const CHIMNEY_TOP = 0.96;
/** The star mobile: its height, how far back (m) and its turn (rad/s). */
const MOBILE_Y = 16.5, MOBILE_Z = -6, MOBILE_SPIN = 0.35;

const C = {
  wallA: '#c9eee2', wallB: '#fff4de', wallTop: '#ffd0e0', skirting: '#ffffff', board: '#e6ad70', boardDark: '#d0955a',
  rug: '#ff9fc4', rugRing: '#ffd27a', windowSky: '#8fd6ff', windowSkyHigh: '#5bb8f2', frame: '#ffffff', curtain: '#ff8fb1',
  sun: '#ffe45c', cloud: '#ffffff', shelf: '#f2b880', bear: '#c98a52', bearLight: '#f0c896', bearDark: '#5a3a22',
  ringA: '#ff6b6b', ringB: '#ffd23f', ringC: '#5fd38a', ringD: '#4dabf7', peg: '#e6ad70',
  rocket: '#f4f6fb', rocketRed: '#ff5a5f', window: '#6bc4ff', ball: '#ff5a5f', ballStripe: '#ffffff', ballBlue: '#4dabf7',
  chestTop: '#f7c873', chestBody: '#eaa45e', chestTrim: '#c9813f', rail: '#9a6a3a', sleeper: '#c98a52',
  dotRed: '#ff6b6b', dotBlue: '#4dabf7', dotYellow: '#ffd23f', dotGreen: '#5fd38a',
  blockRed: '#ff5a5f', blockBlue: '#3d9cff', blockPanel: '#ffe9c2', blockEdge: '#ffffff', stand: '#b37bff',
  mattress: '#e8f4ff', blanket: '#ff8fb8', bedFrame: '#b98cff', pillow: '#ffffff', tuft: '#9fc6ff',
  crayonRed: '#ff5a5f', crayonBlue: '#3d9cff', crayonGreen: '#4fcf7a', paperStripe: '#3a3a5a',
  trestle: '#ffcf5a', tunnel: '#4dabf7', tunnelPortal: '#ffd23f', tunnelDark: '#2a3150',
  engine: '#ff4f4f', cab: '#3d7cff', roof: '#ffd23f', wheel: '#ffd23f', chassis: '#3a3a5a', face: '#2a2a3a', cheek: '#ffb0b0',
  wagon: '#5fd38a', wagonTrim: '#ffd23f', smoke: '#ffffff',
  mobileBar: '#e6ad70', mobileStar: '#ffd23f', mobileMoon: '#fff3a8', mobileCloud: '#ffffff', mobilePlanet: '#b98cff',
};

const CRAYONS = [C.crayonRed, C.crayonBlue, C.crayonGreen];
const CRAYON_PAPER = ['#ffb3b5', '#b3d8ff', '#bff0cf'];
const CARGO = [C.dotRed, C.dotBlue, C.dotYellow, C.dotGreen];

export function toyRoomScenery(level: Level): LevelScenery {
  const root = new Group();
  root.name = 'scenery:toyroom';
  const mats: Material[] = [];
  const keep = <M extends Material>(m: M) => (mats.push(m), m);
  const lit = keep(litMaterial()), flat = keep(flatMaterial());
  const cam = level.camera, rng = layoutRng(37);
  const s = new Shapes();
  const chest = level.platforms.find((p) => p.kind === 'solid' && p.y === Math.min(...level.platforms.map((q) => q.y)))!;

  // ---- the platforms ----
  const groups = new Map<string, Group>();
  let crayon = 0;
  for (const p of level.platforms) {
    const fill = (b: Batch, sh: Shapes) => {
      if (p === chest) toyChest(b, sh, p);
      else if (p.kind === 'solid') toyBlock(b, sh, p, p.x < 0 ? C.blockRed : C.blockBlue, p.x < 0);
      else if (p.bounce) bed(b, sh, p);
      else {
        const k = crayon++ % CRAYONS.length;
        crayonShape(b, sh, p, CRAYONS[k], CRAYON_PAPER[k]);
      }
    };
    const g = platformGroup(p.id, lit, fill);
    groups.set(p.id, g);
    root.add(g);
  }

  // ---- what stands still: the bedroom ----
  const b = new Batch('flat');
  room(b, s, cam, rng);
  stands(b, s, level);
  root.add(meshOf(b, flat, 'scenery:back'));

  // ---- the toy tunnels past the chest's ends, on their trestles, well behind the play plane ----
  const ends = new Mesh(geometryOf('flat', (bb, sh) => trackEnds(bb, sh, chest)), flat);
  ends.name = 'scenery:track-ends';
  root.add(ends);

  // ---- the toy train: an engine, two wagons, smoke ----
  const train = new Group();
  train.name = 'play:train';
  train.visible = false;
  const engine = new Mesh(geometryOf('flat', (bb, sh) => engineShape(bb, sh)), flat);
  engine.name = 'play:engine';
  const wagons = instanced(geometryOf('flat', (bb, sh) => wagonShape(bb, sh)), flat, 2, 'play:wagons');
  train.add(engine, wagons);
  const smoke = instanced(geometryOf('flat', (bb, sh) => bb.add(sh.lowBall, at(0, 0, 0, 1), plain(C.smoke))), flat, PUFFS, 'play:smoke');
  smoke.visible = false;
  root.add(train, smoke);

  // ---- the star mobile overhead ----
  const mobile = new Mesh(geometryOf('flat', (bb, sh) => mobileShape(bb, sh)), flat);
  mobile.name = 'scenery:mobile';
  mobile.position.set((cam.left + cam.right) / 2, MOBILE_Y, MOBILE_Z);
  root.add(mobile);

  s.dispose();

  // ---- moving it all ----
  const clock = new MischiefClock();
  const now: Platform[] = [];
  const box: TrainBox = { x: 0, y: 0, w: 0, h: 0, dir: 1, speed: 0 };
  const m4 = new Matrix4(), q = new Quaternion(), e = new Euler(), pos = new Vector3(), size = new Vector3(), facing = new Vector3();
  const chimney = new Vector3();
  const place = (u: number, dir: number, out: Vector3, face: Vector3) => trackAt(u, dir, chest, out, face);
  const put = (im: InstancedMesh, i: number, p: Vector3, yaw: number, k: number) => {
    m4.compose(p, q.setFromEuler(e.set(0, yaw, 0)), size.setScalar(k));
    im.setMatrixAt(i, m4);
  };

  const update = (time: number, cues: Parameters<LevelScenery['update']>[1], live?: MischiefView) => {
    const t = safeTime(time);
    clock.take(t, cues, live);
    platformsAt(level, t, now);
    for (const p of now) groups.get(p.id)?.position.set(p.x, p.y, 0);
    mobile.rotation.y = t * MOBILE_SPIN;

    const tb = clock.on('toyTrain', t) ? live?.train(box) ?? null : null;
    train.visible = smoke.visible = !!tb;
    if (!tb) return;
    // the cars are drawn exactly where the fight's train box is along the track (every car's x is its place in the
    // box), so what a creature is bumped by is what it sees; past the chest's ends they run on into the tunnels, where
    // the train turns round and comes and goes out of sight
    const bob = CHUG * Math.abs(Math.sin(t * CHUG_RATE));
    place(tb.x + tb.dir * CAR_GAP, tb.dir, pos, facing);
    engine.position.set(pos.x, pos.y + bob, pos.z);
    engine.rotation.set(0, yawOf(facing), 0);
    chimney.set(0.32, CHIMNEY_TOP, 0).applyEuler(engine.rotation).add(engine.position);
    for (let k = 0; k < 2; k++) {
      place(tb.x - k * tb.dir * CAR_GAP, tb.dir, pos, facing);
      pos.y += CHUG * Math.abs(Math.sin(t * CHUG_RATE + 1 + k));
      put(wagons, k, pos, yawOf(facing), 1);
    }
    wagons.instanceMatrix.needsUpdate = true;
    // smoke rises from the chimney, squeezed under (or stopped by) anything just over it: the bed it runs under
    for (let k = 0; k < PUFFS; k++) {
      const age = (((t * PUFF_RATE) / PUFFS + k / PUFFS) % 1 + 1) % 1;
      let r = (0.12 + 0.3 * age) * (1 - ease((age - 0.7) / 0.3));
      const x = chimney.x - tb.dir * age * 0.9;
      const ceiling = ceilingOver(now, x, r, chimney.y);
      r = Math.min(r, (ceiling - chimney.y) / 2);
      if (r < PUFF_MIN) r = 0;
      pos.set(x, Math.min(chimney.y + r + age * PUFF_RISE, ceiling - r), Math.min(chimney.z, SMOKE_Z));
      put(smoke, k, pos, 0, r);
    }
    smoke.instanceMatrix.needsUpdate = true;
  };
  update(0, []);

  return {
    root,
    update,
    state: () => ({ airlock: { left: 0, right: 0 }, tint: 0 }),
    dispose: disposer(root, mats),
  };
}

/** The turn about y that faces a car (built facing +x) along `f`. */
const yawOf = (f: Vector3) => Math.atan2(-f.z, f.x);

/**
 * Where on the track a car whose place along the train's run is `u` (the fight's x) stands, and which way it faces
 * running `dir`. Its x is always `u` (so it is drawn where the fight has it); its depth: on the play plane in the
 * middle, past BEND_FROM bending back (a parabola) to END_Z at the chest's end, then on straight at that slope into
 * the tunnel. Fills `out` (the car's bottom centre) and `face` (unit, in xz).
 */
export function trackAt(u: number, dir: number, chest: Platform, out: Vector3, face: Vector3): void {
  const end = Math.sign(u) || 1, d = Math.abs(u) - BEND_FROM, e = chest.w / 2 - BEND_FROM, k = -END_Z / (e * e);
  if (d <= 0) {
    out.set(u, chest.y, 0);
    face.set(dir, 0, 0);
    return;
  }
  const slope = 2 * k * Math.min(d, e);
  const z = d <= e ? -k * d * d : END_Z - slope * (d - e);
  out.set(u, chest.y, z);
  // the way along the track going out toward the tunnel; a car heading back faces the other way
  face.set(end, 0, -slope).normalize().multiplyScalar(dir === end ? 1 : -1);
}

/** The lowest underside over x (± r) of the platforms in `ps` that are above `y`: where rising smoke must stop. */
function ceilingOver(ps: readonly Platform[], x: number, r: number, y: number): number {
  let c = Infinity;
  for (const p of ps) {
    const under = p.y - p.h;
    if (under >= y && under < c && Math.abs(x - p.x) < p.w / 2 + r) c = under;
  }
  return c;
}

/** The toy chest: a honey-wood top with the train track painted on, a body with painted dots, a darker trim. */
function toyChest(b: Batch, s: Shapes, p: Platform): void {
  const z = CHEST_FRONT - CHEST_DEPTH_Z / 2;
  b.add(s.box, at(0, -0.155, z, p.w + 0.16, 0.3, CHEST_DEPTH_Z + 0.16), C.chestTop); // top 5 mm under the rails
  b.add(s.box, at(0, -0.3 - (p.h - 0.3) / 2, z, p.w, p.h - 0.3, CHEST_DEPTH_Z), C.chestBody);
  // the track painted on top (rails flush with the top), sleepers under them: straight, bending back at both ends
  for (const rz of [-RAIL_Z, RAIL_Z]) b.add(s.box, at(0, -0.015, rz, 2 * BEND_FROM, 0.03, 0.07), C.rail);
  const o = new Vector3(), f = new Vector3(), step = 0.2;
  const sleeperHalf = RAIL_Z + 0.15;
  for (let k = 0; k < p.w / 1.2; k++) {
    for (const side of [-1, 1]) {
      const x = side * (0.3 + 0.6 * k);
      trackAt(p.x + x, 1, p, o, f);
      if (Math.abs(x) + sleeperHalf * Math.abs(f.z) + 0.08 > p.w / 2) continue; // a sleeper stops at the chest's end
      b.add(s.box, at(x, -0.02, o.z, 0.16, 0.03, sleeperHalf * 2, 0, yawOf(f), 0), C.sleeper);
    }
  }
  for (const end of [-1, 1]) {
    for (let d = step / 2; d < p.w / 2 - BEND_FROM; d += step) {
      trackAt(p.x + end * (BEND_FROM + d), end, p, o, f);
      for (const off of [-RAIL_Z, RAIL_Z]) {
        const rx = o.x - p.x - f.z * off, len = step / Math.abs(f.x) + 0.02;
        if (Math.abs(rx) + (len / 2) * Math.abs(f.x) > p.w / 2) continue; // a rail stops at the chest's end
        b.add(s.box, at(rx, -0.015, o.z + f.x * off, len, 0.03, 0.07, 0, yawOf(f), 0), C.rail);
      }
    }
  }
  // painted dots and a trim on the front
  const dots = [C.dotRed, C.dotBlue, C.dotYellow, C.dotGreen];
  let k = 0;
  for (let x = -p.w / 2 + 1.2; x < p.w / 2 - 0.8; x += 2.2) {
    b.add(s.cyl, at(x, -1.8, CHEST_FRONT + 0.02, 0.55, 0.05, 0.55, Math.PI / 2, 0, 0), dots[k++ % dots.length]);
    b.add(s.star, at(x + 1.1, -2.7, CHEST_FRONT + 0.03, 0.6, 0.6, 0.4), C.blockPanel);
  }
  b.add(s.box, at(0, -0.55, CHEST_FRONT + 0.02, p.w - 0.1, 0.18, 0.04), C.chestTrim);
  b.add(s.box, at(0, -p.h + 0.25, CHEST_FRONT + 0.02, p.w - 0.1, 0.3, 0.04), C.chestTrim);
  // legs down to the bedroom floor
  const floor = ROOM_FLOOR_Y - p.y; // the bedroom floor, from the chest's top
  for (const lx of [-p.w / 2 + 0.8, 0, p.w / 2 - 0.8]) b.add(s.cyl, at(lx, (-p.h + floor) / 2, z, 0.5, -p.h - floor, 0.5), C.chestTrim);
}

/** A wooden toy block: coloured, a pale panel on its front with a painted star (left) or heart-ish circle (right). */
function toyBlock(b: Batch, s: Shapes, p: Platform, colour: string, star: boolean): void {
  b.add(s.box, at(0, -p.h / 2, 0, p.w, p.h, BLOCK_DEPTH_Z), colour);
  b.add(s.box, at(0, -p.h / 2, BLOCK_DEPTH_Z / 2 + 0.01, p.w - 0.3, p.h - 0.25, 0.03), C.blockPanel);
  if (star) b.add(s.star, at(0, -p.h / 2, BLOCK_DEPTH_Z / 2 + 0.04, 0.7, 0.7, 0.3), colour);
  else {
    for (const dx of [-0.17, 0.17]) b.add(s.cyl, at(dx, -p.h / 2 + 0.1, BLOCK_DEPTH_Z / 2 + 0.04, 0.22, 0.04, 0.22, Math.PI / 2, 0, 0), colour);
    b.add(s.cone, at(0, -p.h / 2 - 0.12, BLOCK_DEPTH_Z / 2 + 0.04, 0.38, 0.4, 0.02, Math.PI, 0, 0), colour);
  }
  for (const y of [-0.04, -p.h + 0.04]) b.add(s.box, at(0, y, BLOCK_DEPTH_Z / 2 + 0.005, p.w, 0.08, 0.02), C.blockEdge);
}

/** The bouncy bed: a puffy mattress (half under a pink blanket) with buttons, a lilac frame, legs to the chest top. */
function bed(b: Batch, s: Shapes, p: Platform): void {
  const half = p.w / 2;
  b.add(s.box, at(-half / 2, -0.15, 0, half, 0.3, BED_DEPTH_Z), C.mattress);
  b.add(s.box, at(half / 2, -0.15, 0, half, 0.3, BED_DEPTH_Z + 0.04), C.blanket);
  b.add(s.box, at(0, -0.35, 0, p.w, p.h - 0.3, BED_DEPTH_Z + 0.1), C.bedFrame);
  for (let x = -half + 0.35; x < 0; x += 0.45) b.add(s.lowBall, at(x, -0.15, BED_DEPTH_Z / 2 + 0.01, 0.06, 0.06, 0.03), C.tuft);
  // legs from under the frame down to the chest top (y = 0), clear of the train running under the bed
  for (const lx of [-half + 0.15, half - 0.15]) {
    for (const lz of [-BED_DEPTH_Z / 2 + 0.15, BED_DEPTH_Z / 2 - 0.15]) b.add(s.cyl, at(lx, -(p.y + p.h) / 2, lz, 0.1, p.y - p.h, 0.1), C.bedFrame);
  }
}

/**
 * A crayon lying along the platform: a hexagonal body in its colour, a paper wrapper round its middle in a paler
 * shade of it with dark stripes, a blunt tip at its left end.
 */
function crayonShape(b: Batch, s: Shapes, p: Platform, colour: string, paper: string): void {
  const tip = 0.55, half = p.w / 2, ry = p.h / (2 * Math.cos(Math.PI / 6)), rz = CRAYON_DEPTH_Z / 2;
  const hexAt = (x0: number, x1: number, k: number, paint: string) =>
    b.add(s.hex, at((x0 + x1) / 2, -p.h / 2, 0, ry * k, x1 - x0, rz * k, 0, 0, Math.PI / 2), paint);
  hexAt(-half + tip, half, 0.95, colour);
  const w0 = -half + tip + 0.9, w1 = half - 0.7;
  hexAt(w0, w1, 1, paper);
  for (const x of [w0 + 0.18, w1 - 0.18]) hexAt(x - 0.05, x + 0.05, 1.01, C.paperStripe);
  b.add(s.hexTip, at(-half + tip / 2, -p.h / 2, 0, ry * 0.95, tip, rz * 0.95, 0, 0, Math.PI / 2), colour);
}

/** The bedroom: wallpaper, skirting, a window on a sunny day with curtains, shelves of toys, big toys, the floor and rug. */
function room(b: Batch, s: Shapes, cam: Level['camera'], rng: () => number): void {
  const cx = (cam.left + cam.right) / 2, cy = (cam.bottom + cam.top) / 2;
  addBackdrop(b, -62, cx, cy, gradient([[-20, C.wallB], [60, C.wallB]]), 2); // only ever seen past the room's corners
  // the wall: stripes, a frieze, skirting
  const wallTop = 40;
  for (let x = -90, k = 0; x < 90; x += 2, k++) {
    b.add(s.box, at(x + 1, (ROOM_FLOOR_Y + wallTop) / 2, WALL_Z, 2, wallTop - ROOM_FLOOR_Y, 0.2), k % 2 ? C.wallA : C.wallB);
  }
  b.add(s.box, at(0, 24, WALL_Z + 0.15, 180, 1.4, 0.1), C.wallTop);
  for (let x = -60; x < 60; x += 4) b.add(s.star, at(x, 24, WALL_Z + 0.25, 0.9, 0.9, 0.3), C.mobileStar);
  b.add(s.box, at(0, ROOM_FLOOR_Y + 0.5, WALL_Z + 0.2, 180, 1, 0.3), C.skirting);
  // the floor, boards running toward the wall, and a round rug under the chest
  for (let x = -90, k = 0; x < 90; x += 1.6, k++) {
    b.add(s.box, at(x + 0.8, ROOM_FLOOR_Y - 0.1, (WALL_Z + 14) / 2, 1.58, 0.2, 14 - WALL_Z), k % 2 ? C.board : C.boardDark);
  }
  b.add(s.cyl, at(0, ROOM_FLOOR_Y + 0.02, -6, 16, 0.04, 9), C.rugRing);
  b.add(s.cyl, at(0, ROOM_FLOOR_Y + 0.05, -6, 14.5, 0.04, 7.8), C.rug);
  // the window: sky, sun, clouds, frame, curtains
  const wx = cx - 21, wy = 9, wz = WALL_Z + 0.2, ww = 11, wh = 10;
  b.add(s.box, at(wx, wy, wz, ww, wh, 0.1), gradient([[wy - wh / 2, C.windowSky], [wy + wh / 2, C.windowSkyHigh]]));
  b.add(s.cyl, at(wx + 2.5, wy + 2.4, wz + 0.1, 1.3, 0.05, 1.3, Math.PI / 2, 0, 0), plain(C.sun));
  for (const [dx, dy] of [[-2.5, 1.5], [-1.2, 1.8], [-0.2, 1.4], [1.2, -2], [2.4, -1.8]] as const) {
    b.add(s.lowBall, at(wx + dx, wy + dy, wz + 0.15, 1, 0.65, 0.1), plain(C.cloud));
  }
  for (const [dx, dy, w, h] of [[0, wh / 2, ww + 0.8, 0.6], [0, -wh / 2, ww + 0.8, 0.6], [-ww / 2, 0, 0.6, wh], [ww / 2, 0, 0.6, wh], [0, 0, 0.3, wh], [0, 0, ww, 0.3]] as const) {
    b.add(s.box, at(wx + dx, wy + dy, wz + 0.3, w, h, 0.4), C.frame);
  }
  for (const side of [-1, 1]) {
    for (let k = 0; k < 5; k++) {
      b.add(s.cyl, at(wx + side * (ww / 2 + 0.6 + k * 0.42), wy - 0.5, wz + 0.8, 0.32, wh + 2.6, 0.32), C.curtain);
    }
  }
  // shelves with toys
  const shelf = (x: number, y: number, w: number) => b.add(s.box, at(x, y, WALL_Z + 1, w, 0.3, 2), C.shelf);
  shelf(cx + 15, 12, 12);
  teddy(b, s, cx + 11, 12.15, WALL_Z + 1, 1.3);
  rings(b, s, cx + 15.5, 12.15, WALL_Z + 1);
  b.add(s.ball, at(cx + 19, 12.15 + 0.9, WALL_Z + 1, 0.9), (p, _n, out) => out.copy(untone(Math.abs(p.y - 13.05) < 0.3 ? C.ballStripe : C.ballBlue)));
  shelf(cx - 4, 17.5, 9);
  for (let k = 0; k < 7; k++) b.add(s.box, at(cx - 7.5 + k * 1.05, 17.65 + 1, WALL_Z + 1, 0.8, 2 + rng() * 0.6, 1.4), CARGO[k % CARGO.length]);
  // big toys on the bedroom floor
  teddy(b, s, cx + 27, ROOM_FLOOR_Y, -11, 4);
  rocket(b, s, cx - 28, ROOM_FLOOR_Y, -9);
  b.add(s.ball, at(cx + 18, ROOM_FLOOR_Y + 1.6, -6, 1.6), (p, _n, out) => out.copy(untone(Math.abs(p.y - (ROOM_FLOOR_Y + 1.6)) < 0.5 ? C.ballStripe : C.ball)));
  for (let k = 0; k < 6; k++) {
    const bx = cx - 18 + (k % 3) * 2.1 + (k > 2 ? 1 : 0), by = ROOM_FLOOR_Y + 1 + (k > 2 ? 2 : 0);
    b.add(s.box, at(bx, by, -13, 2, 2, 2, 0, 0.2 * (k - 2), 0), CARGO[k % CARGO.length]);
  }
  // little toys scattered under the chest
  for (let k = 0; k < 9; k++) {
    const x = -14 + rng() * 28, z = -2 - rng() * 6;
    if (k % 3 === 0) b.add(s.ball, at(x, ROOM_FLOOR_Y + 0.4, z, 0.4), CARGO[k % CARGO.length]);
    else b.add(s.box, at(x, ROOM_FLOOR_Y + 0.35, z, 0.7, 0.7, 0.7, 0, rng() * 3, 0), CARGO[k % CARGO.length]);
  }
}

/** A teddy bear sitting at (x, y, z), `k` times a 1 m bear. */
function teddy(b: Batch, s: Shapes, x: number, y: number, z: number, k: number): void {
  b.add(s.ball, at(x, y + 0.45 * k, z, 0.42 * k, 0.48 * k, 0.38 * k), C.bear);
  b.add(s.ball, at(x, y + 0.42 * k, z + 0.2 * k, 0.26 * k, 0.3 * k, 0.2 * k), C.bearLight);
  b.add(s.ball, at(x, y + 1.05 * k, z, 0.32 * k), C.bear);
  for (const side of [-1, 1]) {
    b.add(s.ball, at(x + side * 0.24 * k, y + 1.32 * k, z, 0.12 * k), C.bear);
    b.add(s.ball, at(x + side * 0.24 * k, y + 1.32 * k, z + 0.05 * k, 0.07 * k), C.bearLight);
    b.add(s.ball, at(x + side * 0.42 * k, y + 0.55 * k, z + 0.05 * k, 0.13 * k, 0.26 * k, 0.13 * k, 0, 0, side * 0.5), C.bear);
    b.add(s.ball, at(x + side * 0.22 * k, y + 0.12 * k, z + 0.25 * k, 0.15 * k, 0.12 * k, 0.22 * k), C.bear);
    b.add(s.lowBall, at(x + side * 0.11 * k, y + 1.1 * k, z + 0.28 * k, 0.04 * k), C.bearDark);
  }
  b.add(s.ball, at(x, y + 0.98 * k, z + 0.26 * k, 0.13 * k, 0.1 * k, 0.1 * k), C.bearLight);
  b.add(s.lowBall, at(x, y + 1.01 * k, z + 0.35 * k, 0.045 * k), C.bearDark);
}

/** A stacking-rings toy on its peg. */
function rings(b: Batch, s: Shapes, x: number, y: number, z: number): void {
  b.add(s.cyl, at(x, y + 0.08, z, 0.7, 0.16, 0.7), C.peg);
  b.add(s.cyl, at(x, y + 1.1, z, 0.1, 2, 0.1), C.peg);
  [C.ringA, C.ringB, C.ringC, C.ringD].forEach((c, k) => {
    const r = 0.62 - k * 0.11;
    b.add(s.torus, at(x, y + 0.32 + k * 0.38, z, r, r, 0.9, Math.PI / 2, 0, 0), c);
  });
}

/** A toy rocket standing on the floor at (x, y, z). */
function rocket(b: Batch, s: Shapes, x: number, y: number, z: number): void {
  b.add(s.cyl, at(x, y + 3, z, 1.1, 4.4, 1.1), C.rocket);
  b.add(s.cone, at(x, y + 6.1, z, 1.1, 1.8, 1.1), C.rocketRed);
  b.add(s.cyl, at(x, y + 3.8, z + 0.95, 0.45, 0.2, 0.45, Math.PI / 2, 0, 0), C.window);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.4;
    b.add(s.box, at(x + Math.cos(a) * 1.2, y + 1.2, z + Math.sin(a) * 1.2, 0.2, 1.8, 1, 0, -a, 0), C.rocketRed);
  }
}

/** The stands the floating toy blocks rest on: a pole from the chest top up behind each block and a little arm. */
function stands(b: Batch, s: Shapes, level: Level): void {
  for (const p of level.platforms) {
    if (p.kind !== 'solid' || p.y <= 0) continue;
    const under = p.y - p.h, z = -BLOCK_DEPTH_Z / 2 - 0.5;
    rod(b, s, v3(p.x, 0, z), v3(p.x, under + 0.3, z), 0.14, C.stand);
    b.add(s.cyl, at(p.x, 0.05, z, 0.5, 0.1, 0.5), C.stand);
    rod(b, s, v3(p.x, under + 0.3, z), v3(p.x, under + 0.3, -BLOCK_DEPTH_Z / 2 + 0.1), 0.1, C.stand);
  }
  // the bed's headboard and a pillow, behind it
  const bedP = level.platforms.find((p) => p.bounce);
  if (bedP) {
    b.add(s.box, at(bedP.x, bedP.y + 0.5, -BED_DEPTH_Z / 2 - 0.1, bedP.w, 2, 0.16), C.bedFrame);
    for (const dx of [-0.6, 0.6]) b.add(s.lowBall, at(bedP.x + dx, bedP.y + 0.9, -BED_DEPTH_Z / 2 + 0.02, 0.28, 0.24, 0.05), C.blanket);
    b.add(s.ball, at(bedP.x - bedP.w / 2 + 0.6, bedP.y + 0.12, -BED_DEPTH_Z / 2 + 0.3, 0.5, 0.18, 0.26), C.pillow);
  }
}

/**
 * The toy tunnel at each end of the chest: its yellow mouth at the chest's end, arched blue blocks along the track on
 * yellow trestle legs down to the floor, all behind the play plane (the track has bent back by then).
 */
function trackEnds(b: Batch, s: Shapes, chest: Platform): void {
  const y = chest.y, p = new Vector3(), f = new Vector3(), half = chest.w / 2;
  for (const end of [-1, 1]) {
    const along = (d: number) => trackAt(chest.x + end * (half + d), end, chest, p, f);
    for (let d = 0.45; d < TUNNEL_LEN; d += 0.4) {
      along(d);
      const yaw = yawOf(f);
      b.add(s.box, at(p.x, y + TUNNEL_H / 2, p.z, 0.75, TUNNEL_H, TUNNEL_W, 0, yaw, 0), C.tunnel);
      b.add(s.cyl, at(p.x, y + TUNNEL_H, p.z, TUNNEL_W / 2, 0.75, TUNNEL_W / 2, 0, yaw, Math.PI / 2), C.tunnel);
    }
    for (let d = 0.6; d < TUNNEL_LEN; d += LEG_STEP) {
      along(d);
      b.add(s.box, at(p.x, (y + ROOM_FLOOR_Y) / 2, p.z, 0.16, y - ROOM_FLOOR_Y, 0.16), C.trestle);
    }
    // the mouth: a yellow arch, dark inside, facing back along the track
    along(0.12);
    const yaw = yawOf(f);
    b.add(s.box, at(p.x, y + TUNNEL_H / 2, p.z, 0.2, TUNNEL_H, TUNNEL_W + 0.2, 0, yaw, 0), C.tunnelPortal);
    b.add(s.cyl, at(p.x, y + TUNNEL_H, p.z, TUNNEL_W / 2 + 0.1, 0.2, TUNNEL_W / 2 + 0.1, 0, yaw, Math.PI / 2), C.tunnelPortal);
    b.add(s.box, at(p.x - f.x * 0.11, y + TUNNEL_H / 2, p.z - f.z * 0.11, 0.02, TUNNEL_H, TUNNEL_W - 0.3, 0, yaw, 0), C.tunnelDark);
    b.add(s.cyl, at(p.x - f.x * 0.11, y + TUNNEL_H, p.z - f.z * 0.11, TUNNEL_W / 2 - 0.15, 0.02, TUNNEL_W / 2 - 0.15, 0, yaw, Math.PI / 2), C.tunnelDark);
  }
}

/** The engine, facing +x, its wheels on y = 0: a red boiler with a smiling face, a blue cab, a yellow roof, a chimney. */
function engineShape(b: Batch, s: Shapes): void {
  b.add(s.box, at(0, 0.3, 0, 1, 0.16, 0.7), C.chassis);
  for (const z of [-0.36, 0.36]) for (const x of [-0.32, 0.02, 0.33]) b.add(s.cyl, at(x, 0.17, z, 0.17, 0.08, 0.17, Math.PI / 2, 0, 0), C.wheel);
  b.add(s.cyl, at(0.15, 0.62, 0, 0.27, 0.62, 0.27, 0, 0, Math.PI / 2), C.engine);
  b.add(s.box, at(-0.3, 0.6, 0, 0.42, 0.56, 0.7), C.cab);
  b.add(s.box, at(-0.3, 0.9, 0, 0.52, 0.08, 0.8), C.roof);
  b.add(s.cyl, at(0.32, (0.85 + CHIMNEY_TOP - 0.05) / 2, 0, 0.09, CHIMNEY_TOP - 0.05 - 0.85 + 0.1, 0.09), C.chassis);
  b.add(s.cyl, at(0.32, CHIMNEY_TOP - 0.025, 0, 0.13, 0.05, 0.13), C.roof);
  // the smiling face on the boiler's front
  b.add(s.cyl, at(0.47, 0.62, 0, 0.22, 0.02, 0.22, 0, 0, Math.PI / 2), C.wagonTrim);
  for (const z of [-0.08, 0.08]) b.add(s.lowBall, at(0.48, 0.68, z, 0.02, 0.035, 0.03), C.face);
  for (const z of [-0.12, 0.12]) b.add(s.lowBall, at(0.48, 0.58, z, 0.015, 0.03, 0.04), C.cheek);
  for (let k = -2; k <= 2; k++) b.add(s.lowBall, at(0.485, 0.545 + 0.008 * k * k, k * 0.035, 0.014, 0.014, 0.014), C.face);
  b.add(s.cone, at(0.5, 0.22, 0, 0.2, 0.25, 0.3, 0, 0, -Math.PI / 2), C.roof);
}

/** A wagon, facing +x, its wheels on y = 0: a green open box with a yellow trim, carrying coloured balls. */
function wagonShape(b: Batch, s: Shapes): void {
  b.add(s.box, at(0, 0.3, 0, 0.88, 0.14, 0.66), C.chassis);
  for (const z of [-0.34, 0.34]) for (const x of [-0.26, 0.26]) b.add(s.cyl, at(x, 0.15, z, 0.15, 0.08, 0.15, Math.PI / 2, 0, 0), C.wheel);
  b.add(s.box, at(0, 0.58, 0, 0.84, 0.42, 0.64), C.wagon);
  b.add(s.box, at(0, 0.8, 0, 0.9, 0.06, 0.7), C.wagonTrim);
  CARGO.forEach((c, k) => b.add(s.ball, at(-0.2 + (k % 2) * 0.38, 0.79, -0.13 + Math.floor(k / 2) * 0.27, 0.15), c));
}

/** The star mobile: a cross of two bars with a star, a moon, a cloud and a planet hanging from the ends. */
function mobileShape(b: Batch, s: Shapes): void {
  rod(b, s, v3(0, 0, 0), v3(0, 3, 0), 0.04, C.mobileBar);
  for (const [dx, dz] of [[1, 0], [0, 1]] as const) rod(b, s, v3(-2.2 * dx, 0, -2.2 * dz), v3(2.2 * dx, 0, 2.2 * dz), 0.06, C.mobileBar);
  const hang = (x: number, z: number, len: number) => rod(b, s, v3(x, 0, z), v3(x, -len, z), 0.015, C.mobileBar);
  hang(2.2, 0, 1.2);
  b.add(s.star, at(2.2, -1.6, 0, 1, 1, 0.8), C.mobileStar);
  hang(-2.2, 0, 1);
  b.add(s.ball, at(-2.2, -1.4, 0, 0.42, 0.42, 0.2), C.mobileMoon);
  hang(0, 2.2, 1.3);
  for (const dx of [-0.3, 0, 0.3]) b.add(s.lowBall, at(dx, -1.65 + (dx === 0 ? 0.12 : 0), 2.2, 0.32, 0.26, 0.2), C.mobileCloud);
  hang(0, -2.2, 0.9);
  b.add(s.ball, at(0, -1.35, -2.2, 0.38), C.mobilePlanet);
  b.add(s.torus, at(0, -1.35, -2.2, 0.62, 0.62, 0.4, 1.2, 0, 0.3), C.mobileStar);
}
