import { describe, expect, it } from 'vitest';
import { LEVELS } from '../../src/levels';
import { TEST_LEVEL } from '../../src/levels/test';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { STAGE_TUNE } from '../../src/stage/damage';
import { newBrainMemory, think, type BrainMemory } from '../../src/stage/brain';
import type { StageFighter } from '../../src/stage/fighter';
import { simulateBout } from '../../src/stage/report';
import { StageSim, type StageEvents } from '../../src/stage/sim';
import { DT, NO_INTENT, type Intent } from '../../src/stage/types';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture, type Kind } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<Kind, BodyStats>;
const FOUR: Kind[] = ['fists', 'legs', 'blob', 'tail'];
/** The main stage's half width and its top on the test level. */
const STAGE_HALF = 12, STAGE_TOP = 0;

const newSim = (seed = 1) => new StageSim({ level: TEST_LEVEL, rng: mulberry32(seed) });

/** Steps the sim `n` times with everyone wanting the same (or nothing). */
function stepAll(sim: StageSim, n: number, i: Partial<Intent> = {}, each?: () => void): void {
  const want: Intent = { ...NO_INTENT, ...i };
  const intents = new Map(sim.fighters().map((f) => [f.id, want]));
  for (let k = 0; k < n; k++) {
    sim.step(intents);
    each?.();
  }
}

/** Every fighter in play, thinking with the simple brain. */
function brainIntents(sim: StageSim, rng: () => number, mem: Map<string, BrainMemory>): Map<string, Intent> {
  const out = new Map<string, Intent>();
  for (const f of sim.fighters()) {
    let m = mem.get(f.id);
    if (!m) mem.set(f.id, (m = newBrainMemory()));
    out.set(f.id, think({ self: f, others: sim.fighters().filter((o) => o !== f), level: sim.level, t: sim.t }, rng, m));
  }
  return out;
}

/** A snapshot of what must stay put while frozen. */
const snap = (f: StageFighter) => ({
  x: f.mover.pos.x, y: f.mover.pos.y, vx: f.mover.vel.x, vy: f.mover.vel.y, actionT: f.actionT, actionLen: f.actionLen,
  freeze: f.freeze, damage: f.damage, ground: f.mover.ground,
});

