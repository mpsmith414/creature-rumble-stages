import { describe, expect, it } from 'vitest';
import { LEVELS } from '../../src/levels';
import { TEST_LEVEL } from '../../src/levels/test';
import { attackFor } from '../../src/stage/attacks';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { newBrainMemory, think, type BrainMemory } from '../../src/stage/brain';
import type { StageFighter } from '../../src/stage/fighter';
import type { Level } from '../../src/stage/level';
import { navGraph } from '../../src/stage/nav';
import { StageSim, type StageEvents } from '../../src/stage/sim';
import { DT, type Intent, type V2 } from '../../src/stage/types';
import { mulberry32, type Rng } from '../../src/util/rng';
import { KINDS, loadFixture, type Kind } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<Kind, BodyStats>;
/** The main stage's half width on the test level. */
const STAGE_HALF = 12;

/**
 * A sim on `level` with fighters at the given spots; those listed in `brains` think, the rest stand still (or do what
 * `steer` sets before each step). `each` runs after every step with the intents just used; returning true stops early.
 */
function run(o: {
  level?: Level; seed: number; fighters: { id: string; kind: Kind; at: V2 }[]; brains: string[]; seconds: number;
  each?: (sim: StageSim, intents: Map<string, Intent>, ev: StageEvents) => boolean | void; setup?: (sim: StageSim, rng: Rng) => void;
  steer?: (sim: StageSim, intents: Map<string, Intent>) => void;
}): StageSim {
  const rng = mulberry32(o.seed);
  const sim = new StageSim({ level: o.level ?? TEST_LEVEL, rng });
  for (const f of o.fighters) sim.add(f.id, STATS[f.kind], f.at);
  o.setup?.(sim, rng);
  const mem = new Map<string, BrainMemory>(o.brains.map((id) => [id, newBrainMemory()]));
  const intents = new Map<string, Intent>();
  const others: StageFighter[] = [];
  for (let s = 0; s < o.seconds / DT && sim.fighters().length > 0; s++) {
    intents.clear();
    const fs = sim.fighters();
    for (const f of fs) {
      const m = mem.get(f.id);
      if (!m) continue;
      others.length = 0;
      for (const g of fs) if (g !== f) others.push(g);
      intents.set(f.id, think({ self: f, others, level: sim.level, t: sim.t }, rng, m));
    }
    o.steer?.(sim, intents);
    const ev = sim.step(intents);
    if (o.each?.(sim, intents, ev)) break;
  }
  return sim;
}

