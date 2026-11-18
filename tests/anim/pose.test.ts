import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { animState, bodyInfo, JOINT_MAX, poseSegments, restPieces, type AnimState } from '../../src/anim/pose';
import type { Move } from '../../src/fight/types';
import { TEST_LEVEL } from '../../src/levels/test';
import type { BodyLayout } from '../../src/anim/layout';
import { attackFor, type AttackDir } from '../../src/stage/attacks';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { StageFighter } from '../../src/stage/fighter';
import { GRAB_ACTIVE, GRAB_MISS, GRAB_WINDUP, HOLD_MAX, THROW_STEPS } from '../../src/stage/grab';
import { StageSim } from '../../src/stage/sim';
import { NO_INTENT } from '../../src/stage/types';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture } from '../fixtures/fighters';

/** Counts every three.js vector, quaternion, matrix and Euler made, so a test can tell a call allocates none. */
const made = vi.hoisted(() => ({ n: 0 }));
vi.mock('three/webgpu', async (importOriginal) => {
  const three = await importOriginal<typeof import('three/webgpu')>();
  class Vector3 extends three.Vector3 { constructor(...a: ConstructorParameters<typeof three.Vector3>) { super(...a); made.n++; } }
  class Quaternion extends three.Quaternion { constructor(...a: ConstructorParameters<typeof three.Quaternion>) { super(...a); made.n++; } }
  class Matrix4 extends three.Matrix4 { constructor(...a: ConstructorParameters<typeof three.Matrix4>) { super(...a); made.n++; } }
  class Euler extends three.Euler { constructor(...a: ConstructorParameters<typeof three.Euler>) { super(...a); made.n++; } }
  return { ...three, Vector3, Quaternion, Matrix4, Euler };
});

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<(typeof KINDS)[number], BodyStats>;
const DIRS: readonly AttackDir[] = ['forward', 'up', 'down', 'air'];
/** Where the box stands in these tests (any place will do; not the origin, so placement errors show). */
const AT = { x: 2.5, y: 1.25 };
/** The tumble spins this much per step in these tests (any steady spin). */
const SPIN_PER_STEP = 0.21;

function state(move: Move, over: Partial<AnimState>): AnimState {
  return {
    action: 'idle', t: 0, len: 0, facing: 1, pos: { ...AT }, vel: { x: 0, y: 0 }, move, attack: null, spin: 0, land: 0,
    ground: true, ...over,
  };
}

/** A clip's name, how long to sample it (steps) and the state at step t. */
type Clip = { name: string; len: number; at: (t: number) => AnimState };

/** Only the main stage: a special played out on it, start to end. */
const FLAT = { ...TEST_LEVEL, platforms: TEST_LEVEL.platforms.filter((p) => p.id === 'main') };
const specials = new Map<string, AnimState[]>();

/**
 * Every step of the body's special as a real fighter plays it (alone on the flat stage, facing `facing`), as poses see
 * it, standing at AT: the wind-up, the move, and a slam's landing and getting up.
 */
function specialSteps(stats: BodyStats, facing: 1 | -1): AnimState[] {
  const key = `${stats.move} ${facing}`;
  let list = specials.get(key);
  if (list) return list;
  const sim = new StageSim({ level: FLAT, rng: mulberry32(1) });
  const f = sim.add('me', stats, { x: 0, y: 0 });
  for (let k = 0; k < 30; k++) sim.step(new Map());
  f.facing = facing;
  f.meter = 1;
  list = [];
  sim.step(new Map([['me', { ...NO_INTENT, special: true }]]));
  while (f.action === 'special' && list.length < 300) {
    list.push({ ...animState(f), pos: { ...AT }, vel: { ...f.mover.vel } });
    sim.step(new Map());
  }
  specials.set(key, list);
  return list;
}

