import {
  Box3, BufferGeometry, InstancedMesh, Matrix4, Mesh, Vector3, type Material, type Object3D,
} from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { LEVEL_ORDER, LEVELS } from '../../src/levels';
import { buildScenery, type LevelScenery } from '../../src/levels/scenery';
import { TEST_LEVEL } from '../../src/levels/test';
import { platformsAt, type Level } from '../../src/stage/level';
import { LevelMischief, vineGrip, type MischiefCue, type MischiefName, type TrainBox } from '../../src/stage/mischief';
import { mulberry32 } from '../../src/util/rng';

/**
 * The old ring arena (`createArena`), measured once (ruling R6) so this test outlives it: 20 meshes plus its backdrop
 * drawn by the GPU behind everything (21 draw calls), 130,656 triangles (most of them the ball pit's 900 balls).
 */
const RING_DRAW_CALLS = 21, RING_TRIANGLES = 130_656;
/** The plan's own ceiling for a level's scenery. */
const MAX_DRAW_CALLS = 60, MAX_TRIANGLES = 150_000;

const LEVEL_LIST: Level[] = LEVEL_ORDER.map((id) => LEVELS[id as keyof typeof LEVELS]);

/** Every mesh under `root`, with whether it sits under a group named with one of `skip` (its own name counts). */
function meshes(root: Object3D, skip: string[] = []): Mesh[] {
  const out: Mesh[] = [];
  const walk = (o: Object3D, skipped: boolean) => {
    const s = skipped || skip.some((p) => o.name.startsWith(p));
    if (o instanceof Mesh && !s) out.push(o);
    for (const c of o.children) walk(c, s);
  };
  walk(root, false);
  return out;
}

/** Whether `o` and every parent of it is visible. */
function shown(o: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** Calls `each` with every triangle (three world-space corners) a mesh draws (each instance of an instanced one). */
function triangles(m: Mesh, each: (a: Vector3, b: Vector3, c: Vector3) => void): void {
  const geo = m.geometry as BufferGeometry, pos = geo.getAttribute('position'), idx = geo.index;
  const n = idx ? idx.count : pos.count;
  const mats: Matrix4[] = [];
  if (m instanceof InstancedMesh) {
    for (let i = 0; i < m.count; i++) mats.push(new Matrix4().multiplyMatrices(m.matrixWorld, m.getMatrixAt(i, new Matrix4())));
  } else mats.push(m.matrixWorld);
  const v = [new Vector3(), new Vector3(), new Vector3()];
  for (const w of mats) {
    for (let t = 0; t < n; t += 3) {
      for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, idx ? idx.getX(t + k) : t + k).applyMatrix4(w);
      each(v[0], v[1], v[2]);
    }
  }
}

/** Draw calls (one a mesh) and triangles (each instance counted) of everything under `root`, shown or not. */
function cost(root: Object3D): { calls: number; tris: number } {
  let calls = 0, tris = 0;
  for (const m of meshes(root)) {
    const geo = m.geometry as BufferGeometry;
    calls += Array.isArray(m.material) ? m.material.length : 1;
    tris += ((geo.index ? geo.index.count : geo.getAttribute('position').count) / 3) * (m instanceof InstancedMesh ? m.count : 1);
  }
  return { calls, tris };
}

/** A world box of everything shown under `root` (instanced meshes measured instance by instance, never a stale box). */
function worldBox(root: Object3D): Box3 {
  root.updateMatrixWorld(true);
  const box = new Box3();
  for (const m of meshes(root)) {
    if (!shown(m)) continue;
    triangles(m, (a, b, c) => box.expandByPoint(a).expandByPoint(b).expandByPoint(c));
  }
  return box;
}

/** A fight's mischief on `level` with `name` under way from t0 for `len` s, and a way to move it on to time t. */
function mischiefAt(level: Level, name: MischiefName, t0: number, len: number) {
  const m = new LevelMischief(level, mulberry32(3));
  m.start(name, t0, len);
  const cues: MischiefCue[] = [];
  const plats = platformsAt(level, t0);
  return {
    m,
    step(t: number): MischiefCue[] {
      platformsAt(level, t, plats);
      m.step(t, [], plats, []);
      cues.length = 0;
      m.takeCues(cues);
      return cues;
    },
  };
}

