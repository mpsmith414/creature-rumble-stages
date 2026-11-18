import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { animState, bodyInfo, FADE_STEPS, JOINT_MAX, poseSegments, PoseMemory, restPieces, type AnimState } from '../../src/anim/pose';
import type { Move } from '../../src/fight/types';
import type { BodyLayout } from '../../src/anim/layout';
import { TEST_LEVEL } from '../../src/levels/test';
import { attackFor } from '../../src/stage/attacks';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { StageSim } from '../../src/stage/sim';
import { NO_INTENT, type Intent } from '../../src/stage/types';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<(typeof KINDS)[number], BodyStats>;
const AT = { x: 2.5, y: 1.25 };
/** Only the main stage. */
const FLAT = { ...TEST_LEVEL, platforms: TEST_LEVEL.platforms.filter((p) => p.id === 'main') };
/** The tumble's spin per step in these tests. */
const SPIN = 0.21;

function state(move: Move, over: Partial<AnimState>): AnimState {
  return {
    action: 'idle', t: 0, len: 0, facing: 1, pos: { ...AT }, vel: { x: 0, y: 0 }, move, attack: null, spin: 0, land: 0,
    ground: true, ...over,
  };
}

/** A few clips to fade between, each as the state `t` steps in. */
function clips(stats: BodyStats): { name: string; at: (t: number) => AnimState }[] {
  const m = stats.move, s = (over: Partial<AnimState>) => state(m, over);
  const fwd = attackFor(m, 'forward', stats), flen = fwd.windup + fwd.active + fwd.cool;
  const air = attackFor(m, 'air', stats), alen = air.windup + air.active + air.cool;
  return [
    { name: 'idle', at: (t) => s({ t }) },
    { name: 'run', at: (t) => s({ action: 'run', t, vel: { x: 6, y: 0 } }) },
    { name: 'run left', at: (t) => s({ action: 'run', t, facing: -1, vel: { x: -6, y: 0 } }) },
    { name: 'air', at: (t) => s({ action: 'air', t, vel: { x: 2, y: -9 }, ground: false }) },
    { name: 'land', at: (t) => s({ action: 'land', t, len: 5, land: Math.max(0, 1 - t / 5) }) },
    { name: 'attack', at: (t) => s({ action: 'attack', t, len: flen, attack: fwd, attackDir: 'forward' }) },
    { name: 'air attack', at: (t) => s({ action: 'attack', t, len: alen, attack: air, attackDir: 'air', ground: false }) },
    { name: 'tumble', at: (t) => s({ action: 'tumble', t, len: 50, vel: { x: -14, y: 8 }, ground: false, spin: SPIN * t }) },
    { name: 'dodge', at: (t) => s({ action: 'dodge', t, len: 22, vel: { x: 9, y: 0 } }) },
  ];
}

const fresh = (L: BodyLayout) => L.segments.map(() => new Matrix4());
const centres = (ms: Matrix4[]) => ms.map((m) => new Vector3().setFromMatrixPosition(m));
/** The furthest any piece's centre moved between two poses (m). */
const jump = (a: Matrix4[], b: Matrix4[]) => Math.max(...centres(a).map((p, s) => p.distanceTo(centres(b)[s])));
const same = (a: Matrix4[], b: Matrix4[]) => a.every((m, s) => m.elements.every((e, i) => Math.abs(e - b[s].elements[i]) < 1e-9));

/** Poses `at(0…steps−1)` with the memory, one step apart; returns the last pose. */
function play(L: BodyLayout, mem: PoseMemory, at: (t: number) => AnimState, steps: number, out = fresh(L)): Matrix4[] {
  for (let t = 0; t < steps; t++) {
    mem.elapse(1);
    poseSegments(L, at(t), out, mem);
  }
  return out;
}

/** The worst joint gap (m) and the worst turn past a joint's range (rad) in a pose. */
function faults(L: BodyLayout, out: Matrix4[]): { gap: number; over: number } {
  const rest = restPieces(L), info = bodyInfo(L);
  const mv = out.map((m, s) => m.clone().multiply(rest[s].clone().invert()));
  const q = new Quaternion(), p = new Vector3(), sc = new Vector3();
  let gap = 0, over = 0;
  for (const g of L.segments) {
    if (g.parent < 0) continue;
    const A = new Vector3(g.anchor.x, g.anchor.y, g.anchor.z);
    gap = Math.max(gap, A.clone().applyMatrix4(mv[g.id]).distanceTo(A.clone().applyMatrix4(mv[g.parent])));
    mv[g.parent].clone().invert().multiply(mv[g.id]).decompose(p, q, sc);
    over = Math.max(over, 2 * Math.acos(Math.min(1, Math.abs(q.w))) - JOINT_MAX[info.joint[g.id]]);
  }
  return { gap, over };
}

