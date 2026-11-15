import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { POST_H } from '../../src/arena/features';
import { postAngles } from '../../src/arena/geometry';
import { CROWD_ROWS } from '../../src/show/crowd-stands';
import {
  clearHeight, CRANE_S, DUEL_FAR, DUEL_FOV, DUEL_HIGH, DUEL_LOW, DUEL_NEAR, DUEL_SWAY, duelBearing, HERO_FOV, keepClear, LOW_FOV, LOW_OUT,
  LOW_UP, propSpheres, ropePosts, shotAngle, shotFrame, SHOT_NAMES, STANDS_IN, STANDS_TOP, TOP_UP, WIDE_FAR, WIDE_NEAR, WIDE_ORBIT,
  type ShotBody, type ShotFrame, type ShotName, type ShotView, type Sphere,
} from '../../src/show/shots';

const STAGE = { ringRadius: 6.5, bumper: 0.65 };
const R = STAGE.ringRadius;
const POSTS = ropePosts(STAGE);
const TV = 16 / 9;
const body = (x: number, y: number, z: number, h = 1.4, vx = 0, vz = 0): ShotBody => ({ x, y, z, h, vx, vz });
const view = (all: ShotBody[], o: Partial<ShotView> = {}): ShotView => ({ all, t: 0, angle: 0.4, side: 1, aspect: TV, keepOut: [], ...o });
const newFrame = (): ShotFrame => ({ pos: new Vector3(), look: new Vector3(), fov: 0 });
const frame = (name: ShotName, v: ShotView) => shotFrame(name, v, STAGE, POSTS, newFrame());
/** A camera on the frame, a TV's shape. */
function cam(f: ShotFrame): PerspectiveCamera {
  const c = new PerspectiveCamera(f.fov, TV, 0.1, 300);
  c.position.copy(f.pos);
  c.lookAt(f.look);
  c.updateMatrixWorld();
  return c;
}
const inFrame = (b: ShotBody, c: PerspectiveCamera) => {
  const q = new Vector3(b.x, b.y, b.z).project(c);
  return Math.abs(q.x) < 1 && Math.abs(q.y) < 1 && q.z < 1;
};
const flat = (v: Vector3) => Math.hypot(v.x, v.z);