describe('the brain', () => {
  it('routes up and down: it reaches a foe on the top floor, and one on the stage below', () => {
    for (const k of KINDS) {
      for (const side of [-1, 1]) {
        let reached = false;
        run({
          seed: 11, seconds: 15, brains: ['me'],
          fighters: [{ id: 'me', kind: k, at: { x: side * 9, y: 0 } }, { id: 'foe', kind: 'blob', at: { x: 0, y: 7 } }],
          // The foe cannot be hit, so it stays up there (a swing from below would knock it down).
          setup: (sim) => (sim.get('foe')!.canBeHit = () => false),
          each: (sim) => (reached = sim.get('me')!.mover.ground === 'centre'),
        });
        expect(reached, `${k} up from ${side}`).toBe(true);
        reached = false;
        run({
          seed: 12, seconds: 10, brains: ['me'],
          fighters: [{ id: 'me', kind: k, at: { x: 0, y: 7 } }, { id: 'foe', kind: 'blob', at: { x: side * 9, y: 0 } }],
          each: (sim) => {
            const me = sim.get('me')!;
            return (reached = me.mover.ground === 'main' && Math.abs(me.mover.pos.x - side * 9) < 3);
          },
        });
        expect(reached, `${k} down to ${side}`).toBe(true);
      }
    }
  });

  it('jumps across a gap down to a lower floor to reach a foe there', () => {
    const level: Level = { ...TEST_LEVEL, platforms: [...TEST_LEVEL.platforms, { id: 'ledge', kind: 'thin', x: 18, y: -2, w: 4, h: 0.4 }] };
    for (const k of KINDS) {
      let reached = false;
      const sim = run({
        level, seed: 13, seconds: 15, brains: ['me'],
        fighters: [{ id: 'me', kind: k, at: { x: 6, y: 0 } }, { id: 'foe', kind: 'blob', at: { x: 18, y: -2 } }],
        setup: (s) => (s.get('foe')!.canBeHit = () => false),
        each: (s) => (reached = s.get('me')!.mover.ground === 'ledge'),
      });
      expect(reached, k).toBe(true);
      expect(sim.get('me')!.action, k).not.toBe('out');
    }
  });

  it('waits on a moving platform for the floor below to come under it before dropping', () => {
    // A lift swings ±6 m; the small floor below is under it only near the left end of its swing. Stepping off at
    // any other moment lands on the stage below instead.
    const level: Level = { ...TEST_LEVEL, platforms: [
      TEST_LEVEL.platforms[0],
      { id: 'left', kind: 'thin', x: -8, y: 3.5, w: 3, h: 0.4 },
      { id: 'lift', kind: 'thin', x: 0, y: 7, w: 4, h: 0.4, path: { dx: 6, dy: 0, period: 6 } },
    ] };
    let wrong = 0, reached = false;
    run({
      level, seed: 14, seconds: 12, brains: ['me'],
      fighters: [{ id: 'me', kind: 'fists', at: { x: 0, y: 7 } }, { id: 'foe', kind: 'blob', at: { x: -8, y: 3.5 } }],
      setup: (s) => (s.get('foe')!.canBeHit = () => false),
      each: (s) => {
        const me = s.get('me')!;
        // A mistimed step-off lands on the stage, or needs the air jump to scramble across.
        if ((me.events.includes('land') && me.mover.ground === 'main') || me.events.includes('airJump')) wrong++;
        return (reached = me.mover.ground === 'left');
      },
    });
    expect(reached).toBe(true);
    expect(wrong).toBe(0);
  });

  it('on a moving platform whose floor below is always too narrow for its usual drop, it drops anyway after a short wait (ruling R28)', () => {
    // The perch is always under the lift but narrower than the drop spot the brain likes (its box plus a margin each side).
    const level: Level = { ...TEST_LEVEL, platforms: [
      TEST_LEVEL.platforms[0],
      { id: 'perch', kind: 'thin', x: 0, y: 3.5, w: 1, h: 0.4 },
      { id: 'lift', kind: 'thin', x: 0, y: 7, w: 6, h: 0.4, path: { dx: 1.5, dy: 0, period: 5 } },
    ] };
    for (const k of KINDS) {
      let reached = false, stage = false;
      run({
        level, seed: 21, seconds: 4, brains: ['me'],
        fighters: [{ id: 'me', kind: k, at: { x: 0, y: 7 } }, { id: 'foe', kind: 'tiny', at: { x: 0, y: 3.5 } }],
        setup: (s) => (s.get('foe')!.canBeHit = () => false),
        each: (s) => {
          const me = s.get('me')!;
          stage ||= me.mover.ground === 'main';
          return (reached = me.mover.ground === 'perch');
        },
      });
      expect(reached, k).toBe(true);
      expect(stage, k).toBe(false);
    }
  });

  it('a route planned in low gravity is planned again when gravity comes back (ruling R27)', () => {
    // On the ship's deck with a still foe on the bridge: low gravity for two steps from the moment it stands on the deck
    // (it plans then: deck → bridge in one go, a way only low gravity gives), then back to normal, where that link does
    // not exist. From then on its plan only ever holds links of the normal graph, and it gets up there.
    for (const k of KINDS) {
      const rng = mulberry32(23);
      const sim = new StageSim({ level: LEVELS.ship, rng });
      const me = sim.add('me', STATS[k], { x: -2, y: 0 }), foe = sim.add('foe', STATS.blob, { x: 0, y: 7 });
      foe.canBeHit = () => false;
      // a brain that never roams off to another platform, so it keeps going for the bridge
      const mem = { ...newBrainMemory(), temper: 0.5, roamer: -0.5 };
      const normal = navGraph(LEVELS.ship, STATS[k].moves);
      let low = false, planned = false, stale = 0, reached = false;
      for (let s = 0; s < 10 / DT && !reached; s++) {
        if (!low && me.mover.ground === 'deck') {
          low = true;
          sim.mischief.start('lowGravity', sim.t, 2 * DT);
        }
        const want = think({ self: me, others: [foe], level: sim.level, t: sim.t, mischief: sim.mischief }, rng, mem);
        if (sim.mischief.active) planned ||= mem.plan.some((l) => l.from === 'deck' && l.to === 'bridge');
        // (a plan is only followed standing: in the air it steers the link already under way)
        else if (low && me.mover.ground !== null) stale += mem.plan.filter((l) => !normal.some((n) => n.from === l.from && n.to === l.to && n.how === l.how)).length;
        sim.step(new Map([['me', want]]));
        reached = me.mover.ground === 'bridge';
      }
      expect(planned, `${k} planned the low-gravity way`).toBe(true);
      expect(stale, k).toBe(0);
      expect(reached, k).toBe(true);
    }
  });

  it('forgets the link it was taking once knocked off it', () => {
    const rng = mulberry32(2);
    const sim = new StageSim({ level: TEST_LEVEL, rng });
    sim.add('me', STATS.fists, { x: -6, y: 2 });
    sim.add('foe', STATS.blob, { x: 0, y: 7 });
    const me = sim.get('me')!, m = newBrainMemory();
    m.link = { from: 'main', to: 'left', how: 'airJump' };
    me.takeHit({ power: 1, damage: 0, angle: 30, from: -1 });
    think({ self: me, others: [sim.get('foe')!], level: sim.level, t: 0 }, rng, m);
    expect(m.link).toBeNull();
  });

  it('recovers from off the edge: launched sideways at damage 0 it gets back in at least 90% of 50 tries', () => {
    let back = 0;
    for (let i = 0; i < 50; i++) {
      const k = KINDS[i % KINDS.length], side = i % 2 ? 1 : -1;
      let landed = false;
      run({
        seed: 100 + i, seconds: 8, brains: ['me'],
        fighters: [{ id: 'me', kind: k, at: { x: side * 13, y: 2 } }],
        setup: (sim, rng) => {
          const me = sim.get('me')!;
          me.mover.pos.x = side * (STAGE_HALF + 0.5 + rng() * 2.5);
          me.mover.pos.y = -1.5 + rng() * 4;
          // As hard as the attacks hit (power 0.7…1.3), at a low to rising angle.
          me.takeHit({ power: 0.7 + rng() * 0.6, damage: 0, angle: -10 + rng() * 55, from: side as 1 | -1 });
        },
        each: (sim) => {
          const me = sim.get('me')!;
          if (me.action === 'out') return true;
          return (landed = me.mover.ground !== null);
        },
      });
      if (landed) back++;
    }
    expect(back).toBeGreaterThanOrEqual(45);
  });

  it('back over the stage, it does not drift off again after a foe beyond the edge', () => {
    // Its jumps are spent, it is falling over the stage near the edge, and its target is out past that edge.
    let safe = 0;
    for (let i = 0; i < 14; i++) {
      const k = KINDS[i % KINDS.length], side = i % 2 ? 1 : -1;
      let landed = false;
      run({
        seed: 200 + i, seconds: 4, brains: ['me'],
        fighters: [{ id: 'me', kind: k, at: { x: side * 11, y: 3 } }, { id: 'foe', kind: 'blob', at: { x: side * 17, y: 4 } }],
        setup: (sim) => {
          const me = sim.get('me')!;
          me.mover.pos.x = side * (STAGE_HALF - 0.8 - (i % 3) * 0.3);
          me.mover.vel.x = side * 2;
          me.mover.vel.y = 2;
          me.mover.airJumpsLeft = 0;
          me.mover.recoveryUsed = true;
          me.mover.ground = null;
          sim.get('foe')!.mover.vel.y = 6;
        },
        each: (sim) => {
          const me = sim.get('me')!;
          if (me.action === 'out') return true;
          return (landed = me.mover.ground !== null);
        },
      });
      if (landed) safe++;
    }
    expect(safe).toBe(14);
  });

  it('does not jump while still under the stage lip: it drifts out first', () => {
    // Below the stage's underside, near its edge: a jump there only bumps its head.
    let wasted = 0;
    run({
      seed: 5, seconds: 0.6, brains: ['me'],
      fighters: [{ id: 'me', kind: 'fists', at: { x: 11.2, y: -4.6 } }],
      setup: (sim) => {
        const me = sim.get('me')!;
        me.mover.pos.y = -4.6 - me.mover.h;
        me.mover.vel.x = 0;
        me.mover.ground = null;
      },
      each: (sim) => {
        const me = sim.get('me')!;
        const under = Math.abs(me.mover.pos.x) - me.mover.w / 2 < STAGE_HALF && me.mover.pos.y + me.mover.h <= -4 + 1e-6;
        if (under && me.events.some((e) => e === 'airJump' || e === 'recover')) wasted++;
      },
    });
    expect(wasted).toBe(0);
  });

  it('attacks a foe above with an up attack', () => {
    for (const k of KINDS) {
      const h = STATS[k].h;
      const level: Level = { ...TEST_LEVEL, platforms: [...TEST_LEVEL.platforms, { id: 'low', kind: 'thin', x: 0, y: h * 0.8, w: 3, h: 0.3 }] };
      let dir: string | null = null;
      run({
        level, seed: 3, seconds: 3, brains: ['me'],
        fighters: [{ id: 'me', kind: k, at: { x: 0, y: 0 } }, { id: 'foe', kind: 'tiny', at: { x: 0.1, y: h * 0.8 } }],
        each: (sim) => {
          dir = sim.get('me')!.attackDir;
          return dir !== null;
        },
      });
      expect(dir, k).toBe('up');
    }
  });

  it('alone, it keeps moving (never 3 s standing still in 30 s) and stays on the level', () => {
    for (const k of ['fists', 'blob', 'tiny', 'tail'] as Kind[]) {
      let anchor = { x: 0, y: 0, t: 0 }, longest = 0;
      const sim = run({
        seed: 21, seconds: 30, brains: ['me'],
        fighters: [{ id: 'me', kind: k, at: { x: 4, y: 0 } }],
        each: (s) => {
          const p = s.get('me')!.mover.pos;
          if (Math.hypot(p.x - anchor.x, p.y - anchor.y) > 0.3) anchor = { x: p.x, y: p.y, t: s.t };
          longest = Math.max(longest, s.t - anchor.t);
        },
      });
      expect(sim.get('me')!.action, k).not.toBe('out');
      expect(longest, k).toBeLessThan(3);
    }
  });

  it('brains never produce NaN intents over a 60 s bout', () => {
    const kinds: Kind[] = [...KINDS, 'fists'];
    let checked = 0, bad = 0;
    run({
      seed: 4, seconds: 60, brains: kinds.map((_, i) => `f${i}`),
      fighters: kinds.map((k, i) => ({ id: `f${i}`, kind: k, at: TEST_LEVEL.entries[i] })),
      each: (sim, intents) => {
        for (const w of intents.values()) {
          if (!(Number.isFinite(w.mx) && Math.abs(w.mx) <= 1 && Number.isFinite(w.my) && Math.abs(w.my) <= 1)) bad++;
          checked++;
        }
        for (const f of sim.fighters()) if (!(Number.isFinite(f.mover.pos.x) && Number.isFinite(f.mover.pos.y))) bad++;
        return sim.fighters().length < 2;
      },
    });
    expect(bad).toBe(0);
    expect(checked).toBeGreaterThan(1000);
  });

  it('spreads out: in an eight-way fight they do not all chase one foe', () => {
    const kinds: Kind[] = [...KINDS, 'fists'];
    const mem = new Map<string, BrainMemory>();
    let samples = 0, piled = 0, onFloors = 0;
    const rng = mulberry32(9);
    const sim = new StageSim({ level: TEST_LEVEL, rng });
    kinds.forEach((k, i) => sim.add(`f${i}`, STATS[k], TEST_LEVEL.entries[i]));
    const intents = new Map<string, Intent>();
    for (let s = 0; s < 30 / DT && sim.fighters().length >= 4; s++) {
      intents.clear();
      const fs = sim.fighters();
      for (const f of fs) {
        let m = mem.get(f.id);
        if (!m) mem.set(f.id, (m = newBrainMemory()));
        intents.set(f.id, think({ self: f, others: fs.filter((g) => g !== f), level: sim.level, t: sim.t }, rng, m));
      }
      sim.step(intents);
      if (s % 30) continue;
      const count = new Map<string, number>();
      for (const f of sim.fighters()) {
        const t = mem.get(f.id)!.target;
        if (t) count.set(t, (count.get(t) ?? 0) + 1);
        if (f.mover.ground && f.mover.ground !== 'main') onFloors++;
      }
      samples++;
      if (Math.max(0, ...count.values()) > sim.fighters().length / 2) piled++;
    }
    expect(samples).toBeGreaterThan(10);
    expect(piled / samples).toBeLessThan(0.2);
    expect(onFloors).toBeGreaterThan(0);
  });

  it('dodges some wind-ups, not all', () => {
    // 60 tries: a long-legged foe winds up a kick at a tiny brain standing in its reach (out of the brain's own).
    const kick = attackFor(STATS.legs.move, 'forward', STATS.legs);
    const gap = kick.area.dx + kick.area.r * 0.8;
    let dodges = 0;
    for (let i = 0; i < 60; i++) {
      let dodged = false;
      run({
        seed: 300 + i, seconds: 1, brains: ['me'],
        fighters: [{ id: 'me', kind: 'tiny', at: { x: 0, y: 0 } }, { id: 'foe', kind: 'legs', at: { x: gap, y: 0 } }],
        steer: (sim, intents) => {
          const foe = sim.get('foe')!;
          const go = foe.mover.ground !== null;
          intents.set('foe', { mx: go && foe.action !== 'attack' ? -0.3 : 0, my: 0, jump: false, attack: go, special: false, grab: false,
            item: false, dodge: false });
        },
        each: (sim) => {
          const foe = sim.get('foe')!, me = sim.get('me')!;
          if (me.action === 'dodge') dodged = true;
          return foe.action === 'attack' && foe.actionT >= kick.windup;
        },
      });
      if (dodged) dodges++;
    }
    expect(dodges).toBeGreaterThan(6);
    expect(dodges).toBeLessThan(54);
  });

  it('keeps its target current while off the stage', () => {
    const rng = mulberry32(1);
    const sim = new StageSim({ level: TEST_LEVEL, rng });
    sim.add('me', STATS.fists, { x: 14, y: 1 });
    sim.add('a', STATS.blob, { x: 3, y: 0 });
    sim.add('b', STATS.tiny, { x: -3, y: 0 });
    const m = newBrainMemory();
    m.target = 'gone';
    const me = sim.get('me')!;
    think({ self: me, others: sim.fighters().filter((f) => f !== me), level: sim.level, t: 0 }, rng, m);
    expect(['a', 'b']).toContain(m.target);
  });
  it('the brain uses specials and grabs', () => {
    // with a full meter and a foe on its floor, every body lets its special go, and the move (run to its end, and a
    // second after) never carries it off the level
    for (const k of KINDS) {
      let used = false, ended = -1;
      const sim = run({
        seed: 5, seconds: 12, brains: ['me'],
        fighters: [{ id: 'me', kind: k, at: { x: -1, y: 0 } }, { id: 'foe', kind: 'fists', at: { x: 2, y: 0 } }],
        setup: (s) => { s.get('me')!.meter = 1; },
        each: (s, _i, ev) => {
          used ||= ev.specials.some((c) => c.id === 'me' && c.phase === 'release');
          if (used && ended < 0 && ev.specials.some((c) => c.id === 'me' && c.phase === 'end')) ended = s.t;
          return ended >= 0 && s.t > ended + 1;
        },
      });
      expect(used, k).toBe(true);
      expect(ended, k).toBeGreaterThan(0);
      expect(sim.get('me')!.action, k).not.toBe('out');
    }
    // in four-way bouts they let specials go, grab and throw
    let specials = 0, grabs = 0, throws = 0;
    for (const seed of [1, 2]) {
      const kinds: Kind[] = ['fists', 'legs', 'blob', 'tail'];
      run({
        seed, seconds: 60, brains: kinds.map((_, i) => `f${i}`),
        fighters: kinds.map((k, i) => ({ id: `f${i}`, kind: k, at: TEST_LEVEL.entries[i * 2] })),
        each: (sim, _i, ev) => {
          specials += ev.specials.filter((c) => c.phase === 'release').length;
          grabs += ev.grabs.filter((c) => c.phase === 'grab').length;
          throws += ev.grabs.filter((c) => c.phase === 'throw').length;
          return sim.fighters().length < 2;
        },
      });
    }
    expect(specials).toBeGreaterThanOrEqual(2);
    expect(grabs).toBeGreaterThanOrEqual(2);
    expect(throws).toBeGreaterThanOrEqual(1);
  });
});