describe('the pose cross-fade (display only, R20)', () => {
  it('run → idle fades over FADE_STEPS steps instead of snapping, then is exactly the idle pose', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, c = clips(STATS[k]), run = c[1], idle = c[0];
      const mem = new PoseMemory();
      const lastRun = play(L, mem, run.at, 17).map((m) => m.clone());
      const plainIdle = poseSegments(L, idle.at(0), fresh(L));
      const snap = jump(lastRun, plainIdle);
      mem.elapse(1);
      const first = poseSegments(L, idle.at(0), fresh(L), mem);
      expect(jump(lastRun, first), k).toBeLessThan(Math.max(1e-6, snap * 0.5));
      // after the fade it is the plain pose
      const done = play(L, mem, (t) => idle.at(t + 1), FADE_STEPS);
      expect(same(done, poseSegments(L, idle.at(FADE_STEPS), fresh(L))), k).toBe(true);
    }
  });

  it('tumble → land: the body turns upright over a few frames, not in one', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, c = clips(STATS[k]);
      const mem = new PoseMemory();
      const lastTumble = play(L, mem, c[7].at, 12).map((m) => m.clone()); // 2.3 rad round
      const snap = jump(lastTumble, poseSegments(L, c[4].at(0), fresh(L)));
      let prev = lastTumble, worst = 0;
      for (let t = 0; t <= FADE_STEPS; t++) {
        mem.elapse(1);
        const now = poseSegments(L, c[4].at(t), fresh(L), mem);
        worst = Math.max(worst, jump(prev, now));
        prev = now;
      }
      expect(worst, k).toBeLessThan(snap * 0.6);
    }
  });

  it('every joint stays on its parent and inside its range all through every fade', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, c = clips(STATS[k]), out = fresh(L);
      let worstGap = 0, worstOver = 0, where = '';
      for (const from of c) {
        for (const to of c) {
          if (from === to) continue;
          const mem = new PoseMemory();
          play(L, mem, from.at, 9, out);
          for (let t = 0; t < FADE_STEPS * 2; t++) {
            mem.elapse(0.5); // half steps, as a TV between two steps sees them
            const f = faults(L, poseSegments(L, to.at(t / 2), out, mem));
            if (f.gap > worstGap || f.over > worstOver) where = `${from.name} → ${to.name} at ${t / 2}`;
            worstGap = Math.max(worstGap, f.gap);
            worstOver = Math.max(worstOver, f.over);
          }
        }
      }
      expect(worstGap, `${k} ${where}`).toBeLessThan(1e-3);
      expect(worstOver, `${k} ${where}`).toBeLessThan(1e-6);
    }
  });

  it('tumble → out: the spin carries on where it was instead of starting upright again', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, m = STATS[k].move;
      const tumble = (t: number) => state(m, { action: 'tumble', t, len: 50, ground: false, spin: SPIN * t });
      const out = (t: number) => state(m, { action: 'out', t, ground: false, spin: SPIN * t });
      const mem = new PoseMemory();
      const last = play(L, mem, tumble, 15).map((x) => x.clone());
      mem.elapse(1);
      // the first out frame is the tumble's last turn (spin restarting at 0 would have stood it upright)
      expect(same(poseSegments(L, out(0), fresh(L), mem), last), k).toBe(true);
      mem.elapse(1);
      const next = poseSegments(L, out(1), fresh(L), mem);
      expect(same(next, poseSegments(L, tumble(15), fresh(L))), k).toBe(true);
    }
  });

  it('an attack snaps in, so the strike of a quick jab reads crisp (also a second attack straight after the first)', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, c = clips(STATS[k]), run = c[1], atk = c[5];
      const mem = new PoseMemory();
      play(L, mem, run.at, 10);
      for (const t of [0, 1, 2, 3]) {
        mem.elapse(1);
        expect(same(poseSegments(L, atk.at(t), fresh(L), mem), poseSegments(L, atk.at(t), fresh(L))), `${k} t=${t}`).toBe(true);
      }
      // a new attack begun right after: its first frame is its own pose too
      mem.elapse(1);
      expect(same(poseSegments(L, atk.at(0), fresh(L), mem), poseSegments(L, atk.at(0), fresh(L))), k).toBe(true);
    }
  });

  it('a special and a grab snap in, like an attack', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, m = STATS[k].move, a = attackFor(m, 'forward', STATS[k]);
      for (const st of [
        state(m, { action: 'special', t: 0, len: 60, attack: { ...a, windup: 30 } }),
        state(m, { action: 'grab', t: 0, len: 28 }),
        state(m, { action: 'grab', t: 0, len: 120, holding: true }),
      ]) {
        const mem = new PoseMemory();
        play(L, mem, clips(STATS[k])[1].at, 10);
        mem.elapse(1);
        expect(same(poseSegments(L, st, fresh(L), mem), poseSegments(L, st, fresh(L))), `${k} ${st.action}`).toBe(true);
      }
    }
  });

  it('a thrown creature tumbles on from lying flat: the spin carries on and the held pose eases out, nothing stands up first', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, m = STATS[k].move;
      for (const facing of [1, -1] as const) {
        const mem = new PoseMemory();
        const last = play(L, mem, (t) => state(m, { action: 'held', t, facing, ground: false }), 10).map((x) => x.clone());
        const heldSpin = mem.lastBody.spin;
        expect(Math.abs(heldSpin), k).toBeGreaterThan(1);
        const thrown = (t: number) => state(m, { action: 'tumble', t, len: 40, facing, ground: false, spin: -facing * SPIN * t });
        // the first frame is the held pose itself (the spin carries on from it, the curled limbs ease out)…
        mem.elapse(1);
        expect(same(poseSegments(L, thrown(0), fresh(L), mem), last), `${k} facing ${facing}`).toBe(true);
        // …and once the fade is done it is the tumble, turned on from where the hold left it
        for (let t = 1; t <= FADE_STEPS; t++) {
          mem.elapse(1);
          poseSegments(L, thrown(t), fresh(L), mem);
        }
        mem.elapse(1);
        const t = FADE_STEPS + 1, done = poseSegments(L, thrown(t), fresh(L), mem);
        expect(same(done, poseSegments(L, { ...thrown(t), spin: thrown(t).spin + heldSpin }, fresh(L))), `${k} facing ${facing}`).toBe(true);
      }
    }
  });

  it('a low-damage throw, played out in the sim: the thrown body never jumps upright in one frame', () => {
    for (const k of KINDS) {
      const sim = new StageSim({ level: FLAT, rng: mulberry32(1) });
      const A = STATS.fists, B = STATS[k];
      const a = sim.add('a', A, { x: 0, y: 0 }), b = sim.add('b', B, { x: A.w / 2 + B.w / 2 + 0.1, y: 0 });
      const step = (want: Partial<Intent> = {}) => sim.step(new Map([['a', { ...NO_INTENT, ...want }]]));
      for (let i = 0; i < 30; i++) step();
      a.facing = 1;
      step({ grab: true });
      for (let i = 0; i < 30 && b.action !== 'held'; i++) step();
      expect(b.action, k).toBe('held');
      for (let i = 0; i < 12; i++) step();
      expect(b.damage, k).toBe(0);
      const L = B.layout, mem = new PoseMemory();
      let prev = poseSegments(L, animState(b), fresh(L), mem).map((m) => m.clone());
      step({ attack: true, mx: 1 });
      let worst = 0, where = '';
      for (let i = 0; i < 30; i++) {
        step();
        mem.elapse(1);
        const now = poseSegments(L, animState(b), fresh(L), mem);
        // how far any piece moved this frame, beyond the box's own move (the launch carries the whole body)
        const was = centres(prev), is = centres(now);
        const shift = new Vector3().setFromMatrixPosition(now[0]).sub(new Vector3().setFromMatrixPosition(prev[0]));
        const j = Math.max(...is.map((p, s) => p.clone().sub(was[s]).sub(shift).length()));
        if (j > worst) { worst = j; where = `step ${i} (${b.action})`; }
        prev = now.map((m) => m.clone());
      }
      expect(b.action === 'tumble' || b.action === 'land' || b.action === 'idle' || b.action === 'air', k).toBe(true);
      expect(worst, `${k} ${where}`).toBeLessThan(0.35 * B.h + 0.1);
    }
  });

  it('a hit snaps: hitstun shows at once, never faded into', () => {
    const k = 'fists', L = STATS[k].layout, m = STATS[k].move;
    const mem = new PoseMemory();
    play(L, mem, clips(STATS[k])[1].at, 10);
    const hit = state(m, { action: 'hitstun', t: 0, len: 24, vel: { x: -4, y: 0 } });
    mem.elapse(1);
    expect(same(poseSegments(L, hit, fresh(L), mem), poseSegments(L, hit, fresh(L)))).toBe(true);
  });
});
