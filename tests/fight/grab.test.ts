import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, test } from 'vitest';
import { addArenaColliders } from '../../src/arena/colliders';
import { buildSkeleton } from '../../src/builder/skeleton';
import { Brain } from '../../src/fight/brain';
import { Fighter, type FightCtx, type Hit } from '../../src/fight/fighter';
import { planFor } from '../../src/fight/moves';
import { Muscles } from '../../src/fight/muscles';
import {
  CARRY_S, GRAB_S, QUICK_S, THROW_MAX, THROW_OUT, THROW_UP, THROW_WOBBLE, comVel, throwsOut, type StuntCue,
} from '../../src/fight/stunts';
import { MOVE_POWER, TUNE } from '../../src/fight/tune';
import { ragdollLayout } from '../../src/physics/layout';
import { createWorld, initPhysics } from '../../src/physics/world';
import { mulberry32 } from '../../src/util/rng';
import { loadFixture } from '../fixtures/fighters';

/** Grab and throw (design 2026-11-14 §4): lifted overhead, carried toward the edge, thrown. */

beforeAll(initPhysics);

const DT = 1 / 60;

function ring(): RAPIER.World {
  const w = createWorld(TUNE.gravity);
  addArenaColliders(w, TUNE);
  return w;
}

function fighter(w: RAPIER.World, kind: string, at: Vector3, yaw = 0, seed = 1): Fighter {
  const recipe = loadFixture(kind);
  const sk = buildSkeleton(recipe);
  const plan = planFor(recipe, sk);
  const f = new Fighter(`${kind}-${seed}`, w, ragdollLayout(sk, plan), plan, { tune: TUNE, rng: mulberry32(seed) });
  f.ragdoll.pose(at, yaw);
  f.state = 'fighting';
  return f;
}

const yawTo = (a: Vector3, b: Vector3) => Math.atan2(b.x - a.x, b.z - a.z);
const level = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * `thinkers` think and the world steps for `secs`; `standers` are held standing by their own muscles (no brain);
 * `each` sees every tick's hits and stunt cues (true stops). Returns the time reached.
 */
function run(w: RAPIER.World, thinkers: Fighter[], secs: number, o: {
  from?: number; standers?: Fighter[]; each?: (t: number, hits: Hit[], cues: StuntCue[]) => void | boolean;
} = {}): number {
  const ctx: FightCtx = { others: [...thinkers, ...(o.standers ?? [])], boast: false, tune: TUNE, rng: mulberry32(7) };
  const holds = (o.standers ?? []).map((f) => ({ f, m: new Muscles(f.ragdoll, f.layout) }));
  let t = o.from ?? 0;
  const end = t + secs;
  while (t < end - 1e-9) {
    const hits = thinkers.flatMap((f) => f.think(DT, t, ctx));
    for (const { f, m } of holds) {
      if (f.stun > 0 || f.flying || f.held || !f.ragdoll.pieces.length) continue;
      m.hover(DT, 1, new Vector3(), TUNE.gravity);
      m.stand(DT, 1, new Vector3(0, 0, 1), TUNE.gravity);
      m.brace(DT, 1, null, TUNE);
    }
    w.step();
    t += DT;
    const cues = thinkers.flatMap((f) => f.takeStuntCues());
    if (o.each?.(t, hits, cues) === true) break;
  }
  return t;
}

/** A thrower (`kind`) at `at` facing a wobbly foe (`foeKind`) just in front of it, both standing still for a moment. */
function pair(kind = 'fists', foeKind = 'tiny', at = new Vector3(2, 0, 0), wobble = 10) {
  const w = ring();
  const foeAt = at.clone().add(new Vector3(0, 0, 0.9));
  const a = fighter(w, kind, at, yawTo(at, foeAt), 1);
  const b = fighter(w, foeKind, foeAt, yawTo(foeAt, at), 2);
  b.wobble = wobble;
  run(w, [], 0.3, { standers: [a, b] }); // settle on their feet
  return { w, a, b };
}