/** Every clip a body has, both ways round. */
function clips(stats: BodyStats): Clip[] {
  const m = stats.move;
  const list: Clip[] = [];
  for (const facing of [1, -1] as const) {
    const s = (over: Partial<AnimState>) => state(m, { facing, ...over });
    list.push(
      { name: 'idle', len: 120, at: (t) => s({ t }) },
      { name: 'run', len: 90, at: (t) => s({ action: 'run', t, vel: { x: 6 * facing, y: 0 } }) },
      { name: 'air up', len: 40, at: (t) => s({ action: 'air', t, vel: { x: 2, y: 9 }, ground: false }) },
      { name: 'air down', len: 40, at: (t) => s({ action: 'air', t, vel: { x: -2, y: -12 }, ground: false }) },
      { name: 'vine hang', len: 90, at: (t) => s({ action: 'air', t, vel: { x: 5 * Math.sin(t / 15), y: 0 }, ground: false, hang: true }) },
      { name: 'land', len: 5, at: (t) => s({ action: 'land', t, len: 5, land: 1 - t / 5 }) },
      { name: 'hitstun', len: 24, at: (t) => s({ action: 'hitstun', t, len: 24, vel: { x: -4 * facing, y: 0 } }) },
      { name: 'hitstun air', len: 24, at: (t) => s({ action: 'hitstun', t, len: 24, vel: { x: -5 * facing, y: 4 }, ground: false }) },
      { name: 'tumble', len: 50, at: (t) => s({ action: 'tumble', t, len: 50, vel: { x: -14 * facing, y: 8 }, ground: false, spin: SPIN_PER_STEP * t * facing }) },
      { name: 'out', len: 20, at: (t) => s({ action: 'out', t, ground: false, spin: SPIN_PER_STEP * t }) },
      { name: 'roll', len: 22, at: (t) => s({ action: 'dodge', t, len: 22, vel: { x: 9 * facing, y: 0 } }) },
      { name: 'sidestep', len: 22, at: (t) => s({ action: 'dodge', t, len: 22 }) },
      { name: 'air dodge', len: 22, at: (t) => s({ action: 'dodge', t, len: 22, vel: { x: 1, y: -3 }, ground: false }) },
      { name: 'showoff', len: 150, at: (t) => s({ action: 'showoff', t }) },
      { name: 'grab reach', len: 28, at: (t) => s({ action: 'grab', t, len: GRAB_WINDUP + GRAB_ACTIVE + GRAB_MISS }) },
      { name: 'grab hold', len: 60, at: (t) => s({ action: 'grab', t, len: HOLD_MAX, holding: true }) },
      { name: 'held', len: 60, at: (t) => s({ action: 'held', t, ground: false }) },
      { name: 'throw', len: THROW_STEPS, at: (t) => s({ action: 'throw', t, len: THROW_STEPS }) },
      { name: 'throw up', len: THROW_STEPS, at: (t) => s({ action: 'throw', t, len: THROW_STEPS, throwUp: true }) },
      { name: 'special frozen', len: 10, at: (t) => s({ action: 'special', t, len: 40 }) },
    );
    const sp = specialSteps(stats, facing);
    list.push({ name: `special (${sp.length} steps)`, len: sp.length - 1, at: (t) => sp[Math.min(sp.length - 1, Math.floor(t))] });
    for (const dir of DIRS) {
      const a = attackFor(m, dir, stats), len = a.windup + a.active + a.cool;
      list.push({ name: `attack ${dir}`, len, at: (t) => s({ action: 'attack', t, len, attack: a, attackDir: dir, ground: dir !== 'air' }) });
    }
  }
  return list;
}

/** 30 sample times through a clip, its ends included. */
const samples = (c: Clip) => Array.from({ length: 30 }, (_, i) => (c.len * i) / 29);

/** Each segment's move from rest (pieceNow × pieceRest⁻¹): where its rest points go. */
const moves = (out: Matrix4[], rest: Matrix4[]) => out.map((m, s) => m.clone().multiply(rest[s].clone().invert()));
const v = (p: { x: number; y: number; z: number }) => new Vector3(p.x, p.y, p.z);

/**
 * Each segment's two ends posed in the world, and how far its capsule reaches below them (`down`: its radius, as
 * squashed by the pose — a ball of radius r under the linear map L reaches r × |row y of L| down).
 */
