import { describe, expect, it } from 'vitest';
import { TEST_LEVEL } from '../../src/levels/test';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { HOLD_MAX } from '../../src/stage/grab';
import type { Level } from '../../src/stage/level';
import { StageSim, type GrabCue, type StageEvents } from '../../src/stage/sim';
import { NO_INTENT, type Intent } from '../../src/stage/types';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture, type Kind } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<Kind, BodyStats>;
/** Only the main stage (top y = 0, x −12…12). */
const FLAT: Level = { ...TEST_LEVEL, platforms: TEST_LEVEL.platforms.filter((p) => p.id === 'main') };

/** `a` (holder kind) at `x` facing right, `b` (held kind) just in front, both standing; a 'c' far away if asked. */
function pair(o: { a?: Kind; b?: Kind; x?: number; level?: Level; third?: boolean } = {}): StageSim {
  const sim = new StageSim({ level: o.level ?? FLAT, rng: mulberry32(1) });
  const A = STATS[o.a ?? 'fists'], B = STATS[o.b ?? 'legs'], x = o.x ?? 0;
  sim.add('a', A, { x, y: 0 });
  sim.add('b', B, { x: x + A.w / 2 + B.w / 2 + 0.1, y: 0 });
  if (o.third) sim.add('c', STATS.tail, { x: x - 6, y: 0 });
  for (let k = 0; k < 30; k++) sim.step(new Map());
  sim.get('a')!.facing = 1;
  return sim;
}

/** One step with these wants (by id; the rest want nothing). */
const step = (sim: StageSim, wants: Record<string, Partial<Intent>> = {}): StageEvents =>
  sim.step(new Map(Object.entries(wants).map(([id, i]) => [id, { ...NO_INTENT, ...i }])));

/** `a` grabs `b`: presses grab and steps until `b` is held (fails if never). Returns the grab cues seen. */
function grab(sim: StageSim): GrabCue[] {
  const cues = [...step(sim, { a: { grab: true } }).grabs];
  for (let k = 0; k < 30 && sim.get('b')!.action !== 'held'; k++) cues.push(...step(sim).grabs);
  expect(sim.get('b')!.action).toBe('held');
  return cues;
}