describe('StageSim', () => {
  it('replays exactly', () => {
    const recipes = FOUR.map(loadFixture);
    const a = simulateBout(recipes, { seed: 7, seconds: 12 });
    const b = simulateBout(recipes, { seed: 7, seconds: 12 });
    const c = simulateBout(recipes, { seed: 8, seconds: 12 });
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it('hits happen and someone goes out', () => {
    const sim = newSim(3), rng = mulberry32(3), mem = new Map<string, BrainMemory>();
    FOUR.forEach((k, i) => sim.add(`${k}-${i}`, STATS[k]));
    let hits = 0, outs = 0;
    for (let s = 0; s < 120 / DT && outs === 0; s++) {
      const ev = sim.step(brainIntents(sim, rng, mem));
      hits += ev.hits.length;
      outs += ev.outs.length;
    }
    expect(hits).toBeGreaterThan(0);
    expect(outs).toBeGreaterThan(0);
  });

  it('fighters overlap but push apart gently', () => {
    const sim = newSim();
    const a = sim.add('a', STATS.fists, { x: 0, y: 0 });
    const b = sim.add('b', STATS.legs, { x: 0, y: 0 });
    // Let them land first: the push starts as they stand on the same spot.
    stepAll(sim, 2);
    let fastest = 0;
    stepAll(sim, 60, {}, () => (fastest = Math.max(fastest, a.mover.vel.y, b.mover.vel.y)));
    expect(Math.abs(a.mover.pos.x - b.mover.pos.x)).toBeGreaterThanOrEqual((0.6 * (a.mover.w + b.mover.w)) / 2);
    expect(fastest).toBeLessThanOrEqual(2);
    expect(a.mover.ground).toBe('main');
    expect(b.mover.ground).toBe('main');
  });

  it('a fighter walking into another passes through it (they overlap freely)', () => {
    const sim = newSim();
    const a = sim.add('a', STATS.fists, { x: -2, y: 0 });
    sim.add('b', STATS.blob, { x: 0, y: 0 });
    stepAll(sim, 10);
    const intents = new Map([['a', { ...NO_INTENT, mx: 1 }], ['b', NO_INTENT]]);
    for (let k = 0; k < 60; k++) sim.step(intents);
    expect(a.mover.pos.x).toBeGreaterThan(1);
  });

  it('eight on one spot spread out safely', () => {
    for (const brains of [false, true]) {
      const sim = newSim(5), rng = mulberry32(5), mem = new Map<string, BrainMemory>();
      const eight = [...KINDS, 'fists' as Kind];
      eight.forEach((k, i) => sim.add(`${k}-${i}`, STATS[k], { x: 0, y: 0 }));
      const all = [...sim.fighters()];
      const idle = new Map(all.map((f) => [f.id, NO_INTENT]));
      let sank = false;
      for (let s = 0; s < 2 / DT; s++) {
        sim.step(brains ? brainIntents(sim, rng, mem) : idle);
        for (const f of all) {
          const p = f.mover.pos;
          if (Math.abs(p.x) < STAGE_HALF && p.y < STAGE_TOP - 1e-9) sank = true;
        }
      }
      expect(sank).toBe(false);
      expect(sim.fighters().length).toBe(8);
      for (const f of all) {
        expect(Number.isFinite(f.mover.pos.x) && Number.isFinite(f.mover.pos.y)).toBe(true);
        expect(f.action).not.toBe('out');
      }
      if (!brains) {
        // Spread out: nobody still sits on the spot they all dropped onto, and they span more than one body.
        const xs = all.map((f) => f.mover.pos.x).sort((p, q) => p - q);
        expect(xs[xs.length - 1] - xs[0]).toBeGreaterThan(3);
        for (const f of all) expect(f.mover.vel.y).toBe(0);
      }
    }
  });

  it('a newcomer placed inside a solid platform is put on top of it', () => {
    const sim = newSim();
    const f = sim.add('a', STATS.fists, { x: 0, y: -2 });
    expect(f.mover.pos.y).toBeGreaterThanOrEqual(STAGE_TOP);
    stepAll(sim, 5);
    expect(f.mover.ground).toBe('main');
    expect(f.mover.airJumpsLeft).toBe(STATS.fists.moves.airJumps);
  });

  it('without a place, newcomers enter at the level’s entries, away from the others', () => {
    const sim = newSim();
    const a = sim.add('a', STATS.fists), b = sim.add('b', STATS.fists);
    const xs = TEST_LEVEL.entries.map((e) => e.x);
    expect(xs).toContain(a.mover.pos.x);
    expect(xs).toContain(b.mover.pos.x);
    expect(Math.abs(a.mover.pos.x - b.mover.pos.x)).toBeGreaterThan(10);
  });

  it('an attack in reach hits once, freezes both, and is reported', () => {
    const sim = newSim();
    const a = sim.add('a', STATS.fists, { x: 0, y: 0 });
    const b = sim.add('b', STATS.legs, { x: 0.6, y: 0 });
    stepAll(sim, 10);
    const intents = new Map([['a', { ...NO_INTENT, attack: true }], ['b', NO_INTENT]]);
    const hits = [];
    let flew = 0;
    for (let k = 0; k < 40; k++) {
      const ev = sim.step(intents);
      hits.push(...ev.hits);
      if (ev.hits.length) {
        // Both freeze for the hit freeze.
        expect(a.freeze).toBe(STAGE_TUNE.hitFreeze);
        expect(b.freeze).toBe(STAGE_TUNE.hitFreeze);
      }
      flew = Math.max(flew, b.mover.vel.x);
    }
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ attacker: 'a', target: 'b' });
    expect(b.damage).toBeGreaterThan(0);
    expect(flew).toBeGreaterThan(1);
  });

  it('a trade: two swinging at each other on the same step both get hit', () => {
    for (const [first, second] of [['a', 'b'], ['b', 'a']]) {
      const sim = newSim();
      // Whichever joined first, the trade is even.
      const made = { [first]: sim.add(first, STATS.fists, { x: first === 'a' ? 0 : 0.6, y: 0 }),
        [second]: sim.add(second, STATS.fists, { x: second === 'a' ? 0 : 0.6, y: 0 }) };
      const a = made.a, b = made.b;
      stepAll(sim, 10);
      const swing = new Map([['a', { ...NO_INTENT, attack: true, mx: 1 }], ['b', { ...NO_INTENT, attack: true, mx: -1 }]]);
      const hits = [];
      for (let k = 0; k < 30; k++) hits.push(...sim.step(swing).hits);
      expect(hits.map((h) => `${h.attacker}>${h.target}`).sort()).toEqual(['a>b', 'b>a']);
      expect(a.damage).toBe(b.damage);
      // Each is launched away from the other.
      expect(a.facing).toBe(1);
      expect(b.facing).toBe(-1);
    }
  });

  it('freeze stops everything', () => {
    const sim = newSim(2), rng = mulberry32(2), mem = new Map<string, BrainMemory>();
    FOUR.forEach((k, i) => sim.add(`${k}-${i}`, STATS[k], { x: -3 + 2 * i, y: 1 }));
    for (let s = 0; s < 90; s++) sim.step(brainIntents(sim, rng, mem));
    const before = sim.fighters().map(snap), t = sim.t, steps = sim.steps;
    sim.freeze(true);
    for (const f of sim.fighters()) expect(f.action).toBe('frozen');
    for (let s = 0; s < 60; s++) {
      const ev = sim.step(brainIntents(sim, rng, mem));
      expect(ev.hits.length + ev.outs.length + ev.moves.length).toBe(0);
    }
    expect(sim.fighters().map(snap)).toEqual(before);
    expect(sim.t).toBe(t);
    expect(sim.steps).toBe(steps);
    sim.freeze(false);
    for (const f of sim.fighters()) expect(f.action).not.toBe('frozen');
  });

  it('unfreezing resumes exactly where it stopped', () => {
    const run = (frozen: boolean) => {
      const sim = newSim(4);
      const a = sim.add('a', STATS.fists, { x: 0, y: 0 });
      const b = sim.add('b', STATS.tail, { x: 0.7, y: 0 });
      stepAll(sim, 10);
      // Mid-attack, mid-hit: freeze then carry on.
      const hit = new Map([['a', { ...NO_INTENT, attack: true }], ['b', { ...NO_INTENT, mx: -1 }]]);
      for (let k = 0; k < 12; k++) sim.step(hit);
      if (frozen) {
        sim.freeze(true);
        stepAll(sim, 30, { jump: true, attack: true, mx: 1 });
        sim.freeze(false);
      }
      for (let k = 0; k < 40; k++) sim.step(hit);
      return [snap(a), snap(b), a.action, b.action];
    };
    expect(run(true)).toEqual(run(false));
  });

  it('removing a fighter mid-attack leaves the others fine', () => {
    const sim = newSim();
    const a = sim.add('a', STATS.fists, { x: 0, y: 0 });
    const b = sim.add('b', STATS.legs, { x: 3, y: 0 });
    const c = sim.add('c', STATS.blob, { x: -3, y: 0 });
    stepAll(sim, 10);
    const intents = new Map([['a', { ...NO_INTENT, attack: true }], ['b', NO_INTENT], ['c', NO_INTENT]]);
    for (let k = 0; k < 3 && a.action !== 'attack'; k++) sim.step(intents);
    expect(a.action).toBe('attack');
    sim.remove('a');
    expect(sim.get('a')).toBeUndefined();
    expect(sim.fighters().map((f) => f.id)).toEqual(['b', 'c']);
    for (let k = 0; k < 120; k++) {
      const ev = sim.step(intents);
      expect(ev.hits).toEqual([]);
    }
    for (const f of [b, c]) {
      expect(f.mover.ground).toBe('main');
      expect(f.isFree()).toBe(true);
    }
    // A fighter removed mid-hit-freeze, and one removed twice, change nothing either.
    sim.remove('a');
    sim.remove('b');
    stepAll(sim, 10, { mx: 1 });
    expect(c.mover.pos.x).toBeGreaterThan(-3);
  });

  it('a fighter that goes out is reported once and leaves play', () => {
    const sim = newSim();
    const a = sim.add('a', STATS.fists, { x: 0, y: 0 });
    sim.add('b', STATS.fists, { x: 5, y: 0 });
    stepAll(sim, 5);
    a.takeHit({ power: 6, damage: 200, angle: 45, from: -1 });
    const outs: string[] = [];
    for (let k = 0; k < 600; k++) outs.push(...sim.step(new Map()).outs);
    expect(outs).toEqual(['a']);
    expect(sim.fighters().map((f) => f.id)).toEqual(['b']);
    expect(sim.get('a')?.action).toBe('out');
  });
});