describe('the shots’ framing', () => {
  test('wide: 6–13 m from the action, fitting its spread, orbiting at 0.12 rad/s', () => {
    const one = frame('wide', view([body(0, 0.8, 0)]));
    expect(one.pos.distanceTo(one.look)).toBeCloseTo(WIDE_NEAR);
    const spread = [body(-5, 0.8, 0), body(5, 0.8, 0), body(0, 0.8, 5), body(0, 0.8, -5), body(3, 6, 3)];
    const far = frame('wide', view(spread));
    expect(far.pos.distanceTo(far.look)).toBeLessThanOrEqual(WIDE_FAR + 1e-9);
    const mid = frame('wide', view([body(-2, 0.8, 0), body(2, 0.8, 0)]));
    const d = mid.pos.distanceTo(mid.look);
    expect(d).toBeGreaterThan(WIDE_NEAR);
    expect(d).toBeLessThan(WIDE_FAR);
    for (const b of spread) expect(inFrame(b, cam(far))).toBe(true);
    const a0 = frame('wide', view([body(0, 0.8, 0)], { t: 0 })), a1 = frame('wide', view([body(0, 0.8, 0)], { t: 2 }));
    const turn = Math.atan2(a1.pos.z, a1.pos.x) - Math.atan2(a0.pos.z, a0.pos.x);
    expect(turn).toBeCloseTo(2 * WIDE_ORBIT, 5);
  });

  test('duel: side-on to the pair, 1.4–2 m up, 3.5–7 m away, fov 42°, both in frame', () => {
    for (const sep of [0.8, 2, 3.5]) {
      const a = body(-sep / 2, 0.8, 1), b = body(sep / 2, 0.8, 1);
      const v = view([a, b, body(-4, 0.8, -3)], { a, b, angle: duelBearing(a, b, 1) });
      const f = frame('duel', v);
      expect(f.fov).toBe(DUEL_FOV);
      expect(f.pos.y).toBeGreaterThanOrEqual(DUEL_LOW);
      expect(f.pos.y).toBeLessThanOrEqual(DUEL_HIGH);
      const d = Math.hypot(f.pos.x - f.look.x, f.pos.z - f.look.z);
      expect(d).toBeGreaterThanOrEqual(DUEL_NEAR - 1e-9);
      expect(d).toBeLessThanOrEqual(DUEL_FAR + 1e-9);
      // square to the line between them (they stand along x): the camera is off along z
      expect(Math.abs(Math.atan2(f.pos.x - f.look.x, f.pos.z - f.look.z))).toBeLessThanOrEqual(DUEL_SWAY + 1e-9);
      expect(inFrame(a, cam(f)) && inFrame(b, cam(f))).toBe(true);
    }
  });

  test('duelBearing: of the two side-on bearings, the one nearer where the camera is', () => {
    const a = body(0, 1, 0), b = body(2, 1, 0);
    expect(Math.sin(duelBearing(a, b, 1.2))).toBeCloseTo(1);
    expect(Math.sin(duelBearing(a, b, -1.2))).toBeCloseTo(-1);
    expect(duelBearing(a, body(0.05, 1, 0), 0.7)).toBe(0.7);
  });

  test('hero: a three-quarter chase from behind the way it heads, fov 42°, in the middle of the frame', () => {
    const a = body(1, 0.8, 0, 1.4, 4, 0); // running along +x
    const v = view([a], { a });
    v.angle = shotAngle('hero', v, 0.5, STAGE);
    expect(v.angle).toBeCloseTo(0);
    const f = frame('hero', v);
    expect(f.fov).toBe(HERO_FOV);
    const off = f.pos.clone().sub(new Vector3(a.x, a.y, a.z));
    expect(off.x).toBeLessThan(0); // behind it
    expect(Math.abs(Math.atan2(off.z, -off.x))).toBeCloseTo(Math.PI / 4, 5); // and a quarter turn to the side
    expect(inFrame(a, cam(f))).toBe(true);
  });

  test('low: just outside the bumper, 0.9 m up (higher only as the bumper needs), fov 60°, never at a post', () => {
    for (const [x, z] of [[0, 0], [3, 2], [-4, -1], [1, -5]]) {
      const all = [body(x, 0.8, z), body(x + 1, 0.8, z)];
      const v = view(all);
      v.angle = shotAngle('low', v, 0.3, STAGE);
      const f = frame('low', v);
      expect(f.fov).toBe(LOW_FOV);
      expect(flat(f.pos)).toBeCloseTo(R + LOW_OUT);
      expect(f.pos.y).toBeGreaterThanOrEqual(LOW_UP);
      expect(f.pos.y).toBeLessThan(1.6);
      for (const p of postAngles()) expect(Math.abs(Math.atan2(Math.sin(v.angle - p), Math.cos(v.angle - p)))).toBeGreaterThanOrEqual(0.19);
      for (const b of all) {
        expect(inFrame(b, cam(f))).toBe(true);
        expect(clearHeight(b.x, b.z, b.y - 0.55 * b.h, f.pos.x, f.pos.z, STAGE)).toBeLessThanOrEqual(f.pos.y + 1e-9);
      }
    }
  });

  test('top: straight down from 15 m (within a few degrees), turning slowly', () => {
    const all = [body(-3, 0.8, 1), body(3, 0.8, -1)];
    const f0 = frame('top', view(all)), f1 = frame('top', view(all, { t: 5 }));
    expect(f0.pos.y).toBe(TOP_UP);
    const down = f0.look.clone().sub(f0.pos).normalize();
    expect(down.y).toBeLessThan(-Math.cos((6 * Math.PI) / 180));
    expect(Math.atan2(f1.pos.z - f1.look.z, f1.pos.x - f1.look.x)).not.toBeCloseTo(Math.atan2(f0.pos.z - f0.look.z, f0.pos.x - f0.look.x));
    for (const b of all) expect(inFrame(b, cam(f0))).toBe(true);
  });

  test('flier and ring-out: they look at the flier; the ring-out shot watches from inside the ring, over the bumper', () => {
    const a = body(9, -1.5, 1, 1.4, 6, 0);
    const v = view([body(0, 0.8, 0)], { a });
    v.angle = shotAngle('flier', v, 0.5, STAGE);
    const f = frame('flier', v);
    expect(f.look.distanceTo(new Vector3(a.x, a.y, a.z))).toBeLessThan(1e-9);
    v.angle = shotAngle('ringOut', v, 0.5, STAGE);
    const o = frame('ringOut', v);
    expect(flat(o.pos)).toBeLessThan(R);
    expect(inFrame(a, cam(o))).toBe(true);
    expect(clearHeight(a.x, a.z, a.y - 0.55 * a.h, o.pos.x, o.pos.z, STAGE)).toBeLessThanOrEqual(o.pos.y + 1e-9);
  });

  test('crane: a CRANE_S s rise from a low shot to a high wide one', () => {
    const all = [body(2, 0.8, 1), body(3, 0.8, 0)];
    const v = view(all);
    v.angle = shotAngle('crane', v, 0.5, STAGE);
    let last = -Infinity;
    const ys: number[] = [];
    for (let t = 0; t <= CRANE_S; t += 0.25) {
      const f = frame('crane', { ...v, t });
      expect(f.pos.y).toBeGreaterThanOrEqual(last - 1e-9);
      last = f.pos.y;
      ys.push(f.pos.y);
      for (const b of all) expect(inFrame(b, cam(f))).toBe(true);
    }
    expect(ys[0]).toBeLessThan(2); // low: 0.9 m, lifted only as its view over the bumper needs
    expect(ys[ys.length - 1]).toBeGreaterThan(4);
  });

  test('every shot over a fighter up against the edge keeps it in frame and its feet over the bumper', () => {
    for (const ang of [0, 1, 2.2, 3.5, 5]) {
      const a = body(Math.cos(ang) * 5.8, 0.8, Math.sin(ang) * 5.8), b = body(Math.cos(ang) * 4.4, 0.8, Math.sin(ang) * 4.4);
      const v = view([a, b, body(0, 0.8, 0)], { a, b });
      for (const name of SHOT_NAMES) {
        const vv = name === 'wide' || name === 'top' || name === 'crane' || name === 'low' ? { ...v, a: undefined, b: undefined } : v;
        vv.angle = shotAngle(name, vv, 0.37, STAGE);
        const f = frame(name, vv);
        const subj = vv.a ? (name === 'duel' ? [a, b] : [a]) : vv.all;
        for (const s of subj) {
          expect(inFrame(s, cam(f)), `${name} at ${ang}`).toBe(true);
          expect(clearHeight(s.x, s.z, s.y - 0.55 * s.h, f.pos.x, f.pos.z, STAGE), `${name} at ${ang}`).toBeLessThanOrEqual(f.pos.y + 1e-9);
        }
      }
    }
  });
});