/** Moves a scenery through a mischief from start to end, calling `look` at a few moments in between. */
function through(level: Level, s: LevelScenery, name: MischiefName, look: (t: number, m: LevelMischief) => void): void {
  const t0 = 2, len = 8;
  const run = mischiefAt(level, name, t0, len);
  for (const t of [t0, t0 + 0.2, t0 + 0.6, t0 + 1.9, t0 + 4.1, t0 + 6.3, t0 + len - 0.1, t0 + len, t0 + len + 1]) {
    s.update(t, run.step(t), run.m);
    s.root.updateMatrixWorld(true);
    look(t, run.m);
  }
}

describe.each(LEVEL_LIST)('the $name scenery', (level) => {
  test('platform meshes match the data: each platform drawn where the level has it, moving ones too', () => {
    const s = buildScenery(level);
    for (const t of [0, 1.7, 4.3, 6.1]) {
      s.update(t, []);
      s.root.updateMatrixWorld(true);
      for (const p of platformsAt(level, t)) {
        const g = s.root.getObjectByName(`platform:${p.id}`);
        expect(g, p.id).toBeTruthy();
        const box = worldBox(g!);
        expect(Math.abs(box.max.y - p.y), `${p.id} top at t=${t}`).toBeLessThanOrEqual(0.01);
        expect(Math.abs((box.min.x + box.max.x) / 2 - p.x), `${p.id} centre at t=${t}`).toBeLessThanOrEqual(0.01);
        // its sides on its width: never short, overhanging by a lip at most
        expect(box.max.x - box.min.x, `${p.id} width`).toBeGreaterThanOrEqual(p.w - 0.02);
        expect(box.max.x - box.min.x, `${p.id} width`).toBeLessThanOrEqual(p.w + 0.3);
      }
    }
    s.dispose();
  });

  test('nothing blocks the view: no scenery between the camera and z = 0 inside the camera bounds, mischief too', () => {
    const s = buildScenery(level), cam = level.camera;
    const check = (when: string) => {
      s.root.updateMatrixWorld(true);
      // the platforms and the mischief that plays on the plane (vines, the train, the flood) are the play itself
      for (const m of meshes(s.root, ['platform:', 'play:'])) {
        if (!shown(m)) continue;
        triangles(m, (a, b, c) => {
          if (Math.max(a.z, b.z, c.z) <= 1e-6) return;
          const overlaps = Math.max(a.x, b.x, c.x) > cam.left && Math.min(a.x, b.x, c.x) < cam.right
            && Math.max(a.y, b.y, c.y) > cam.bottom && Math.min(a.y, b.y, c.y) < cam.top;
          if (overlaps) expect.fail(`${m.name || m.parent?.name} ${when}: a triangle at z ${Math.max(a.z, b.z, c.z).toFixed(2)} over (${a.x.toFixed(1)}, ${a.y.toFixed(1)})`);
        });
      }
    };
    s.update(0, []);
    check('at rest');
    for (const md of level.mischief) through(level, s, md.name, (t) => check(`${md.name} t=${t}`));
    s.dispose();
  });

  test('scenery budget: no costlier than the old ring (and within 60 draw calls / 150k triangles)', () => {
    const s = buildScenery(level);
    const { calls, tris } = cost(s.root);
    expect(calls).toBeLessThanOrEqual(Math.min(RING_DRAW_CALLS, MAX_DRAW_CALLS));
    expect(tris).toBeLessThanOrEqual(Math.min(RING_TRIANGLES, MAX_TRIANGLES));
    s.dispose();
  });

  test('reaches well past the camera bounds: 6 m each side, 3 m above and below (R22)', () => {
    const s = buildScenery(level), cam = level.camera;
    s.update(0, []);
    const box = worldBox(s.root);
    expect(box.min.x).toBeLessThanOrEqual(cam.left - 6);
    expect(box.max.x).toBeGreaterThanOrEqual(cam.right + 6);
    expect(box.min.y).toBeLessThanOrEqual(cam.bottom - 3);
    expect(box.max.y).toBeGreaterThanOrEqual(cam.top + 3);
    s.dispose();
  });

  test('dispose frees geometries, instance buffers and materials and leaves the scene', () => {
    const s = buildScenery(level);
    const geos = new Set<BufferGeometry>(), mats = new Set<Material>(), inst = new Set<InstancedMesh>();
    for (const m of meshes(s.root)) {
      geos.add(m.geometry as BufferGeometry);
      if (m instanceof InstancedMesh) inst.add(m);
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mat);
    }
    const freed = new Set<unknown>();
    for (const x of [...geos, ...mats]) x.addEventListener('dispose', () => freed.add(x));
    for (const x of inst) x.addEventListener('dispose', () => freed.add(x));
    const parent = new Mesh();
    parent.add(s.root);
    s.dispose();
    for (const g of geos) expect(freed.has(g), 'a geometry').toBe(true);
    for (const m of mats) expect(freed.has(m), 'a material').toBe(true);
    for (const m of inst) expect(freed.has(m), `instanced ${m.name}`).toBe(true);
    expect(s.root.parent).toBeNull();
  });
});