describe('simulateBout', () => {
  it('reports a winner when one is left, and the times', () => {
    const r = simulateBout(['fists', 'tiny'].map(loadFixture), { seed: 11, seconds: 4 });
    expect(r.seconds).toBeGreaterThan(0);
    expect(r.seconds).toBeLessThanOrEqual(4 + 1e-9);
    expect(r.quiet).toBeGreaterThanOrEqual(0);
    expect(r.quiet).toBeLessThanOrEqual(r.seconds + 1e-9);
    expect(r.fighterTime).toBeGreaterThan(r.seconds); // two in play for most of it
    expect(r.fighterTime).toBeLessThanOrEqual(2 * r.seconds + 1e-6);
    expect(r.still).toBeGreaterThanOrEqual(0);
    expect(r.still).toBeLessThanOrEqual(r.fighterTime);
    if (r.outs.length === 0) {
      expect(r.winner).toBeNull();
      expect(r.firstOut).toBeNull();
    }
  });
});

describe('the crowning: calm and put (Task 15)', () => {
  /** Four on the jungle, mid-action: a tumbles, b holds c in a grab, d swings a pool noodle, e winds up its special. */
  function busy() {
    const sim = new StageSim({ level: LEVELS.jungle, rng: mulberry32(4), items: true });
    const at = (x: number) => ({ x, y: 0 });
    const a = sim.add('a', STATS.fists, at(-8)), b = sim.add('b', STATS.legs, at(-2)), c = sim.add('c', STATS.blob, at(-1.4));
    const d = sim.add('d', STATS.tail, at(4)), e = sim.add('e', STATS.horns, at(8));
    stepAll(sim, 30);
    a.takeHit({ power: 3, damage: 100, angle: 60, from: 1 });
    b.seize(c);
    d.giveItem('poolNoodle', sim.t);
    e.meter = 1;
    sim.step(new Map([['e', { ...NO_INTENT, special: true }]]));
    sim.items.drop(sim.t, sim.level);
    sim.mischief.start('vines', sim.t);
    sim.step(new Map());
    return { sim, a, b, c, d, e };
  }

  it('busy() really is mid-action', () => {
    const { sim, a, b, c, d, e } = busy();
    expect(a.action).toBe('tumble');
    expect(b.holding).toBe(c);
    expect(c.action).toBe('held');
    expect(d.item).toBe('poolNoodle');
    expect(e.action).toBe('special');
    expect(sim.items.presents.length).toBeGreaterThan(0);
    expect(sim.mischief.active).toBe('vines');
  });

  it('calm ends every special, hold and power-up, takes the presents and pies away and ends the mischief for good', () => {
    const { sim, a, b, c, d, e } = busy();
    sim.calm();
    expect(b.holding).toBeNull();
    expect(c.heldBy).toBeNull();
    for (const f of [b, c, d, e]) expect(['idle', 'air', 'run', 'land']).toContain(f.action);
    expect(a.action).toBe('tumble'); // a launch runs its course
    expect(d.item).toBeNull();
    expect(sim.items.presents).toEqual([]);
    expect(sim.items.pies).toEqual([]);
    expect(sim.mischief.active).toBeNull();
    const ev = sim.step(new Map());
    expect(ev.specials).toContainEqual(expect.objectContaining({ id: 'e', phase: 'end' }));
    expect(ev.grabs).toContainEqual(expect.objectContaining({ id: 'b', phase: 'release' }));
    expect(ev.items).toContainEqual(expect.objectContaining({ id: 'd', phase: 'end', item: 'poolNoodle' }));
    expect(ev.mischief).toContainEqual({ name: 'vines', phase: 'end' });
    // nothing comes back: no present, no mischief, a long while after
    const evs: StageEvents[] = [];
    for (let k = 0; k < 60 * 90; k++) evs.push(sim.step(new Map()));
    expect(evs.flatMap((x) => x.items).filter((i) => i.phase === 'drop')).toEqual([]);
    expect(evs.flatMap((x) => x.mischief)).toEqual([]);
    for (const f of sim.fighters()) expect(['idle', 'air', 'land']).toContain(f.action);
  });

  it('calm in the entrance freeze: unfrozen afterwards, everyone carries on calmly', () => {
    const { sim, b, e } = busy();
    sim.freeze(true);
    sim.calm();
    sim.freeze(false);
    expect(b.holding).toBeNull();
    expect(e.action).not.toBe('special');
    expect(sim.fighters().some((f) => f.action === 'frozen')).toBe(false);
  });

  it('put stands a fighter on a spot, still: it lands there on the next steps and never inside a solid', () => {
    const sim = new StageSim({ level: LEVELS.jungle, rng: mulberry32(2) });
    const f = sim.add('a', STATS.fists, { x: -8, y: 0 });
    f.takeHit({ power: 3, damage: 80, angle: 50, from: 1 });
    sim.put('a', { x: 0, y: 7 });
    expect(f.mover.pos).toEqual({ x: 0, y: 7 });
    expect(f.mover.vel).toEqual({ x: 0, y: 0 });
    stepAll(sim, 90);
    expect(f.mover.pos.x).toBeCloseTo(0, 5);
    expect(f.mover.pos.y).toBeCloseTo(7, 5);
    expect(f.mover.ground).toBe('canopy');
    sim.put('a', { x: 0, y: -1 }); // inside the ground: lifted onto its top
    expect(f.mover.pos.y).toBe(0);
  });
});