describe('keeping the camera clear', () => {
  test('a shot’s camera inside a ball is lifted out of it; the eased camera is pushed to its nearest side', () => {
    const ball: Sphere = { x: 0, y: 1, z: 0, r: 1 };
    const lifted = keepClear(new Vector3(0.5, 1, 0), [], [ball], [], STAGE);
    expect(lifted.x).toBe(0.5);
    expect(lifted.distanceTo(new Vector3(0, 1, 0))).toBeGreaterThanOrEqual(1);
    const pushed = keepClear(new Vector3(0.5, 1, 0), [], [ball], [], STAGE, true);
    expect(pushed.distanceTo(new Vector3(0, 1, 0))).toBeGreaterThanOrEqual(1);
    expect(pushed.y).toBeCloseTo(1); // straight out sideways, not up
  });

  test('never in the bumper, the posts or the stands, never under the floor', () => {
    expect(keepClear(new Vector3(R + 0.15, 0.2, 0), [], [], POSTS, STAGE).y).toBeGreaterThan(STAGE.bumper);
    for (const p of POSTS) expect(keepClear(new Vector3(p.x, 0.5, p.z), [], [], POSTS, STAGE).y).toBeGreaterThan(1.3);
    expect(keepClear(new Vector3(16, 0.5, 0), [], [], POSTS, STAGE).y).toBeGreaterThan(STANDS_TOP);
    expect(keepClear(new Vector3(0, -3, 0), [], [], POSTS, STAGE).y).toBeGreaterThan(0);
  });

  test('a line of sight to the feet is lifted over the bumper, unless the fighter is up on the bumper itself', () => {
    const p = keepClear(new Vector3(R + 2, 0.5, 0), [body(2, 0.8, 0)], [], [], STAGE);
    expect(p.y).toBeGreaterThanOrEqual(clearHeight(2, 0, 0.03, R + 2, 0, STAGE));
    const on = keepClear(new Vector3(R + 2, 1.2, 0), [body(R + 0.1, 1.5, 0)], [], [], STAGE);
    expect(on.y).toBeCloseTo(1.2);
  });

  test('the stands and posts it keeps out of are where the arena puts them', () => {
    expect(STANDS_IN).toBeCloseTo(CROWD_ROWS[0].r - 0.75);
    expect(STANDS_TOP).toBeGreaterThanOrEqual(CROWD_ROWS[CROWD_ROWS.length - 1].y + 0.46 * 1.15);
    expect(POSTS.length).toBe(postAngles().length);
  });

  test('propSpheres: the beach ball and only the risen pinball posts', () => {
    const out: Sphere[] = [];
    const f = {
      posts: [{ at: { x: 1, z: 0 }, up: 1 }, { at: { x: -1, z: 0 }, up: 0 }],
      ball: { body: { translation: () => ({ x: 2, y: 3, z: 4 }) }, radius: 1.25 },
    };
    const s = propSpheres(f, out);
    expect(s.length).toBe(2);
    expect(s[0].x).toBe(1);
    expect(s[0].y).toBeCloseTo(POST_H / 2);
    expect(s[1]).toMatchObject({ x: 2, y: 3, z: 4 });
    expect(s[1].r).toBeGreaterThan(1.25);
    expect(propSpheres({ posts: [], ball: null }, out).length).toBe(0);
  });
});