describe('grab', () => {
  test.each(['fists', 'blob', 'tiny', 'legs', 'wings', 'tail', 'horns'])('%s lifts its foe overhead, carries it toward the edge and throws it', (kind) => {
    const { w, a, b } = pair(kind, 'fists');
    const start = a.ragdoll.pos(), wobble0 = b.wobble, hits0 = a.hits;
    expect(b.grabbable).toBe(true);
    expect(a.tryStunt({ name: 'grab', foe: b, steps: 3 })).toBe(true);
    expect(a.stunt).toBe('grab');
    expect(a.holding).toBe(true);
    expect(b.heldBy).toBe(a);
    const cues: StuntCue[] = [];
    let overhead = Infinity, thrownAt = -1, throwHit: Hit | null = null, flat = 0;
    let carried = start.clone();
    run(w, [a, b], 2.5, {
      from: 0.3,
      each: (t, hits, cs) => {
        cues.push(...cs);
        if (b.held && t > 0.3 + GRAB_S + 0.05) {
          // lying flat over the thrower's head: above its top, its body's up turned to the level
          const top = a.ragdoll.pos().y - a.layout.standHeight + a.layout.ringHeight;
          overhead = Math.min(overhead, b.ragdoll.pos().y - top);
          const r = b.ragdoll.torso.body.rotation();
          const up = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(r.x, r.y, r.z, r.w).multiply(b.ragdoll.torso.restQ.clone().invert()));
          flat = Math.max(flat, Math.abs(up.y));
          expect(level(b.ragdoll.pos(), a.ragdoll.pos()), 'over its head').toBeLessThan(0.2);
          carried = a.ragdoll.pos();
        }
        const h = hits.find((x) => x.target === b);
        if (h && thrownAt < 0) { thrownAt = t; throwHit = h; }
      },
    });
    expect(overhead, 'held above the thrower’s head').toBeGreaterThan(0);
    expect(flat, 'lying flat').toBeLessThan(0.3);
    // its cues: grab start (on whom), grab end, throw start, throw end
    const mine = cues.filter((c) => c.id === a.id && (c.stunt === 'grab' || c.stunt === 'throw')).map((c) => `${c.stunt} ${c.phase}`);
    expect(mine).toEqual(['grab start', 'grab end', 'throw start', 'throw end']);
    expect(cues.find((c) => c.stunt === 'grab' && c.phase === 'start')!.other).toBe(b.id);
    // thrown after the grab and the carry, as a big hit counted as the thrower's
    expect(thrownAt - 0.3).toBeGreaterThan(GRAB_S + CARRY_S - 0.05);
    expect(thrownAt - 0.3).toBeLessThan(GRAB_S + CARRY_S + 0.1);
    expect(throwHit!.reaction).toBe('big');
    // a blow of its own move's power
    expect(throwHit!.power).toBeCloseTo(MOVE_POWER[a.move] * TUNE.knock);
    // (grabbed inside the ring: tossed back across it, no faster than the design's throw)
    const out = Math.min(THROW_MAX, THROW_OUT + THROW_WOBBLE * wobble0);
    expect(throwHit!.launch).toBeLessThanOrEqual(Math.hypot(out, THROW_UP) + 1e-6);
    expect(throwHit!.launch).toBeGreaterThan(THROW_UP);
    expect(a.hits).toBe(hits0 + 1);
    // its wobble grew by the throw's power (less a little healing while it was held)
    expect(b.wobble).toBeGreaterThan(wobble0 + MOVE_POWER[a.move] * TUNE.knock - 0.1);
    // the carry went outward (toward the nearest edge)
    const outward = new Vector3(start.x, 0, start.z).normalize();
    expect(carried.clone().sub(start).setY(0).dot(outward), 'stepped toward the edge').toBeGreaterThan(0.3);
    expect(b.held).toBe(false);
    expect(a.standUps + b.standUps).toBe(0);
  });

  /** Thrown: its whole body's velocity the tick it is let go, then where it came down (or that it went out). */
  function throwOf(foeKind: string, wobble: number, at = new Vector3(1.5, 0, 0)) {
    const { w, a, b } = pair('fists', foeKind, at, wobble);
    const r0 = Math.hypot(b.ragdoll.pos().x, b.ragdoll.pos().z);
    a.tryStunt({ name: 'grab', foe: b, steps: 2 });
    let v: Vector3 | null = null, down: Vector3 | null = null, out = false, thrown = false;
    run(w, [a, b], 5, {
      from: 0.3,
      each: (_t, hits) => {
        if (!v && hits.some((h) => h.target === b)) { v = comVel(b.ragdoll, new Vector3()); thrown = b.thrown && b.flying && b.reaction === 'big'; return; }
        const p = b.ragdoll.pos();
        if (v && Math.hypot(p.x, p.z) > TUNE.ringRadius + 0.5) { out = true; return true; }
        if (v && !b.flying && !down) { down = p; return true; }
      },
    });
    return { v: v as Vector3 | null, down: down as Vector3 | null, out, thrown, r0 };
  }

  test('a foe grabbed near the ropes (within the edge margin) is thrown out over them: out, up, tumbling, a big reaction', () => {
    const r = throwOf('tiny', 30, new Vector3(TUNE.ringRadius - TUNE.edgeMargin + 0.5, 0, 0));
    expect(throwsOut({ x: r.r0, z: 0 }, TUNE)).toBe(true);
    expect(r.v).not.toBeNull();
    expect(r.thrown).toBe(true);
    const want = Math.min(THROW_MAX, THROW_OUT + THROW_WOBBLE * 30);
    expect(r.v!.x, 'outward (+x: the nearest edge)').toBeGreaterThan(want * 0.9);
    expect(r.v!.y).toBeGreaterThan(THROW_UP * 0.8);
    expect(r.out, 'over the ropes').toBe(true);
  });

  test.each(['tiny', 'blob', 'fists'])('a %s grabbed inside the ring is tossed back across it, landing inside it', (kind) => {
    const r = throwOf(kind, 30, new Vector3(2.5, 0, 0));
    expect(throwsOut({ x: r.r0, z: 0 }, TUNE)).toBe(false);
    expect(r.thrown).toBe(true);
    expect(r.v!.x, 'inward (back over the thrower’s head)').toBeLessThan(-3);
    expect(r.out).toBe(false);
    expect(r.down).not.toBeNull();
    expect(r.down!.x, 'across the middle').toBeLessThan(0);
    expect(Math.hypot(r.down!.x, r.down!.z), 'inside the ring').toBeLessThan(TUNE.ringRadius);
  });

  test('a held fighter does not think, cannot be hit, and nobody targets it', () => {
    const { w, a, b } = pair('fists', 'tiny');
    // a third fighter right beside them, swinging at whoever is nearest
    const c = fighter(w, 'legs', new Vector3(2.8, 0, 0.5), -Math.PI / 2, 3);
    a.tryStunt({ name: 'grab', foe: b, steps: 2 });
    const was = b.special.meter;
    const onB: Hit[] = [];
    run(w, [a, b, c], GRAB_S + QUICK_S - 0.05, {
      from: 0.3,
      each: (_t, hits) => { onB.push(...hits.filter((h) => h.target === b)); },
    });
    expect(b.held).toBe(true);
    expect(onB).toEqual([]);
    expect(b.special.meter).toBe(was);
    expect(b.attack).not.toBe('windup');
  });

  test('another foe close by: a quick throw, no steps', () => {
    const { w, a, b } = pair('fists', 'tiny', new Vector3(1, 0, 0));
    const c = fighter(w, 'blob', new Vector3(1, 0, -1.4), 0, 3);
    const start = a.ragdoll.pos();
    a.tryStunt({ name: 'grab', foe: b, steps: 3 });
    let thrownAt = -1;
    run(w, [a, b], 1.5, {
      from: 0.3, standers: [c],
      each: (t, hits) => { if (hits.some((h) => h.target === b)) { thrownAt = t; return true; } },
    });
    expect(thrownAt - 0.3).toBeLessThan(GRAB_S + QUICK_S + 0.1);
    expect(level(a.ragdoll.pos(), start), 'it stayed').toBeLessThan(0.35);
  });

  test('a thrower that takes a pop or big hit drops the held fighter: it falls, stunned a moment, solid again', () => {
    const { w, a, b } = pair('fists', 'tiny');
    a.tryStunt({ name: 'grab', foe: b, steps: 2 });
    run(w, [a, b], GRAB_S + 0.2, { from: 0.3 });
    expect(b.held).toBe(true);
    // a big blow on the thrower from the side
    a.wobble = 30;
    const r = a.knock(a.ragdoll.pos().add(new Vector3(-1, 0, 0)), 2.5 * TUNE.knock);
    expect(r!.reaction === 'pop' || r!.reaction === 'big').toBe(true);
    expect(a.stunt).toBeNull();
    expect(b.held).toBe(false);
    expect(b.stun).toBeGreaterThan(0.4);
    const y0 = b.ragdoll.pos().y;
    run(w, [a, b], 1.5, { from: 1 });
    expect(b.ragdoll.pos().y, 'it fell').toBeLessThan(y0 - 0.3);
    expect(b.ragdoll.pos().y, 'onto the ring, not through it').toBeGreaterThan(0);
    expect(b.state).toBe('fighting');
  });

  test('a stagger does not break the hold', () => {
    const { w, a, b } = pair('blob', 'tiny');
    a.tryStunt({ name: 'grab', foe: b, steps: 2 });
    run(w, [a, b], GRAB_S + 0.1, { from: 0.3 });
    const r = a.knock(a.ragdoll.pos().add(new Vector3(-1, 0, 0)), 0.2 * TUNE.knock);
    expect(r!.reaction).toBe('stagger');
    expect(b.held).toBe(true);
    expect(a.stunt).toBe('grab');
  });

  test('the hold ends cleanly when either leaves the ring or is let go, and at the crowning', () => {
    // the thrower is ruled out: its foe is dropped
    let { w, a, b } = pair();
    a.tryStunt({ name: 'grab', foe: b });
    run(w, [a, b], 0.4, { from: 0.3 });
    a.state = 'out';
    expect(b.held).toBe(false);
    expect(b.stun).toBeGreaterThan(0);
    // the held fighter is let go (its body leaves the world): the grab just ends, nothing thrown
    ({ w, a, b } = pair());
    a.tryStunt({ name: 'grab', foe: b });
    run(w, [a, b], 0.4, { from: 0.3 });
    b.dispose();
    const cues: StuntCue[] = [];
    const hits: Hit[] = [];
    run(w, [a], 0.2, { from: 0.7, each: (_t, h, c) => { cues.push(...c); hits.push(...h); } });
    expect(a.stunt).toBeNull();
    expect(cues.map((c) => `${c.stunt} ${c.phase}`)).toEqual(['grab end']);
    expect(hits).toEqual([]);
    // the thrower is let go: its foe is dropped
    ({ w, a, b } = pair());
    a.tryStunt({ name: 'grab', foe: b });
    run(w, [a, b], 0.4, { from: 0.3 });
    a.dispose();
    expect(b.held).toBe(false);
    // the crowning ends any hold (either side)
    ({ w, a, b } = pair());
    a.tryStunt({ name: 'grab', foe: b });
    run(w, [a, b], 0.4, { from: 0.3 });
    b.endHold();
    expect(b.held).toBe(false);
    expect(a.stunt).toBeNull();
  });

  test('a grab needs a grabbable foe, its cool-down over, and may not start while held or holding', () => {
    const { w, a, b } = pair();
    const c = fighter(w, 'blob', new Vector3(-2, 0, 0), 0, 3);
    a.tryStunt({ name: 'grab', foe: b });
    expect(b.mayStunt()).toBe(false);
    expect(b.grabbable).toBe(false);
    expect(a.grabbable, 'nobody grabs a thrower').toBe(false);
    expect(c.tryStunt({ name: 'grab', foe: b }), 'nobody grabs a held fighter').toBe(false);
    run(w, [a, b], 2, { from: 0.3 });
    expect(a.stunt).toBeNull();
    // thrown: its cool-down (10–16 s) is on
    run(w, [a, b], 1.5, { from: 2.3 });
    const d = fighter(w, 'tiny', a.ragdoll.pos().setY(0).add(new Vector3(0, 0, 0.8)), 0, 4);
    run(w, [], 0.5, { from: 3.8, standers: [a, d] });
    expect(d.grabbable).toBe(true);
    expect(a.tryStunt({ name: 'grab', foe: d }), 'cooling down').toBe(false);
    // a flier cannot be grabbed
    d.knock(d.ragdoll.pos().add(new Vector3(-1, 0, 0)), 3 * TUNE.knock);
    expect(d.grabbable).toBe(false);
  });
});

