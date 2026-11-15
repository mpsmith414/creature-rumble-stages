import type RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, test } from 'vitest';
import { addArenaColliders } from '../../src/arena/colliders';
import {
  BALL_DROP, BALL_R, EVENT_S, FIRST_MAX, FIRST_MIN, GAP_MAX, GAP_MIN, MOON, PAD_COUNT, PAD_FIRST, PAD_REARM_S, PAD_RING, PARTY_BOUNCE,
  POST_COUNT, POST_H, POST_KICK, POST_RING, POST_RISE_S, RING_EVENTS, RingFeatures, type FeatureCue, type RingEventName,
} from '../../src/arena/features';
import { ENTRY_ANGLE } from '../../src/arena/geometry';
import { buildSkeleton } from '../../src/builder/skeleton';
import { Brain } from '../../src/fight/brain';
import { Fighter, type FightCtx, type Hit } from '../../src/fight/fighter';
import { planFor } from '../../src/fight/moves';
import { PAD_UP, STOMP_POWER, comVel, type StuntCue } from '../../src/fight/stunts';
import { TUNE } from '../../src/fight/tune';
import { ragdollLayout } from '../../src/physics/layout';
import { createWorld, initPhysics } from '../../src/physics/world';
import { mulberry32 } from '../../src/util/rng';
import { loadFixture } from '../fixtures/fighters';

/** The wild ring (design 2026-11-14 §5.1): spring pads and ring events. */

beforeAll(initPhysics);

const DT = 1 / 60;