describe('the mischief looks', () => {
  const jungle = LEVELS.jungle, ship = LEVELS.ship, toy = LEVELS.toyroom;
  const named = (s: LevelScenery, name: string) => {
    const o = s.root.getObjectByName(name);
    expect(o, name).toBeTruthy();
    return o!;
  };

  test('the vines hang down only while they are out, each drawn to its grip (where a rider’s hands are)', () => {
    const s = buildScenery(jungle), vines = named(s, 'play:vines');
    s.update(0, []);
    expect(shown(vines)).toBe(false);
    const data = jungle.mischief.find((m) => m.name === 'vines')!;
    if (data.name !== 'vines') throw new Error('no vines');
    through(jungle, s, 'vines', (t, m) => {
      const out = m.active === 'vines';
      if (!out) return;
      expect(shown(vines), `t=${t}`).toBe(true);
      // once dropped, the lowest point of each vine is its grip
      if (t - m.startT < 0.5) return;
      for (let i = 0; i < data.vines.length; i++) {
        const g = vineGrip(data.vines[i], t, { x: 0, y: 0 });
        const tip = s.root.getObjectByName(`play:vine-tip:${i}`)!;
        const p = tip.getWorldPosition(new Vector3());
        expect(Math.hypot(p.x - g.x, p.y - g.y), `vine ${i} t=${t}`).toBeLessThanOrEqual(0.05);
      }
    });
    // after the end they roll up and hide
    s.update(20, [], undefined);
    expect(shown(vines)).toBe(false);
    s.dispose();
  });

  test('a vine crossing the swinging crown branch passes behind it, not up through its top (Task 11 note)', () => {
    // The camera can look down on the crown branch (it rises to 12 m), so where a vine crosses it the rope must come
    // out behind the branch's back edge, not through its mossy top: at the branch's top the rope (with its leaves,
    // ROPE_OUT round its middle line) is behind everything the branch has.
    const ROPE_OUT = 0.12;
    const s = buildScenery(jungle), crown = s.root.getObjectByName('platform:crown')!, vine = s.root.getObjectByName('play:vine') as InstancedMesh;
    const run = mischiefAt(jungle, 'vines', 0, 60), m4 = new Matrix4(), top = new Vector3(), tip = new Vector3();
    s.update(0, run.step(0), run.m);
    let crossings = 0;
    for (let t = 1; t < 59; t += 0.02) {
      s.update(t, run.step(t), run.m);
      s.root.updateMatrixWorld(true);
      const p = platformsAt(jungle, t).find((q) => q.id === 'crown')!, back = worldBox(crown).min.z;
      for (let i = 0; i < vine.count; i++) {
        top.setFromMatrixPosition(m4.multiplyMatrices(vine.matrixWorld, vine.getMatrixAt(i, m4)));
        s.root.getObjectByName(`play:vine-tip:${i}`)!.getWorldPosition(tip);
        const k = (top.y - p.y) / (top.y - tip.y), x = top.x + (tip.x - top.x) * k, z = top.z + (tip.z - top.z) * k;
        if (k < 0 || k > 1 || Math.abs(x - p.x) > p.w / 2 + ROPE_OUT) continue;
        crossings++;
        expect(z + ROPE_OUT, `vine ${i} at t=${t.toFixed(2)}`).toBeLessThanOrEqual(back);
      }
    }
    expect(crossings).toBeGreaterThan(0); // they do cross
    s.dispose();
  });

  test('the river floods the jungle floor while it is on, and drains after', () => {
    const s = buildScenery(jungle), flood = named(s, 'play:flood');
    s.update(0, []);
    expect(shown(flood)).toBe(false);
    let seen = false;
    through(jungle, s, 'river', (t, m) => {
      if (m.active === 'river' && t - m.startT > 1) {
        expect(shown(flood), `t=${t}`).toBe(true);
        seen = true;
      }
    });
    expect(seen).toBe(true);
    s.update(20, []);
    expect(shown(flood)).toBe(false);
    s.dispose();
  });

  test('the airlock opens on the side it pulls toward, and shuts after', () => {
    const s = buildScenery(ship);
    const run = mischiefAt(ship, 'airlock', 1, 8);
    s.update(1, run.step(1), run.m);
    s.update(3, run.step(3), run.m);
    const side = run.m.side > 0 ? 'right' : 'left', other = run.m.side > 0 ? 'left' : 'right';
    expect(s.state().airlock[side]).toBeGreaterThan(0.9);
    expect(s.state().airlock[other]).toBe(0);
    s.update(9.5, run.step(9.5), run.m);
    s.update(12, run.step(12), run.m);
    expect(s.state().airlock[side]).toBe(0);
    s.dispose();
  });

  test('low gravity shows: floating sparkles and a tint while it is on', () => {
    const s = buildScenery(ship), sparkles = named(s, 'scenery:low-gravity');
    s.update(0, []);
    expect(shown(sparkles)).toBe(false);
    const run = mischiefAt(ship, 'lowGravity', 1, 8);
    s.update(1, run.step(1), run.m);
    s.update(3, run.step(3), run.m);
    expect(shown(sparkles)).toBe(true);
    expect(s.state().tint).toBeGreaterThan(0.9);
    s.update(12, run.step(12), run.m);
    expect(shown(sparkles)).toBe(false);
    expect(s.state().tint).toBe(0);
    s.dispose();
  });

  test('the toy train is drawn over its box wherever the box is on the chest, coming in and going out too', () => {
    const s = buildScenery(toy), train = named(s, 'play:train');
    s.update(0, []);
    expect(shown(train)).toBe(false);
    const chest = toy.platforms.find((p) => p.id === 'floor')!, half = chest.w / 2;
    const box: TrainBox = { x: 0, y: 0, w: 0, h: 0, dir: 1, speed: 0 };
    const run = mischiefAt(toy, 'toyTrain', 1, 8);
    let checked = 0, ramps = 0;
    for (let t = 1; t <= 9; t += 0.01) {
      const cues = run.step(t), tb = run.m.train(box);
      s.update(t, cues, run.m);
      s.root.updateMatrixWorld(true);
      if (!tb) continue;
      const left = Math.max(tb.x - tb.w / 2, chest.x - half), right = Math.min(tb.x + tb.w / 2, chest.x + half);
      if (right <= left) continue; // the box is off the chest: the train is in a tunnel
      if (right - left < tb.w - 1e-6) ramps++; // part on the chest, part past its end
      expect(shown(train), `t=${t.toFixed(2)}`).toBe(true);
      const b = worldBox(train);
      // what bumps a creature on the chest is what it sees there
      expect(b.min.x, `t=${t.toFixed(2)} box ${left.toFixed(2)}…${right.toFixed(2)}`).toBeLessThanOrEqual(left + 0.1);
      expect(b.max.x, `t=${t.toFixed(2)} box ${left.toFixed(2)}…${right.toFixed(2)}`).toBeGreaterThanOrEqual(right - 0.1);
      expect(b.min.y).toBeGreaterThanOrEqual(tb.y - 0.01); // on the chest, never sunk into it
      expect(b.max.y, 'under the bed (its underside 1.1 m)').toBeLessThanOrEqual(tb.y + 1);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    expect(ramps).toBeGreaterThan(10); // the coming-in and going-out windows were looked at
    s.update(20, []);
    expect(shown(train)).toBe(false);
    s.dispose();
  });

  test('the train’s smoke never rises through the bed (stopped or squeezed under it), and puffs behind the creatures', () => {
    const s = buildScenery(toy), smoke = s.root.getObjectByName('play:smoke') as InstancedMesh;
    const bed = toy.platforms.find((p) => p.bounce)!, under = bed.y - bed.h;
    const run = mischiefAt(toy, 'toyTrain', 1, 8), m4 = new Matrix4(), p = new Vector3(), k = new Vector3();
    let near = 0;
    for (let t = 1; t <= 9; t += 0.01) {
      s.update(t, run.step(t), run.m);
      for (let i = 0; i < smoke.count; i++) {
        smoke.getMatrixAt(i, m4);
        p.setFromMatrixPosition(m4);
        const r = k.setFromMatrixColumn(m4, 0).length(); // a ball of radius 1, scaled
        if (r < 1e-3 || Math.abs(p.x - bed.x) > bed.w / 2 + r) continue;
        near++;
        expect(p.y + r, `t=${t.toFixed(2)}`).toBeLessThanOrEqual(under + 1e-3);
        // behind the play plane, clear of any creature (they reach about 0.6 m toward the camera at most)
        expect(p.z + r, `t=${t.toFixed(2)}`).toBeLessThanOrEqual(-0.55);
      }
    }
    expect(near).toBeGreaterThan(0);
    s.dispose();
  });

  test('nothing still stands near the play plane past the toy chest’s ends (a creature falls off in front)', () => {
    // a creature reaches about this far either side of the play plane (m): whatever stays put past an end of the
    // chest, at the heights a creature falls past, keeps behind that and a margin
    const NEAR = 0.6;
    const s = buildScenery(toy), cam = toy.camera, chest = toy.platforms.find((p) => p.id === 'floor')!;
    s.update(0, []);
    s.root.updateMatrixWorld(true);
    let past = 0;
    for (const m of meshes(s.root, ['play:'])) {
      if (!shown(m) || m.name.startsWith('platform-mesh:floor')) continue;
      triangles(m, (a, b, c) => {
        const x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x);
        const beyond = x1 > chest.x + chest.w / 2 || x0 < chest.x - chest.w / 2;
        const inView = x1 > cam.left && x0 < cam.right && Math.max(a.y, b.y, c.y) > cam.bottom && Math.min(a.y, b.y, c.y) < cam.top;
        if (!beyond || !inView) return;
        past++;
        expect(Math.max(a.z, b.z, c.z), `${m.name || m.parent?.name} at (${a.x.toFixed(1)}, ${a.y.toFixed(1)})`).toBeLessThanOrEqual(-NEAR);
      });
    }
    expect(past).toBeGreaterThan(0); // the tunnels are there
    s.dispose();
  });

  test('a level with no mischief and the practice level build and update too', () => {
    const s = buildScenery(TEST_LEVEL);
    s.update(1.5, []);
    expect(s.root.getObjectByName('platform:centre')).toBeTruthy();
    s.dispose();
  });

  test('a broken time never moves anything to NaN', () => {
    for (const level of LEVEL_LIST) {
      const s = buildScenery(level);
      s.update(Number.NaN, []);
      s.update(Number.POSITIVE_INFINITY, []);
      const box = worldBox(s.root);
      expect(Number.isFinite(box.min.x) && Number.isFinite(box.max.y), level.id).toBe(true);
      s.dispose();
    }
  });
});