describe('the brain grabs', () => {
  type R = { state: string; ragdoll: { pos(): Vector3 }; flying: boolean; attack: 'none'; reach: number; held: boolean; grabbable: boolean; wobble: number };
  const rival = (at: Vector3, wobble: number, grabbable = true): R => ({
    state: 'fighting', ragdoll: { pos: () => at.clone() }, flying: false, attack: 'none', reach: 1, held: false, grabbable, wobble,
  });
  const me = { reach: 1.5, ringHeight: 1.4, grab: true };

  /** The brain's picks over `secs` of looks at `tg` from the middle. */
  function picks(tg: R, self = me, secs = 20): string[] {
    const b = new Brain<R>('x', 2), rng = mulberry32(5), out: string[] = [];
    b.breath(-10);
    for (let t = 0; t < secs; t += DT) {
      b.blow(t); // never eager
      const o = b.pickStunt(new Vector3(0, 1, 0), t, [tg], false, self, TUNE.ringRadius, TUNE.edgeMargin, rng, true);
      if (o) out.push(o.name);
    }
    return out;
  }

  test('a wobbly foe within 0.9 × its reach, on its feet: grabbed, by chance a look', () => {
    expect(picks(rival(new Vector3(1.2, 0, 0), 8))).toContain('grab');
  });
  test('not a fresh foe, one out of grab range, one not on its feet, nor with its cool-down on', () => {
    expect(picks(rival(new Vector3(1.2, 0, 0), 7.9))).not.toContain('grab');
    expect(picks(rival(new Vector3(1.4, 0, 0), 20))).not.toContain('grab');
    expect(picks(rival(new Vector3(1.2, 0, 0), 20, false))).not.toContain('grab');
    expect(picks(rival(new Vector3(1.2, 0, 0), 20), { ...me, grab: false })).not.toContain('grab');
  });
  test('a held foe is nobody’s target', () => {
    const b = new Brain<R>('x', 2), rng = mulberry32(5);
    const held = { ...rival(new Vector3(1.2, 0, 0), 20), held: true }, other = rival(new Vector3(-3, 0, 0), 0);
    b.steer(new Vector3(0, 1, 0), 0, [held, other], false, 1.5, TUNE.ringRadius, TUNE.edgeMargin, rng);
    b.target = held as R;
    b.steer(new Vector3(0, 1, 0), 0.1, [held, other], false, 1.5, TUNE.ringRadius, TUNE.edgeMargin, rng);
    expect(b.target).toBe(other);
  });
});