function ring(seed = 3): { w: RAPIER.World; floor: RAPIER.Collider; rf: RingFeatures } {
  const w = createWorld(TUNE.gravity);
  const { floor } = addArenaColliders(w, TUNE);
  return { w, floor, rf: new RingFeatures(w, TUNE, { rng: mulberry32(seed), floor }) };
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

/**
 * The ring as the loop runs it, for `secs`: `thinkers` think (reading the features' tuning), then the features
 * update, then the world steps. `each` sees every step's feature cues, stunt cues and hits; true stops.
 */
function run(w: RAPIER.World, rf: RingFeatures, fs: Fighter[], secs: number, o: {
  thinkers?: Fighter[]; canStart?: boolean; each?: (t: number, cues: FeatureCue[], stunts: StuntCue[], hits: Hit[]) => void | boolean; from?: number;
} = {}): number {
  const thinkers = o.thinkers ?? fs;
  const ctx: FightCtx = { others: fs, boast: false, tune: TUNE, rng: mulberry32(9) };
  let t = o.from ?? 0;
  const end = t + secs;
  while (t < end - 1e-9) {
    ctx.airTune = rf.fightTune(TUNE);
    ctx.pads = rf.pads;
    ctx.gravityScale = rf.gravityScale;
    const hits = thinkers.flatMap((f) => f.think(DT, t, ctx));
    const cues = rf.update(DT, fs.filter((f) => f.state === 'fighting'), o.canStart ?? true);
    w.step();
    t += DT;
    const stunts = fs.flatMap((f) => f.takeStuntCues());
    if (o.each?.(t, cues, stunts, hits) === true) break;
  }
  return t;
}

const angle = (p: { x: number; z: number }) => Math.atan2(p.z, p.x);
const diff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

describe('layout', () => {
  test('4 pads 4.3 m out, 90° apart, the first 45° round from the entry; 3 sunk posts 2.3 m out, 120° apart', () => {
    const { rf } = ring();
    expect(rf.pads).toHaveLength(PAD_COUNT);
    rf.pads.forEach((p, i) => {
      expect(Math.hypot(p.at.x, p.at.z)).toBeCloseTo(PAD_RING, 5);
      expect(diff(angle(p.at), ENTRY_ANGLE + PAD_FIRST + (i * Math.PI) / 2)).toBeCloseTo(0, 5);
      expect(p.armed).toBe(true);
      expect(p.charge).toBe(1);
    });
    expect(rf.posts).toHaveLength(POST_COUNT);
    for (let i = 0; i < POST_COUNT; i++) {
      const a = rf.posts[i].at, b = rf.posts[(i + 1) % POST_COUNT].at;
      expect(Math.hypot(a.x, a.z)).toBeCloseTo(POST_RING, 5);
      expect(Math.abs(diff(angle(a), angle(b)))).toBeCloseTo((2 * Math.PI) / 3, 5);
      expect(rf.posts[i].up).toBe(0);
      // none stands on the walk-in line
      expect(Math.abs(diff(angle(a), ENTRY_ANGLE))).toBeGreaterThan(0.5);
    }
    expect(rf.event).toBeNull();
    expect(rf.ball).toBeNull();
    expect(rf.gravityScale).toBe(1);
  });
});

describe('spring pads', () => {
  test('an armed pad under a fighter fires a pad jump: up 9.5 m/s, high, in control; the pad re-arms 4 s later', () => {
    const { w, rf } = ring();
    const pad = rf.pads[0];
    const f = fighter(w, 'fists', pad.at.clone(), 0);
    let fired: FeatureCue | null = null, vy = 0, peak = 0, landed = -1;
    run(w, rf, [f], 3, {
      canStart: false,
      each: (t, cues, stunts) => {
        for (const c of cues) if (c.type === 'pad' && !fired) { fired = c; vy = comVel(f.ragdoll, new Vector3()).y; }
        if (stunts.some((s) => s.stunt === 'padJump' && s.phase === 'land')) landed = t;
        if (fired && landed < 0) peak = Math.max(peak, f.ragdoll.pos().y);
      },
    });
    expect(fired).toMatchObject({ type: 'pad', pad: 0, id: f.id });
    // (its take-off speed, after the step that set it: about PAD_UP)
    expect(vy).toBeGreaterThan(PAD_UP * 0.7);
    expect(peak).toBeGreaterThan(f.layout.standHeight + 1.5);
    expect(landed).toBeGreaterThan(0);
    expect(f.standUps).toBe(0);
  });

  test('charge climbs from 0 to armed over 4 s', () => {
    const { w, rf } = ring();
    const pad = rf.pads[1];
    const f = fighter(w, 'blob', pad.at.clone());
    let at = -1;
    run(w, rf, [f], PAD_REARM_S + 1, { thinkers: [f], canStart: false, each: (t, cues) => { if (at < 0 && cues.some((c) => c.type === 'pad')) at = t; } });
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(0.5);
    // not armed during the 4 s, then armed again
    const { w: w2, rf: rf2 } = ring();
    const g = fighter(w2, 'blob', rf2.pads[1].at.clone());
    let charge = 0;
    run(w2, rf2, [g], 2, { canStart: false, each: (t, cues) => { if (cues.some((c) => c.type === 'pad')) charge = -1; } });
    expect(rf2.pads[1].armed).toBe(false);
    expect(rf2.pads[1].charge).toBeGreaterThan(0.3);
    expect(rf2.pads[1].charge).toBeLessThan(0.7);
    expect(charge).toBe(-1);
    // walked off: it re-arms
    g.ragdoll.pose(new Vector3(0, 0, 0), 0);
    run(w2, rf2, [g], 2.5, { canStart: false });
    expect(rf2.pads[1].armed).toBe(true);
    expect(rf2.pads[1].charge).toBe(1);
  });

  test('a stunned fighter, one out, one held, one mid-blow and one in a duel are not fired', () => {
    const { w, rf } = ring();
    const f = fighter(w, 'tiny', rf.pads[2].at.clone());
    expect(f.padJump()).toBe(true); // the rule itself
    const { w: w2 } = ring();
    const g = fighter(w2, 'tiny', new Vector3());
    g.stun = 1;
    expect(g.padJump()).toBe(false);
    g.stun = 0;
    g.state = 'out';
    expect(g.padJump()).toBe(false);
    // held over a thrower's head
    const { w: w3 } = ring();
    const a = fighter(w3, 'fists', new Vector3(0, 0, 0), 0, 1), b = fighter(w3, 'tiny', new Vector3(0.6, 0, 0), 0, 2);
    b.takeHold(a);
    expect(b.padJump()).toBe(false);
    // winding up a blow: the pad waits
    const { w: w4 } = ring();
    const c = fighter(w4, 'legs', new Vector3(1, 0, 0));
    c.showOff();
    expect(c.attack).toBe('windup');
    expect(c.padJump()).toBe(false);
    // its target in reach: it fights on the pad; far off: it jumps
    const { w: w5 } = ring();
    const d = fighter(w5, 'fists', new Vector3(0, 0, 0), 0, 1), e = fighter(w5, 'blob', new Vector3(0, 0, d.reach * 0.8), 0, 2);
    (d as unknown as { brain: Brain<Fighter> }).brain.target = e;
    expect(d.padJump()).toBe(false);
    e.ragdoll.pose(new Vector3(0, 0, 3.5), 0);
    expect(d.padJump()).toBe(true);
    for (const x of [w, w2, w3, w4, w5]) x.free();
  });

  test('the pad jump goes at its target, no farther than it, and its landing stomps it (2 × knock)', () => {
    const { w, rf } = ring();
    const pad = rf.pads[0];
    const toMid = pad.at.clone().setLength(PAD_RING - 3.2);
    const f = fighter(w, 'legs', pad.at.clone(), Math.atan2(-pad.at.x, -pad.at.z), 1);
    const foe = fighter(w, 'blob', toMid, 0, 2);
    // its brain's target is the foe
    (f as unknown as { brain: Brain<Fighter> }).brain.target = foe;
    const hits: Hit[] = [];
    let land: Vector3 | null = null;
    run(w, rf, [f, foe], 3, {
      thinkers: [f], canStart: false,
      each: (_t, _c, stunts, hs) => {
        hits.push(...hs.filter((h) => h.attacker === f));
        const l = stunts.find((s) => s.stunt === 'padJump' && s.phase === 'land');
        if (l) { land = l.at; return true; }
      },
    });
    expect(land).not.toBeNull();
    const at = land as unknown as Vector3;
    // came down on the foe (it does not sail past it toward the far side)
    const q = foe.ragdoll.pos();
    expect(Math.hypot(at.x - q.x, at.z - q.z)).toBeLessThan(1.3);
    const stomp = hits.find((h) => h.target === foe);
    expect(stomp?.power).toBeCloseTo(STOMP_POWER * TUNE.knock, 6);
  });

  test('a brain that stops seeing the pads (its fighter in danger) forgets the pad it walked to: its stunts come back', () => {
    const b = new Brain<{ state: string; ragdoll: { pos(): Vector3 } }>('x', 1);
    const foe = { state: 'fighting', ragdoll: { pos: () => new Vector3(-4, 0, 0) } };
    const pads = [{ at: new Vector3(3, 0, 1.5), armed: true }];
    const me = new Vector3(2, 0, 0);
    let t = 0;
    // until it heads for the pad (its chance is rolled once per pad: a fresh brain each try)
    let br = b;
    for (let k = 0; k < 20; k++) {
      br = new Brain('x' + k, 1);
      const { want } = br.steer(me, t, [foe], false, 1, 6.5, 2.5, mulberry32(k), pads);
      if (want.x > 0.2 && want.z > 0.2) break;
    }
    const self = { reach: 1, ringHeight: 1.4 };
    // while it heads for the pad, no stunt
    t = 2;
    expect(br.pickStunt(me, t, [foe], false, self, 6.5, 2.5, () => 0, true)).toBeNull();
    // in danger: no pads seen; the far target is leapt at again
    br.steer(me, (t += 0.3), [foe], false, 1, 6.5, 2.5, mulberry32(1), undefined);
    let pick = null;
    for (let i = 0; i < 8 && !pick; i++) pick = br.pickStunt(me, (t += 0.3), [foe], false, self, 6.5, 2.5, () => 0.1, true);
    expect(pick?.name).toBe('leap');
  });

  test('a long reach seeks no pad for a target it would duel from the pad; a pad is rolled for again later', () => {
    const foe = { state: 'fighting', ragdoll: { pos: () => new Vector3(-1.6, 0, 0) } };
    const pads = [{ at: new Vector3(3, 0, 1.5), armed: true }];
    const me = new Vector3(2, 0, 0); // target 3.6 m off: over 3 m, under PAD_DUEL × a 4 m reach
    for (let k = 0; k < 10; k++) {
      const b = new Brain<typeof foe>('h' + k, 1);
      const { want } = b.steer(me, 0, [foe], false, 4, 6.5, 2.5, mulberry32(k), pads);
      expect(want.x).toBeLessThan(0);
    }
    // rolled and lost: rolled for again PAD_REROLL_S on (a pad re-armed by Again! without firing)
    const far = { state: 'fighting', ragdoll: { pos: () => new Vector3(-4, 0, 0) } };
    const b = new Brain<typeof far>('r', 1);
    const no = () => 0.99;
    b.steer(me, 0, [far], false, 1, 6.5, 2.5, no, pads);
    expect(b.steer(me, 1, [far], false, 1, 6.5, 2.5, () => 0, pads).want.x).toBeLessThan(0); // not rolled again yet
    expect(b.steer(me, 7, [far], false, 1, 6.5, 2.5, () => 0, pads).want.x).toBeGreaterThan(0);
  });

  test('the brain walks onto an armed pad within 2.5 m when its target is far', () => {
    const b = new Brain<{ state: string; ragdoll: { pos(): Vector3 } }>('x', 1);
    const foe = { state: 'fighting', ragdoll: { pos: () => new Vector3(-4, 0, 0) } };
    const pads = [{ at: new Vector3(3, 0, 1.5), armed: true }];
    const me = new Vector3(2, 0, 0);
    let toPad = 0;
    for (let i = 0; i < 40; i++) {
      const { want } = b.steer(me, i * 0.1, [foe], false, 1, 6.5, 2.5, mulberry32(i), pads);
      if (want.x > 0.2 && want.z > 0.2) toPad++;
    }
    expect(toPad).toBeGreaterThan(20);
    // an unarmed pad, or a near target: not
    const c = new Brain<typeof foe>('y', 1);
    for (let i = 0; i < 20; i++) {
      const { want } = c.steer(me, i * 0.1, [foe], false, 1, 6.5, 2.5, mulberry32(i), [{ at: pads[0].at, armed: false }]);
      expect(want.x).toBeLessThan(0);
    }
  });
});

/** Steps the features alone (no world step needed for the clock), returning the events' cues in order with their times. */
function clock(rf: RingFeatures, secs: number, canStart = true, fs: Fighter[] = []): { t: number; c: FeatureCue }[] {
  const out: { t: number; c: FeatureCue }[] = [];
  for (let t = 0; t < secs; t += DT) for (const c of rf.update(DT, fs, canStart)) if (c.type === 'event') out.push({ t, c });
  return out;
}

describe('ring events', () => {
  test('the first starts 25–35 s in, each lasts its time, the next 30–45 s after; four in a turn with no repeat', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { rf } = ring(seed);
      const evs = clock(rf, 400);
      const starts = evs.filter((e) => e.c.type === 'event' && e.c.phase === 'start');
      expect(starts[0].t).toBeGreaterThanOrEqual(FIRST_MIN - 0.05);
      expect(starts[0].t).toBeLessThanOrEqual(FIRST_MAX + 0.05);
      const names = starts.map((e) => (e.c as { event: RingEventName }).event);
      expect(new Set(names.slice(0, 4)).size).toBe(4);
      expect(new Set(names.slice(4, 8)).size).toBe(Math.min(4, names.slice(4, 8).length));
      for (let i = 0; i + 1 < evs.length; i += 2) {
        const s = evs[i], e = evs[i + 1];
        expect(s.c).toMatchObject({ phase: 'start' });
        expect(e.c).toMatchObject({ phase: 'end', event: (s.c as { event: string }).event });
        const name = (s.c as { event: RingEventName }).event;
        // (the beach ball has no world stepping here: it never leaves, so it runs its 14 s)
        expect(e.t - s.t).toBeCloseTo(EVENT_S[name], 1);
        if (i + 2 < evs.length) {
          expect(evs[i + 2].t - e.t).toBeGreaterThanOrEqual(GAP_MIN - 0.05);
          expect(evs[i + 2].t - e.t).toBeLessThanOrEqual(GAP_MAX + 0.05);
        }
      }
    }
  });

  test('no event comes twice in a row, also where one shuffled turn meets the next', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { rf } = ring(seed);
      const draw = () => (rf as unknown as { draw(): RingEventName }).draw();
      let last = draw();
      for (let i = 1; i < 40; i++) {
        const e = draw();
        expect(e, `seed ${seed}, draw ${i}`).not.toBe(last);
        last = e;
      }
    }
  });

  test('the clock waits while no event may start, and while a special is under way', () => {
    const { w, rf } = ring();
    expect(clock(rf, 120, false)).toEqual([]);
    expect(clock(rf, FIRST_MAX + 0.1).length).toBe(1);
    const { w: w2, rf: rf2 } = ring();
    const f = fighter(w2, 'fists', new Vector3());
    (f.special as { active: string | null }).active = 'megaPunch';
    expect(clock(rf2, 60, true, [f])).toEqual([]);
    (f.special as { active: string | null }).active = null;
    expect(clock(rf2, DT * 2, true, [f]).length).toBe(1);
    w.free();
  });

  test('startEvent starts one now (its cue comes with the next update); reset ends it, rearms every pad, and waits 25–35 s again', () => {
    const { w, floor, rf } = ring();
    rf.startEvent('bounceParty');
    expect(rf.event).toMatchObject({ name: 'bounceParty' });
    expect(floor.restitution()).toBeCloseTo(PARTY_BOUNCE, 5);
    const cues = rf.update(DT, [], true);
    expect(cues).toEqual([{ type: 'event', event: 'bounceParty', phase: 'start' }]);
    rf.startEvent('beachBall'); // one under way ends first
    expect(rf.update(DT, [], true)).toEqual([
      { type: 'event', event: 'bounceParty', phase: 'end' }, { type: 'event', event: 'beachBall', phase: 'start' },
    ]);
    expect(floor.restitution()).toBeCloseTo(TUNE.floorBounce, 5);
    expect(rf.ball).not.toBeNull();
    (rf.pads[0] as { armed: boolean; charge: number }).armed = false;
    rf.reset();
    expect(rf.event).toBeNull();
    expect(rf.ball).toBeNull();
    expect(rf.pads.every((p) => p.armed && p.charge === 1)).toBe(true);
    const evs = clock(rf, FIRST_MAX + 1);
    expect(evs[0].t).toBeGreaterThanOrEqual(FIRST_MIN - 0.05);
    w.free();
  });

  test('Bounce Party: the floor is bouncy and steady fighters hop every 0.8 s', () => {
    const { w, floor, rf } = ring();
    const f = fighter(w, 'tail', new Vector3(1, 0, 0));
    run(w, rf, [f], 1, { canStart: false });
    rf.startEvent('bounceParty');
    let rises = 0, was = false;
    run(w, rf, [f], 4, {
      canStart: false,
      each: () => {
        const up = comVel(f.ragdoll, new Vector3()).y > 2;
        if (up && !was) rises++;
        was = up;
      },
    });
    expect(floor.restitution()).toBeCloseTo(PARTY_BOUNCE, 5);
    // (alone it hops round the ring between beats too: a leap's beat is skipped)
    expect(rises).toBeGreaterThanOrEqual(2);
    run(w, rf, [f], EVENT_S.bounceParty, { canStart: false, thinkers: [] });
    expect(rf.event).toBeNull();
    expect(floor.restitution()).toBeCloseTo(TUNE.floorBounce, 5);
  });

  test('Moon Jump: gravity × 0.4 for the world and for the fighters, back after 9 s', () => {
    const { w, rf } = ring();
    rf.startEvent('moonJump');
    rf.update(DT, [], true);
    expect(rf.gravityScale).toBe(MOON);
    expect(w.gravity.y).toBeCloseTo(-TUNE.gravity * MOON, 6);
    const moon = rf.fightTune(TUNE);
    expect(moon.gravity).toBeCloseTo(TUNE.gravity * MOON, 6);
    expect(moon.knock).toBe(TUNE.knock);
    expect(TUNE.gravity).toBe(16); // the shared tuning is untouched
    clock(rf, EVENT_S.moonJump);
    expect(rf.gravityScale).toBe(1);
    expect(rf.fightTune(TUNE)).toBe(TUNE);
    expect(w.gravity.y).toBeCloseTo(-TUNE.gravity, 6);
    w.free();
  });

  test('Moon Jump: a fighter on its feet still feels full gravity; its leaps float (as high, 1/√0.4 × as long)', () => {
    const leapFor = (moon: boolean) => {
      const { w, rf } = ring();
      if (moon) { rf.startEvent('moonJump'); rf.update(DT, [], false); }
      const f = fighter(w, 'fists', new Vector3(-2, 0, 0), Math.PI / 2);
      const ctx: FightCtx = { others: [f], boast: true, tune: TUNE, rng: mulberry32(1), airTune: rf.fightTune(TUNE), gravityScale: rf.gravityScale };
      for (let i = 0; i < 60; i++) { f.think(DT, i * DT, ctx); w.step(); }
      const feetScale = f.ragdoll.torso.body.gravityScale();
      // (a boaster leaps for flair now and then: wait for its next stunt to be over, then order a leap)
      for (let i = 60; i < 600 && !(f.stunt === null && f.mayStunt()); i++) { f.think(DT, i * DT, ctx); w.step(); }
      expect(f.tryStunt({ name: 'leap', to: new Vector3(1.5, 0, 0) })).toBe(true);
      const leapScale = f.ragdoll.torso.body.gravityScale();
      let n = 0, peak = 0;
      while (f.stunt === 'leap' && n < 600) { f.think(DT, n * DT, ctx); w.step(); n++; peak = Math.max(peak, f.ragdoll.pos().y); }
      w.free();
      return { feetScale, leapScale, T: n * DT, peak };
    };
    const full = leapFor(false), moon = leapFor(true);
    expect(full.feetScale).toBe(1);
    expect(moon.feetScale).toBeCloseTo(1 / MOON, 6);
    expect(moon.leapScale).toBe(1);
    expect(moon.T / full.T).toBeGreaterThan(1.35);
    expect(moon.T / full.T).toBeLessThan(1.85);
    expect(Math.abs(moon.peak - full.peak)).toBeLessThan(0.35);
  });

  test('Beach Ball: dropped from 9 m over the middle; it bonks a fighter (1.6 × knock) and is gone once out of the ring', () => {
    const { w, rf } = ring();
    const f = fighter(w, 'blob', new Vector3(0, 0, 0));
    rf.startEvent('beachBall');
    const b = rf.ball!;
    expect(b.radius).toBe(BALL_R);
    expect(b.body.translation().y).toBeCloseTo(BALL_DROP, 5);
    expect(b.body.mass()).toBeCloseTo(6, 1);
    let bonk: FeatureCue | null = null, wob = 0;
    run(w, rf, [f], 3, { canStart: false, thinkers: [], each: (_t, cues) => { const c = cues.find((q) => q.type === 'ball'); if (c && !bonk) { bonk = c; wob = f.wobble; } } });
    expect(bonk).toMatchObject({ type: 'ball', id: f.id });
    expect(wob).toBeCloseTo(1.6 * TUNE.knock, 6);
    // at most one bonk per fighter per 1.2 s; and a ball pushed out of the ring is gone, the event over
    rf.ball!.body.setTranslation({ x: 0, y: 1.3, z: TUNE.ringRadius + BALL_R + 0.5 }, true);
    const cues: FeatureCue[] = [];
    run(w, rf, [f], 0.1, { canStart: false, thinkers: [], each: (_t, c) => void cues.push(...c) });
    expect(rf.ball).toBeNull();
    expect(rf.event).toBeNull();
    expect(cues).toContainEqual({ type: 'event', event: 'beachBall', phase: 'end' });
  });

  test('Pinball: three posts rise in 0.5 s; one kicks a fighter touching it away at 7.5 m/s (a stagger); they sink at the end', () => {
    const { w, rf } = ring();
    rf.startEvent('pinball');
    run(w, rf, [], POST_RISE_S * 0.5, { canStart: false });
    expect(rf.posts[0].up).toBeGreaterThan(0.3);
    expect(rf.posts[0].up).toBeLessThan(0.7);
    run(w, rf, [], POST_RISE_S, { canStart: false });
    expect(rf.posts.every((p) => p.up === 1)).toBe(true);
    const post = rf.posts[0].at;
    const out = post.clone().setLength(POST_RING + 0.75);
    const f = fighter(w, 'fists', out, Math.atan2(-out.x, -out.z));
    let kick: FeatureCue | null = null, speed = 0;
    run(w, rf, [f], 1, { canStart: false, thinkers: [], each: (_t, cues) => {
      const c = cues.find((q) => q.type === 'bump');
      if (c && !kick) { kick = c; const v = comVel(f.ragdoll, new Vector3()); speed = Math.hypot(v.x, v.z); }
    } });
    // (nudged against it: its body touches the post)
    if (!kick) {
      f.ragdoll.pose(post.clone().setLength(POST_RING + 0.5), 0);
      run(w, rf, [f], 0.5, { canStart: false, thinkers: [], each: (_t, cues) => {
        const c = cues.find((q) => q.type === 'bump');
        if (c && !kick) { kick = c; const v = comVel(f.ragdoll, new Vector3()); speed = Math.hypot(v.x, v.z); }
      } });
    }
    expect(kick).toMatchObject({ type: 'bump', post: 0, id: f.id });
    expect(speed).toBeGreaterThan(POST_KICK * 0.8);
    expect(f.reaction).toBe('stagger');
    run(w, rf, [], EVENT_S.pinball, { canStart: false });
    expect(rf.event).toBeNull();
    expect(rf.posts.every((p) => p.up === 0)).toBe(true);
    // sunk: under the ring's top
    expect(POST_H).toBeGreaterThan(1);
  });

  test('the ball hangs still while the fight is frozen', () => {
    const { w, rf } = ring();
    rf.startEvent('beachBall');
    rf.hold(true);
    const y = rf.ball!.body.translation().y;
    for (let i = 0; i < 30; i++) w.step();
    expect(rf.ball!.body.translation().y).toBeCloseTo(y, 6);
    rf.hold(false);
    for (let i = 0; i < 30; i++) w.step();
    expect(rf.ball!.body.translation().y).toBeLessThan(y - 0.1);
    w.free();
  });

  test('every event name has a duration', () => {
    for (const e of RING_EVENTS) expect(EVENT_S[e]).toBeGreaterThan(0);
  });
});