function ends(layout: BodyLayout, out: Matrix4[]) {
  const mv = moves(out, restPieces(layout));
  return layout.segments.map((g, s) => {
    const e = mv[s].elements;
    return { g, a: v(g.a).applyMatrix4(mv[s]), b: v(g.b).applyMatrix4(mv[s]), down: g.radius * Math.hypot(e[1], e[5], e[9]) };
  });
}
const lowest = (e: ReturnType<typeof ends>) => Math.min(...e.map(({ a, b, down }) => Math.min(a.y, b.y) - down));

describe('poseSegments', () => {
  it('poses stay connected for every fixture: each joint stays on its parent within 1 mm', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, rest = restPieces(L), out = L.segments.map(() => new Matrix4());
      for (const c of clips(STATS[k])) {
        let worst = 0, where = '';
        for (const t of samples(c)) {
          const mv = moves(poseSegments(L, c.at(t), out), rest);
          for (const g of L.segments) {
            if (g.parent < 0) continue;
            const gap = v(g.anchor).applyMatrix4(mv[g.id]).distanceTo(v(g.anchor).applyMatrix4(mv[g.parent]));
            if (gap > worst) { worst = gap; where = `t=${t.toFixed(1)} segment ${g.id} (${g.kind})`; }
          }
        }
        expect(worst, `${k} ${c.name} ${where}`).toBeLessThan(1e-3);
      }
    }
  });

  it('every joint stays in its range: a head never folds back on its neck (≤ 1.2 rad), no limb past its joint', () => {
    const q = new Quaternion(), p = new Vector3(), sc = new Vector3();
    for (const k of KINDS) {
      const L = STATS[k].layout, rest = restPieces(L), out = L.segments.map(() => new Matrix4()), info = bodyInfo(L);
      for (const c of clips(STATS[k])) {
        let worst = 0, where = '';
        for (const t of samples(c)) {
          const mv = moves(poseSegments(L, c.at(t), out), rest);
          for (const g of L.segments) {
            if (g.parent < 0) continue;
            // the turn from rest relative to the parent (any squash cancels: both carry the same world map)
            mv[g.parent].clone().invert().multiply(mv[g.id]).decompose(p, q, sc);
            const turn = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
            const max = Math.min(JOINT_MAX[info.joint[g.id]], g.kind === 'head' ? 1.2 : Infinity);
            if (turn - max > worst) { worst = turn - max; where = `t=${t.toFixed(1)} segment ${g.id} (${g.kind}) turned ${turn.toFixed(2)} rad`; }
          }
        }
        expect(worst, `${k} ${c.name} ${where}`).toBeLessThan(1e-6);
      }
    }
  });

  it('every matrix is finite in every clip, and the same state poses the same', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, out = L.segments.map(() => new Matrix4()), again = L.segments.map(() => new Matrix4());
      for (const c of clips(STATS[k])) {
        let bad = '';
        for (const t of samples(c)) {
          poseSegments(L, c.at(t), out);
          poseSegments(L, c.at(t), again);
          out.forEach((m, s) => {
            if (!m.elements.every(Number.isFinite) || !m.equals(again[s])) bad ||= `t=${t.toFixed(1)} segment ${s}`;
          });
        }
        expect(bad, `${k} ${c.name}`).toBe('');
      }
    }
  });

  it('feet on the floor when standing: idle and run keep the lowest point within 3 cm of the box bottom', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, out = L.segments.map(() => new Matrix4());
      for (const c of clips(STATS[k]).filter((x) => x.name === 'idle' || x.name === 'run')) {
        const off = samples(c).map((t) => Math.abs(lowest(ends(L, poseSegments(L, c.at(t), out))) - AT.y));
        expect(Math.max(...off), `${k} ${c.name}`).toBeLessThan(0.03);
      }
    }
  });

  it('nothing sinks below the box bottom in a pose on the ground', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, out = L.segments.map(() => new Matrix4());
      for (const c of clips(STATS[k])) {
        const lows = samples(c).map((t) => c.at(t)).filter((st) => st.ground).map((st) => lowest(ends(L, poseSegments(L, st, out))));
        if (lows.length) expect(Math.min(...lows), `${k} ${c.name}`).toBeGreaterThan(AT.y - 0.03);
      }
    }
  });

  it('the weapon reaches the hit area at the middle of the strike', () => {
    for (const k of KINDS) {
      const stats = STATS[k], L = stats.layout, out = L.segments.map(() => new Matrix4());
      for (const facing of [1, -1] as const) for (const dir of DIRS) {
        const a = attackFor(stats.move, dir, stats);
        const t = a.windup + a.active / 2;
        const st = state(stats.move, { action: 'attack', t, len: a.windup + a.active + a.cool, facing, attack: a, attackDir: dir, ground: dir !== 'air' });
        const cx = AT.x + facing * a.area.dx, cy = AT.y + a.area.dy;
        const near = Math.min(...ends(L, poseSegments(L, st, out)).filter((e) => e.g.weapon)
          .flatMap(({ a: p, b: q }) => [Math.hypot(p.x - cx, p.y - cy), Math.hypot(q.x - cx, q.y - cy)]));
        expect(near, `${k} ${dir} facing ${facing}`).toBeLessThan(a.area.r + 0.15);
      }
    }
  });

  it('tumble is one rigid spin: the pieces keep their distances at rest', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, rest = restPieces(L), out = L.segments.map(() => new Matrix4());
      const at = (m: Matrix4[]) => m.map((x) => new Vector3().setFromMatrixPosition(x));
      const r = at(rest);
      for (const c of clips(STATS[k]).filter((x) => x.name === 'tumble')) {
        let worst = 0;
        for (const t of samples(c)) {
          const p = at(poseSegments(L, c.at(t), out));
          for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++)
            worst = Math.max(worst, Math.abs(p[i].distanceTo(p[j]) - r[i].distanceTo(r[j])));
        }
        expect(worst, k).toBeLessThan(1e-3);
      }
    }
  });

  it('hanging from a vine raises the arms overhead (hands by the box top), where the air pose has them lower', () => {
    const L = STATS.fists.layout, out = L.segments.map(() => new Matrix4());
    const arm = L.segments.map((g, i) => ({ g, i })).filter(({ g }) => g.kind === 'arm' || g.kind === 'hand');
    expect(arm.length).toBeGreaterThan(0);
    const top = (hang: boolean) => {
      const e = ends(L, poseSegments(L, state('punch', { action: 'air', t: 10, vel: { x: 2, y: 0 }, ground: false, hang }), out));
      return Math.max(...arm.map(({ i }) => Math.max(e[i].a.y, e[i].b.y)));
    };
    const box = STATS.fists.h;
    expect(top(true)).toBeGreaterThan(top(false) + 0.1);
    expect(top(true)).toBeGreaterThan(AT.y + 0.9 * box); // up at the grip
  });

  it('the tumble turns the body with its spin, round the stage axis', () => {
    const L = STATS.fists.layout, out = L.segments.map(() => new Matrix4());
    const head = L.segments.findIndex((g) => g.kind === 'head');
    const headAt = (spin: number) => new Vector3().setFromMatrixPosition(
      poseSegments(L, state('punch', { action: 'tumble', t: 3, len: 30, spin, ground: false }), out)[head]);
    const up = headAt(0), down = headAt(Math.PI);
    expect(up.y).toBeGreaterThan(down.y + 0.5); // upside down
    expect(Math.abs(up.z - down.z)).toBeLessThan(0.3); // turned in the stage's plane, not toward the camera
  });

  it('faces its way, turned toward the camera, standing on the box', () => {
    const L = STATS.fists.layout, out = L.segments.map(() => new Matrix4());
    const head = L.segments.findIndex((g) => g.kind === 'head');
    for (const facing of [1, -1] as const) {
      poseSegments(L, state('punch', { facing }), out);
      const q = out[0].clone().multiply(restPieces(L)[0].clone().invert());
      const fwd = new Vector3(0, 0, 1).transformDirection(q);
      expect(Math.sign(fwd.x)).toBe(facing);
      expect(Math.acos(Math.abs(fwd.x)) * (180 / Math.PI)).toBeCloseTo(25, 0);
      expect(fwd.z).toBeGreaterThan(0); // toward the camera
      const h = new Vector3().setFromMatrixPosition(out[head]);
      expect(Math.abs(h.x - AT.x)).toBeLessThan(0.3);
    }
  });

  it('a zero-length wind-up, strike or cool-down never gives a broken pose', () => {
    for (const k of KINDS) {
      const stats = STATS[k], L = stats.layout, out = L.segments.map(() => new Matrix4());
      for (const dir of DIRS) {
        const a0 = attackFor(stats.move, dir, stats);
        for (const a of [{ ...a0, windup: 0 }, { ...a0, active: 0 }, { ...a0, cool: 0 }, { ...a0, windup: 0, active: 0, cool: 0 }]) {
          for (const t of [0, 0.5, 1, a.windup, a.windup + a.active, a.windup + a.active + a.cool, 30]) {
            poseSegments(L, state(stats.move, { action: 'attack', t, len: a.windup + a.active + a.cool, attack: a, attackDir: dir, ground: dir !== 'air' }), out);
            expect(out.every((m) => m.elements.every(Number.isFinite)), `${k} ${dir} t=${t}`).toBe(true);
          }
        }
      }
    }
  });

  it('a held creature lies flat over the head, held together; a special or a throw stays near its box', () => {
    for (const k of KINDS) {
      const L = STATS[k].layout, rest = restPieces(L), out = L.segments.map(() => new Matrix4());
      const at = (m: Matrix4[]) => m.map((x) => new Vector3().setFromMatrixPosition(x));
      for (const facing of [1, -1] as const) {
        const p = at(poseSegments(L, state(STATS[k].move, { action: 'held', t: 7, facing, ground: false }), out));
        const r = at(rest);
        // lying: wider than tall, about as long as it stands tall
        const xs = p.map((v) => v.x), ys = p.map((v) => v.y), rys = r.map((v) => v.y);
        const span = (v: number[]) => Math.max(...v) - Math.min(...v);
        expect(span(xs), `${k} facing ${facing}`).toBeGreaterThan(span(ys) * 0.9);
        expect(span(xs), `${k} facing ${facing}`).toBeGreaterThan(span(rys) * 0.6);
      }
      for (const c of clips(STATS[k]).filter((x) => /special|throw|grab/.test(x.name))) {
        for (const t of samples(c)) {
          const ps = at(poseSegments(L, c.at(t), out));
          const far = Math.max(...ps.map((v) => Math.hypot(v.x - AT.x, v.y - AT.y - STATS[k].h / 2)));
          expect(far, `${k} ${c.name} t=${t.toFixed(1)}`).toBeLessThan(STATS[k].h * 1.6 + STATS[k].reach);
        }
      }
    }
  });

  it('allocates nothing per call when given out', () => {
    const L = STATS.tail.layout, out = L.segments.map(() => new Matrix4());
    const all = clips(STATS.tail);
    const states = all.flatMap((c) => samples(c).map((t) => c.at(t)));
    for (const st of states) poseSegments(L, st, out); // first calls may set up per-body data
    made.n = 0;
    for (const st of states) expect(poseSegments(L, st, out)).toBe(out);
    expect(made.n).toBe(0);
  });

  it('Grow Juice: a grown look is the same pose 1.6× as big, feet on the box bottom, its weapon reaching the grown hit area', () => {
    const k = 1.6;
    const top = (e: ReturnType<typeof ends>) => Math.max(...e.map(({ a, b }) => Math.max(a.y, b.y)));
    for (const kind of KINDS) {
      const stats = STATS[kind], L = stats.layout, out = L.segments.map(() => new Matrix4());
      const small = top(ends(L, poseSegments(L, state(stats.move, {}), out)));
      const big = ends(L, poseSegments(L, state(stats.move, { scale: k }), out));
      expect(Math.abs(lowest(big) - AT.y), kind).toBeLessThan(0.03);
      expect(top(big) - AT.y, kind).toBeCloseTo((small - AT.y) * k, 2);
      // the forward swing aimed at a hit area 1.6× as far, as a grown body's attacks are
      const a = attackFor(stats.move, 'forward', stats);
      const g = { ...a, area: { dx: a.area.dx * k, dy: a.area.dy * k, r: a.area.r * k } };
      const st = state(stats.move, { action: 'attack', t: g.windup + g.active / 2, len: g.windup + g.active + g.cool, attack: g, attackDir: 'forward', scale: k });
      const cx = AT.x + g.area.dx, cy = AT.y + g.area.dy;
      const near = Math.min(...ends(L, poseSegments(L, st, out)).filter((e) => e.g.weapon)
        .flatMap(({ a: p, b: q }) => [Math.hypot(p.x - cx, p.y - cy), Math.hypot(q.x - cx, q.y - cy)]));
      expect(near, kind).toBeLessThan(g.area.r + 0.15 * k);
    }
  });
});

