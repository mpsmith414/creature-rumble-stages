import { describe, expect, it } from 'vitest';
import { LEVELS } from '../../src/levels';
import { TEST_LEVEL } from '../../src/levels/test';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { newBrainMemory, think, type BrainMemory } from '../../src/stage/brain';
import type { StageFighter } from '../../src/stage/fighter';
import type { Level } from '../../src/stage/level';
import {
  AIRLOCK_PULL, MISCHIEF_GAP, MISCHIEF_LEN, RIDE_MAX, RIVER_SPEED, TRAIN_DAMAGE, type MischiefCue, type MischiefName,
} from '../../src/stage/mischief';
import { navGraph } from '../../src/stage/nav';
import { StageSim, type StageEvents } from '../../src/stage/sim';
import { DT, NO_INTENT, type Intent, type V2 } from '../../src/stage/types';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture, type Kind } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<Kind, BodyStats>;
const EPS = 1e-6;

/** Steps `sim` for `seconds` with these intents (none = standing still); `each` sees every step, true stops. */
function steps(sim: StageSim, seconds: number, each?: (ev: StageEvents) => boolean | void, intents = new Map<string, Intent>()): void {
  for (let s = 0; s < Math.round(seconds / DT); s++) {
    const ev = sim.step(intents);
    if (each?.(ev)) return;
  }
}

/** A sim on `level` with fighters standing where given (they land first). */
function simWith(level: Level, fighters: { id: string; kind: Kind; at: V2 }[], seed = 1): StageSim {
  const sim = new StageSim({ level, rng: mulberry32(seed) });
  for (const f of fighters) sim.add(f.id, STATS[f.kind], f.at);
  steps(sim, 0.2);
  return sim;
}

/** Every mischief cue of `seconds` of an empty fight on `level`, with the level time it came at. */
function schedule(level: Level, seed: number, seconds: number): { t: number; cue: MischiefCue }[] {
  const sim = new StageSim({ level, rng: mulberry32(seed) });
  const out: { t: number; cue: MischiefCue }[] = [];
  steps(sim, seconds, (ev) => void ev.mischief.forEach((cue) => out.push({ t: sim.t, cue })));
  return out;
}