describe('grab and throw', () => {
  it('grab then throw left, right, up launches the held one that way', () => {
    const ways: { name: string; want: Partial<Intent>; check: (vx: number, vy: number) => boolean; dir: string }[] = [
      { name: 'right', want: { attack: true, mx: 1 }, check: (vx, vy) => vx > 2 && vy > 0, dir: 'forward' },
      { name: 'left', want: { attack: true, mx: -1 }, check: (vx, vy) => vx < -2 && vy > 0, dir: 'forward' },
      { name: 'up', want: { attack: true, my: 1 }, check: (vx, vy) => vy > 4 * Math.abs(vx) && vy > 2, dir: 'up' },
    ];
    for (const w of ways) {
      const sim = pair();
      const a = sim.get('a')!, b = sim.get('b')!;
      const cues = grab(sim);
      expect(cues, w.name).toEqual([{ id: 'a', other: 'b', phase: 'grab' }]);
      expect(a.holding).toBe(b);
      expect(b.heldBy).toBe(a);
      for (let k = 0; k < 10; k++) step(sim);
      // lifted overhead, carried with the holder
      expect(b.mover.pos.y).toBeGreaterThan(a.mover.pos.y + a.mover.h * 0.5);
      expect(Math.abs(b.mover.pos.x - a.mover.pos.x)).toBeLessThan(0.5);
      const seen: GrabCue[] = [...step(sim, { a: w.want }).grabs];
      let vx = 0, vy = 0;
      for (let k = 0; k < 40 && b.action === 'held'; k++) seen.push(...step(sim).grabs);
      vx = b.mover.vel.x;
      vy = b.mover.vel.y;
      // even at no damage (a launch too slow to tumble from a hit) a thrown creature flies as a clean tumble
      expect(b.action, w.name).toBe('tumble');
      expect(w.check(vx, vy), `${w.name}: launched at (${vx.toFixed(1)}, ${vy.toFixed(1)})`).toBe(true);
      expect(seen.filter((c) => c.phase !== 'release'), w.name).toEqual([{ id: 'a', other: 'b', phase: 'throw', dir: w.dir }]);
      expect(a.holding).toBe(null);
      expect(b.heldBy).toBe(null);
      expect(b.damage).toBeGreaterThan(0);
    }
  });

  it('a held fighter cannot act', () => {
    const sim = pair();
    const a = sim.get('a')!, b = sim.get('b')!;
    grab(sim);
    b.meter = 1;
    const mash: Partial<Intent>[] = [{ jump: true, mx: 1 }, { attack: true, my: 1 }, { special: true }, { grab: true }, { dodge: true, mx: -1 }, {}];
    for (let k = 0; k < 40; k++) {
      const ev = step(sim, { b: mash[k % mash.length] });
      expect(b.action).toBe('held');
      expect(ev.moves.filter((m) => m.id === 'b')).toEqual([]);
      expect(ev.hits).toEqual([]);
      expect(b.isFree()).toBe(false);
      expect(b.mover.pos.y).toBeGreaterThan(a.mover.pos.y + a.mover.h * 0.5);
    }
    expect(b.meter).toBe(1);
  });

  it('a grab misses when nobody is close, and the grabber is free again soon', () => {
    const sim = pair();
    sim.get('b')!.mover.pos.x = 5;
    const a = sim.get('a')!;
    step(sim, { a: { grab: true } });
    expect(a.action).toBe('grab');
    let k = 0;
    for (; k < 60 && !a.isFree(); k++) step(sim);
    expect(a.isFree()).toBe(true);
    expect(k).toBeLessThan(40);
    expect(a.holding).toBe(null);
  });

  it('removing a holder frees the held; removing the held frees the holder', () => {
    const sim = pair();
    const b = sim.get('b')!;
    grab(sim);
    for (let k = 0; k < 5; k++) step(sim);
    sim.remove('a');
    const ev = step(sim);
    expect(ev.grabs).toEqual([{ id: 'a', other: 'b', phase: 'release' }]);
    expect(b.heldBy).toBe(null);
    expect(b.action).not.toBe('held');
    let k = 0;
    for (; k < 120 && !(b.isFree() && b.mover.ground !== null); k++) step(sim);
    expect(b.mover.ground).toBe('main');
    step(sim, { b: { jump: true } });
    expect(b.mover.vel.y).toBeGreaterThan(0);

    const s2 = pair();
    const a2 = s2.get('a')!;
    grab(s2);
    s2.remove('b');
    expect(step(s2).grabs).toEqual([{ id: 'a', other: 'b', phase: 'release' }]);
    expect(a2.holding).toBe(null);
    for (k = 0; k < 30 && !a2.isFree(); k++) step(s2);
    expect(a2.isFree()).toBe(true);
  });

  it('nothing is left stuck: a hit on the holder drops the held; the held going out frees the holder; a long hold throws', () => {
    // a hit on the holder
    let sim = pair();
    let a = sim.get('a')!, b = sim.get('b')!;
    grab(sim);
    a.takeHit({ power: 1, damage: 5, angle: 30, from: -1 });
    expect(a.holding).toBe(null);
    expect(b.heldBy).toBe(null);
    expect(b.action).toBe('air');
    expect(step(sim).grabs).toEqual([{ id: 'a', other: 'b', phase: 'release' }]);
    for (let k = 0; k < 120 && !b.isFree(); k++) step(sim);
    expect(b.isFree()).toBe(true);

    // a hit on the held one: it tumbles out of the hands (held flat, it never snaps to a stagger), the holder is free
    sim = pair({ third: true });
    a = sim.get('a')!;
    b = sim.get('b')!;
    grab(sim);
    b.takeHit({ power: 1, damage: 5, angle: 30, from: 1 });
    expect(b.action).toBe('tumble');
    expect(a.holding).toBe(null);
    for (let k = 0; k < 30 && !a.isFree(); k++) step(sim);
    expect(a.isFree()).toBe(true);

    // freed during the throw's wind-up: the thrower stops at once (no empty throw)
    sim = pair({ third: true });
    a = sim.get('a')!;
    b = sim.get('b')!;
    grab(sim);
    for (let k = 0; k < 10; k++) step(sim);
    step(sim, { a: { attack: true, mx: 1 } });
    expect(a.action).toBe('throw');
    b.takeHit({ power: 1, damage: 5, angle: 30, from: -1 });
    expect(a.holding).toBe(null);
    expect(a.isFree()).toBe(true);
    const later = [...step(sim).grabs, ...step(sim).grabs];
    expect(later).toEqual([{ id: 'a', other: 'b', phase: 'release' }]);

    // the held one goes out
    sim = pair();
    a = sim.get('a')!;
    b = sim.get('b')!;
    grab(sim);
    b.mover.pos.y = 100;
    const ev = step(sim);
    expect(ev.outs).toEqual(['b']);
    expect(ev.grabs).toEqual([{ id: 'a', other: 'b', phase: 'release' }]);
    for (let k = 0; k < 30 && !a.isFree(); k++) step(sim);
    expect(a.isFree()).toBe(true);

    // held too long: thrown the way the holder faces
    sim = pair();
    a = sim.get('a')!;
    b = sim.get('b')!;
    grab(sim);
    const cues: GrabCue[] = [];
    for (let k = 0; k < HOLD_MAX + 60 && b.heldBy; k++) cues.push(...step(sim).grabs);
    expect(cues).toEqual([{ id: 'a', other: 'b', phase: 'throw', dir: 'forward' }]);
    expect(b.mover.vel.x).toBeGreaterThan(0);
  });

  it('throwing at high damage can knock out (and at none it does not)', () => {
    for (const damage of [0, 150]) {
      const sim = pair({ x: 5 });
      const b = sim.get('b')!;
      b.damage = damage;
      grab(sim);
      step(sim, { a: { attack: true, mx: 1 } });
      let out = false;
      for (let k = 0; k < 300 && !out; k++) out = step(sim).outs.includes('b');
      expect(out, `damage ${damage}`).toBe(damage > 0);
    }
  });

  it('only a fighter on the ground grabs, and nobody grabs a fighter mid-special, mid-tumble or already held', () => {
    const sim = pair({ third: true });
    const a = sim.get('a')!, b = sim.get('b')!;
    b.meter = 1;
    step(sim, { b: { special: true } });
    expect(b.action).toBe('special');
    step(sim, { a: { grab: true } });
    for (let k = 0; k < 12; k++) step(sim);
    expect(a.holding).toBe(null);

    const s2 = pair({ third: true });
    const a2 = s2.get('a')!, b2 = s2.get('b')!, c2 = s2.get('c')!;
    grab(s2);
    // c comes over and tries to grab the held one (and the holder): neither can be taken
    c2.mover.pos.x = a2.mover.pos.x - a2.mover.w / 2 - c2.mover.w / 2 - 0.1;
    c2.facing = 1;
    step(s2, { c: { grab: true } });
    for (let k = 0; k < 12; k++) step(s2);
    expect(c2.holding).toBe(null);
    expect(b2.heldBy).toBe(a2);
  });

  it('a throw a Bubble Shield stops is a let-go (no throw): the held one drops free that step, the holder is free too (ruling R36)', () => {
    const sim = pair();
    const a = sim.get('a')!, b = sim.get('b')!;
    b.giveItem('bubbleShield', sim.t);
    grab(sim);
    for (let k = 0; k < 10; k++) step(sim);
    const seen: GrabCue[] = [...step(sim, { a: { attack: true, mx: 1 } }).grabs];
    for (let k = 0; k < 40 && a.action === 'throw' && !seen.length; k++) seen.push(...step(sim).grabs);
    expect(seen).toEqual([{ id: 'a', other: 'b', phase: 'release' }]);
    // the very step it was let go: free, falling, nobody holding it, no damage, one shield hit used
    expect(b.action).toBe('air');
    expect(b.heldBy).toBe(null);
    expect(a.holding).toBe(null);
    expect(a.isFree()).toBe(true);
    expect(b.damage).toBe(0);
    expect(b.itemUses).toBe(2);
    expect(b.mover.vel.x).toBe(0);
  });

  it('a grab and throw replays exactly', () => {
    const go = () => {
      const sim = pair();
      grab(sim);
      for (let k = 0; k < 8; k++) step(sim);
      step(sim, { a: { attack: true, my: 1 } });
      for (let k = 0; k < 90; k++) step(sim);
      const b = sim.get('b')!;
      return [b.mover.pos.x, b.mover.pos.y, b.damage, b.action];
    };
    expect(go()).toEqual(go());
  });
});