describe('animState', () => {
  const stats = STATS.fists;

  it('reads a fighter: action, time, facing, place, move and attack', () => {
    const f = new StageFighter('a', stats, { x: 1, y: 2 });
    f.action = 'attack';
    f.actionT = 6;
    f.actionLen = 27;
    f.facing = -1;
    f.attack = attackFor('punch', 'up', stats);
    f.attackDir = 'up';
    f.mover.vel.x = 3;
    const out = animState(f);
    expect(out).toMatchObject({ action: 'attack', t: 6, len: 27, facing: -1, pos: { x: 1, y: 2 }, vel: { x: 3, y: 0 }, move: 'punch', attackDir: 'up', ground: false });
    expect(out.attack).toBe(f.attack);
    // into the same object, which keeps its own pos and vel
    const pos = out.pos;
    f.mover.pos.x = 5;
    expect(animState(f, out)).toBe(out);
    expect(out.pos).toBe(pos);
    expect(out.pos.x).toBe(5);
  });

  it('a land squashes most at touch-down and eases off; a tumble spins on with time', () => {
    const f = new StageFighter('a', stats, { x: 0, y: 0 });
    f.action = 'land';
    f.actionLen = 5;
    f.actionT = 0;
    expect(animState(f).land).toBeCloseTo(1, 9);
    f.actionT = 4;
    const late = animState(f).land;
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(0.5);
    f.action = 'tumble';
    f.actionLen = 30;
    f.actionT = 2;
    const a = animState(f).spin;
    f.actionT = 10;
    expect(Math.abs(animState(f).spin)).toBeGreaterThan(Math.abs(a));
    f.action = 'idle';
    expect(animState(f)).toMatchObject({ land: 0, spin: 0 });
  });

  it('reads a hold and a throw: holding someone, and which way the throw goes', () => {
    const f = new StageFighter('a', stats, { x: 0, y: 0 });
    f.action = 'grab';
    expect(animState(f).holding).toBe(false);
    f.holding = new StageFighter('b', stats, { x: 1, y: 0 });
    expect(animState(f).holding).toBe(true);
    f.action = 'throw';
    f.throwDir = 'up';
    expect(animState(f).throwUp).toBe(true);
    f.throwDir = 'forward';
    expect(animState(f).throwUp).toBe(false);
  });

  it('a frozen fighter holds the pose of what it was doing', () => {
    const f = new StageFighter('a', stats, { x: 0, y: 0 });
    f.action = 'run';
    f.setFrozen(true);
    expect(animState(f).action).toBe('run');
  });
});

/** An import of Rapier or the ring's physics in any form. */
const PHYSICS_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"`](?:@dimforge|[^'"`]*physics\/(?:ragdoll|world))/;

describe('src/anim', () => {
  it('uses no physics: neither Rapier nor the ragdoll', () => {
    expect("import { Ragdoll } from '../physics/ragdoll';").toMatch(PHYSICS_IMPORT);
    expect("import RAPIER from '@dimforge/rapier3d-compat';").toMatch(PHYSICS_IMPORT);
    expect("import type { BodyLayout } from '../physics/layout';").not.toMatch(PHYSICS_IMPORT);
    const dir = join(__dirname, '../../src/anim');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(PHYSICS_IMPORT);
  });
});