describe('mischief comes and goes', () => {
  it('on a seeded timer: the same seed gives the same mischief at the same steps, another seed another', () => {
    const a = schedule(LEVELS.jungle, 5, 300), b = schedule(LEVELS.jungle, 5, 300), c = schedule(LEVELS.jungle, 6, 300);
    expect(a.length).toBeGreaterThan(8);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it('one at a time, about every 30–45 s, lasting 6–10 s, never the same twice running on a level with two', () => {
    for (const level of [LEVELS.jungle, LEVELS.ship, LEVELS.toyroom]) {
      for (const seed of [1, 2, 3]) {
        const cues = schedule(level, seed, 400);
        const names = level.mischief.map((m) => m.name);
        let lastStart = 0, last: MischiefName | null = null;
        for (let i = 0; i < cues.length; i += 2) {
          const s = cues[i], e = cues[i + 1];
          expect(s.cue.phase).toBe('start');
          expect(names).toContain(s.cue.name);
          expect(s.t - lastStart).toBeGreaterThanOrEqual(MISCHIEF_GAP.min - EPS);
          expect(s.t - lastStart).toBeLessThanOrEqual(MISCHIEF_GAP.min + MISCHIEF_GAP.spread + DT);
          if (names.length > 1) expect(s.cue.name).not.toBe(last);
          if (e) {
            expect(e.cue).toEqual({ name: s.cue.name, phase: 'end' });
            expect(e.t - s.t).toBeGreaterThanOrEqual(MISCHIEF_LEN.min - EPS);
            expect(e.t - s.t).toBeLessThanOrEqual(MISCHIEF_LEN.min + MISCHIEF_LEN.spread + DT);
          }
          lastStart = s.t;
          last = s.cue.name;
        }
      }
    }
  });

  it('the test level has none, and does not draw on the fight’s random numbers for it', () => {
    expect(schedule(TEST_LEVEL, 1, 200)).toEqual([]);
    const sim = new StageSim({ level: TEST_LEVEL, rng: mulberry32(9) });
    const fresh = mulberry32(9);
    expect(sim.rng()).toBe(fresh());
  });

  it('nothing runs on during the entrance freeze', () => {
    const sim = new StageSim({ level: LEVELS.ship, rng: mulberry32(1) });
    sim.mischief.start('lowGravity', sim.t);
    sim.freeze(true);
    let cues = 0;
    steps(sim, 20, (ev) => void (cues += ev.mischief.length));
    expect(sim.mischief.active).toBe('lowGravity');
    sim.freeze(false);
    steps(sim, 11, (ev) => void (cues += ev.mischief.length));
    expect(cues).toBe(2);
    expect(sim.mischief.active).toBeNull();
  });
});

describe('each bit of mischief changes what it should and ends cleanly', () => {
  it('a vine catches a creature that jumps into its grip and carries it in an arc; a jump lets go, with the swing', () => {
    const sim = simWith(LEVELS.jungle, [{ id: 'a', kind: 'fists', at: { x: 0, y: 0 } }]);
    sim.mischief.start('vines', sim.t, 10);
    const a = sim.get('a')!, m = a.mover;
    const grip = sim.mischief.grip(0, sim.t + DT, { x: 0, y: 0 })!;
    m.pos.x = grip.x;
    m.pos.y = grip.y - m.h - 0.1;
    m.ground = null;
    m.vel.x = m.vel.y = 0;
    a.action = 'air';
    steps(sim, DT);
    expect(sim.mischief.riding('a')).toBe(0);
    let minX = Infinity, maxX = -Infinity, ground = false, n = 0;
    steps(sim, 2, () => {
      const g = sim.mischief.grip(0, sim.t, { x: 0, y: 0 })!;
      // once the catch has eased in (a few steps), the hands are on the grip
      if (++n > 12) {
        expect(Math.abs(m.pos.x - g.x)).toBeLessThan(1e-6);
        expect(Math.abs(m.pos.y + m.h - g.y)).toBeLessThan(1e-6);
      }
      minX = Math.min(minX, m.pos.x);
      maxX = Math.max(maxX, m.pos.x);
      ground ||= m.ground !== null;
    });
    expect(maxX - minX).toBeGreaterThan(3);
    expect(ground).toBe(false);
    // let go with a jump when swinging fast
    const jump = new Map<string, Intent>([['a', { ...NO_INTENT, jump: true }]]);
    let swing = 0;
    for (let s = 0; s < 240 && sim.mischief.riding('a') >= 0; s++) {
      swing = m.vel.x;
      sim.step(Math.abs(m.vel.x) > 3 ? jump : new Map());
    }
    expect(sim.mischief.riding('a')).toBe(-1);
    expect(Math.sign(m.vel.x)).toBe(Math.sign(swing));
    expect(m.vel.y).toBeGreaterThan(5);
    expect(m.airJumpsLeft).toBe(a.stats.moves.airJumps);
  });

  it('a hit knocks a rider off its vine; the vines going up let go of everyone', () => {
    const sim = simWith(LEVELS.jungle, [{ id: 'a', kind: 'tail', at: { x: 0, y: 0 } }]);
    sim.mischief.start('vines', sim.t, 6);
    const a = sim.get('a')!, m = a.mover;
    const hang = () => {
      const g = sim.mischief.grip(1, sim.t + DT, { x: 0, y: 0 })!;
      m.pos.x = g.x;
      m.pos.y = g.y - m.h;
      m.ground = null;
      a.action = 'air';
      steps(sim, DT);
      expect(sim.mischief.riding('a')).toBe(1);
    };
    hang();
    a.takeHit({ power: 1, damage: 5, angle: 45, from: 1 });
    steps(sim, 0.2);
    expect(sim.mischief.riding('a')).toBe(-1);
    steps(sim, 1);
    hang();
    let ended = false;
    steps(sim, 8, (ev) => {
      if (ev.mischief.some((c) => c.phase === 'end')) ended = true;
      return ended;
    });
    expect(ended).toBe(true);
    expect(sim.mischief.riding('a')).toBe(-1);
    expect(sim.mischief.grip(1, sim.t, { x: 0, y: 0 })).toBeNull();
  });

  it('no rider hangs on for ever: it lets go after RIDE_MAX', () => {
    const sim = simWith(LEVELS.jungle, [{ id: 'a', kind: 'horns', at: { x: 0, y: 0 } }]);
    sim.mischief.start('vines', sim.t, 10);
    const a = sim.get('a')!, m = a.mover;
    const g = sim.mischief.grip(0, sim.t + DT, { x: 0, y: 0 })!;
    m.pos.x = g.x;
    m.pos.y = g.y - m.h;
    m.ground = null;
    steps(sim, DT);
    expect(sim.mischief.riding('a')).toBe(0);
    let rode = 0;
    steps(sim, RIDE_MAX + 1, () => {
      if (sim.mischief.riding('a') < 0) return true;
      rode += DT;
    });
    expect(rode).toBeLessThanOrEqual(RIDE_MAX + DT);
  });

  it('the river sweeps along those standing on the jungle floor (not those up on a branch), then stops', () => {
    const sim = simWith(LEVELS.jungle, [
      { id: 'low', kind: 'blob', at: { x: 0, y: 0 } }, { id: 'up', kind: 'blob', at: { x: -7.5, y: 3.5 } },
    ]);
    sim.mischief.start('river', sim.t, 6);
    const low = sim.get('low')!.mover, up = sim.get('up')!.mover;
    const x0 = low.pos.x, u0 = up.pos.x;
    steps(sim, 1);
    expect(Math.abs(low.pos.x - x0)).toBeCloseTo(RIVER_SPEED, 1);
    expect(Math.sign(low.pos.x - x0)).toBe(sim.mischief.side);
    expect(up.pos.x).toBeCloseTo(u0, 6);
    steps(sim, 6);
    expect(sim.mischief.active).toBeNull();
    const x1 = low.pos.x;
    steps(sim, 1);
    expect(low.pos.x).toBeCloseTo(x1, 6);
  });

  it('the airlock pulls everyone toward its side, standing or in the air', () => {
    const sim = simWith(LEVELS.ship, [{ id: 'deck', kind: 'legs', at: { x: 0, y: 0 } }]);
    const calm = simWith(LEVELS.ship, [{ id: 'deck', kind: 'legs', at: { x: 0, y: 0 } }]);
    for (const s of [sim, calm]) s.add('air', STATS.wings, { x: 3, y: 9 });
    sim.mischief.start('airlock', sim.t, 6);
    const side = sim.mischief.side;
    steps(sim, 0.5);
    steps(calm, 0.5);
    for (const id of ['deck', 'air']) {
      const moved = sim.get(id)!.mover.pos.x - calm.get(id)!.mover.pos.x;
      expect(moved * side, id).toBeCloseTo(AIRLOCK_PULL * 0.5, 1);
    }
    expect(sim.get('deck')!.mover.pos.y).toBe(0);
  });

  it('low gravity halves gravity by swapping in a new level (the level and its nav graph stay as they were), then back', () => {
    const ship = LEVELS.ship, g = ship.gravity;
    const sim = simWith(ship, [{ id: 'a', kind: 'fists', at: { x: 0, y: 0 } }]);
    expect(sim.level).toBe(ship);
    sim.mischief.start('lowGravity', sim.t, 6);
    steps(sim, DT);
    expect(sim.level).not.toBe(ship);
    expect(sim.level.gravity).toBe(g / 2);
    expect(sim.level.platforms).toBe(ship.platforms);
    expect(ship.gravity).toBe(g);
    const moves = STATS.fists.moves;
    expect(navGraph(sim.level, moves)).not.toBe(navGraph(ship, moves));
    // a jump rises twice as high
    const m = sim.get('a')!.mover;
    let top = 0;
    steps(sim, 2, () => void (top = Math.max(top, m.pos.y)), new Map([['a', { ...NO_INTENT, jump: true }]]));
    expect(top).toBeCloseTo((moves.jump * moves.jump) / g, 0);
    steps(sim, 6);
    expect(sim.mischief.active).toBeNull();
    expect(sim.level).toBe(ship);
  });

  it('the toy train bumps those on the floor upward like a medium hit (damage at most 10), once a pass, and misses those up on a block', () => {
    const sim = simWith(LEVELS.toyroom, [
      { id: 'floor', kind: 'fists', at: { x: 6, y: 0 } }, { id: 'block', kind: 'fists', at: { x: -9, y: 3.5 } },
    ]);
    sim.mischief.start('toyTrain', sim.t, 8);
    const bumps: StageEvents['bumps'] = [];
    let seen = false;
    const floor = sim.get('floor')!;
    steps(sim, 8.5, (ev) => {
      seen ||= sim.mischief.train({ x: 0, y: 0, w: 0, h: 0, dir: 1, speed: 0 }) !== null;
      for (const b of ev.bumps) {
        bumps.push(b);
        expect(b.by).toBe('toyTrain');
        expect(floor.mover.vel.y).toBeGreaterThan(0);
      }
      // stand still again on landing, ready for the train's way back
      if (floor.mover.ground !== null) floor.mover.pos.x = 6;
    });
    expect(seen).toBe(true);
    expect(bumps.length).toBeGreaterThanOrEqual(1);
    expect(bumps.length).toBeLessThanOrEqual(2);
    expect(bumps.every((b) => b.target === 'floor')).toBe(true);
    expect(floor.damage).toBeLessThanOrEqual(2 * TRAIN_DAMAGE);
    expect(TRAIN_DAMAGE).toBeLessThanOrEqual(10);
    expect(sim.get('block')!.damage).toBe(0);
    expect(sim.mischief.active).toBeNull();
    expect(sim.mischief.train({ x: 0, y: 0, w: 0, h: 0, dir: 1, speed: 0 })).toBeNull();
  });

  it('the bouncy bed springs whoever lands on it up at jump × 1.4', () => {
    const bed = LEVELS.toyroom.platforms.find((p) => p.bounce)!;
    const sim = new StageSim({ level: LEVELS.toyroom, rng: mulberry32(1) });
    const a = sim.add('a', STATS.legs, { x: bed.x, y: bed.y + 2 });
    let bounced = false;
    steps(sim, 1, (ev) => {
      if (!ev.moves.some((e) => e.id === 'a' && e.e === 'bounce')) return;
      bounced = true;
      expect(a.mover.vel.y).toBeCloseTo(a.stats.moves.jump * bed.bounce!, 6);
      expect(a.mover.ground).toBeNull();
      return true;
    });
    expect(bounced).toBe(true);
  });
});

/** Brains for everyone on `level`, mischief `name` started at once; `each` sees every step. */
function brainBout(level: Level, fighters: { id: string; kind: Kind; at: V2 }[], name: MischiefName | null, seconds: number,
  seed: number, each: (sim: StageSim, ev: StageEvents) => void): StageSim {
  const rng = mulberry32(seed);
  const sim = new StageSim({ level, rng });
  for (const f of fighters) sim.add(f.id, STATS[f.kind], f.at);
  if (name) sim.mischief.start(name, sim.t, seconds);
  const mem = new Map<string, BrainMemory>(fighters.map((f) => [f.id, newBrainMemory()]));
  const intents = new Map<string, Intent>(), others: StageFighter[] = [];
  for (let s = 0; s < seconds / DT && sim.fighters().length > 0; s++) {
    intents.clear();
    const fs = sim.fighters();
    for (const f of fs) {
      others.length = 0;
      for (const g of fs) if (g !== f) others.push(g);
      intents.set(f.id, think({ self: f, others, level: sim.level, t: sim.t, mischief: sim.mischief }, rng, mem.get(f.id)!));
    }
    each(sim, sim.step(intents));
  }
  return sim;
}

describe('the brain and the mischief', () => {
  it('rides the vines: brains catch them, and every ride ends', () => {
    let catches = 0;
    for (const seed of [1, 2, 3]) {
      const on = new Map<string, number>();
      brainBout(LEVELS.jungle, KINDS.slice(0, 4).map((k, i) => ({ id: `f${i}`, kind: k, at: LEVELS.jungle.entries[i * 2] })),
        'vines', 10, seed, (sim) => {
          for (const f of sim.fighters()) {
            const r = sim.mischief.riding(f.id) >= 0;
            if (r && !on.has(f.id)) {
              on.set(f.id, sim.t);
              catches++;
            }
            if (!r && on.has(f.id)) on.delete(f.id);
            if (r) expect(sim.t - on.get(f.id)!).toBeLessThanOrEqual(RIDE_MAX + DT);
          }
        });
    }
    expect(catches).toBeGreaterThanOrEqual(3);
  });

  it('alone on the level, it is not swept off by the river or pulled out by the airlock', () => {
    for (const [level, name] of [[LEVELS.jungle, 'river'], [LEVELS.ship, 'airlock']] as const) {
      for (const k of KINDS) {
        for (const seed of [1, 2]) {
          const sim = brainBout(level, [{ id: 'me', kind: k, at: level.entries[seed === 1 ? 0 : 7] }], name, 10, seed, () => {});
          expect(sim.get('me')!.action, `${k} ${name} ${seed}`).not.toBe('out');
        }
      }
    }
  });

  it('hops over the toy train more often than not', () => {
    let bumped = 0, passes = 0;
    for (const k of KINDS) {
      const sim = brainBout(LEVELS.toyroom, [
        { id: 'me', kind: k, at: { x: -3, y: 0 } }, { id: 'foe', kind: 'blob', at: { x: 3, y: 0 } },
      ], 'toyTrain', 8, 7, (_s, ev) => void (bumped += ev.bumps.length));
      passes += 2 * sim.fighters().length;
    }
    expect(bumped).toBeLessThan(passes / 2);
  });
});
