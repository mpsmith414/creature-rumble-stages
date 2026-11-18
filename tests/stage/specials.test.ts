import { describe, expect, it } from 'vitest';
import { SPECIAL_FOR, type SpecialName } from '../../src/fight/special';
import { TEST_LEVEL } from '../../src/levels/test';
import { attackFor } from '../../src/stage/attacks';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { knockback, STAGE_TUNE } from '../../src/stage/damage';
import type { Level } from '../../src/stage/level';
import { StageSim, type StageEvents, type StageSpecialCue } from '../../src/stage/sim';
import { METER_LAND, METER_PER_S, METER_TAKEN, SPECIAL_MULT } from '../../src/stage/specials';
import { DT, NO_INTENT, type Intent } from '../../src/stage/types';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture, type Kind } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<Kind, BodyStats>;
/** Only the main stage (top y = 0, x −12…12). */
const FLAT: Level = { ...TEST_LEVEL, platforms: TEST_LEVEL.platforms.filter((p) => p.id === 'main') };
/** No special runs longer than this many steps, whatever happens. */
const LONGEST = 240;

/** A sim on the flat stage with `me` (of `kind`, standing at x = 0 facing right) and, if given, a foe `at` m ahead. */
function duel(kind: Kind, foeAt?: number, foeKind: Kind = 'fists'): StageSim {
  const sim = new StageSim({ level: FLAT, rng: mulberry32(1) });
  sim.add('me', STATS[kind], { x: 0, y: 0 });
  if (foeAt !== undefined) sim.add('foe', STATS[foeKind], { x: foeAt, y: 0 });
  // land and settle
  for (let k = 0; k < 30; k++) sim.step(new Map());
  const me = sim.get('me')!;
  me.facing = 1;
  return sim;
}

/** Steps the sim once with `me` wanting `i` (others nothing); returns the events. */
const stepMe = (sim: StageSim, i: Partial<Intent> = {}): StageEvents => sim.step(new Map([['me', { ...NO_INTENT, ...i }]]));

/** Starts `me`'s special (meter full, special pressed) and steps on until it ends or `max` steps; returns its cues. */
function runSpecial(sim: StageSim, during?: (k: number) => void, max = LONGEST): StageSpecialCue[] {
  const me = sim.get('me')!;
  me.meter = 1;
  const cues: StageSpecialCue[] = [];
  const take = (ev: StageEvents) => cues.push(...ev.specials.filter((c) => c.id === 'me'));
  take(stepMe(sim, { special: true }));
  for (let k = 1; k < max && !cues.some((c) => c.phase === 'end'); k++) {
    during?.(k);
    take(stepMe(sim));
  }
  return cues;
}

const KIND_OF = Object.fromEntries(KINDS.map((k) => [SPECIAL_FOR[STATS[k].move], k])) as Record<SpecialName, Kind>;

describe('the special meter', () => {
  it('fills from time, hits landed and hits taken, and a full one starts the body\'s special', () => {
    const sim = duel('fists');
    const me = sim.get('me')!;
    expect(me.meter).toBeCloseTo(30 * DT * METER_PER_S, 6);
    me.meter = 0;
    for (let k = 0; k < 60; k++) stepMe(sim);
    expect(me.meter).toBeCloseTo(METER_PER_S, 6);
    // not full: special does nothing
    stepMe(sim, { special: true });
    expect(me.action).not.toBe('special');
    stepMe(sim);

    const a = duel('fists', 1.1);
    const hitter = a.get('me')!, foe = a.get('foe')!;
    hitter.meter = foe.meter = 0;
    stepMe(a, { attack: true });
    let landed = false;
    for (let k = 0; k < 40 && !landed; k++) landed = stepMe(a).hits.length > 0;
    expect(landed).toBe(true);
    const time = (k: number) => k * DT * METER_PER_S;
    expect(hitter.meter).toBeGreaterThan(METER_LAND);
    expect(hitter.meter).toBeLessThan(METER_LAND + time(60));
    expect(foe.meter).toBeGreaterThan(METER_TAKEN);
    expect(foe.meter).toBeLessThan(METER_TAKEN + time(60));

    const s = duel('fists');
    const f = s.get('me')!;
    f.meter = 1;
    const ev = stepMe(s, { special: true });
    expect(f.action).toBe('special');
    expect(f.meter).toBe(0);
    expect(ev.specials).toEqual([{ id: 'me', special: 'megaPunch', phase: 'charge', at: { x: f.mover.pos.x, y: f.mover.pos.y } }]);
  });
});

describe('specials', () => {
  it('each special runs charge → release → end and always ends', () => {
    for (const name of Object.keys(KIND_OF) as SpecialName[]) {
      const kind = KIND_OF[name];
      const sim = duel(kind);
      const cues = runSpecial(sim);
      const phases = cues.map((c) => c.phase).filter((p) => p !== 'impact');
      expect(phases, name).toEqual(['charge', 'release', 'end']);
      expect(cues.every((c) => c.special === name && Number.isFinite(c.at.x) && Number.isFinite(c.at.y)), name).toBe(true);
      const me = sim.get('me')!;
      expect(me.action, name).not.toBe('special');
      expect(me.action, name).not.toBe('out');
      expect(me.meter, name).toBeLessThan(0.2);
      // free again afterwards: it can jump
      let rose = false;
      for (let k = 0; k < 120 && !rose; k++) {
        stepMe(sim, { jump: k % 2 === 0 });
        rose = me.mover.vel.y > 0;
      }
      expect(rose, name).toBe(true);
    }
  });

  it('a blow below the special armour only rocks a special; a stronger one ends it at once', () => {
    for (const name of Object.keys(KIND_OF) as SpecialName[]) {
      const sim = duel(KIND_OF[name]);
      const me = sim.get('me')!;
      let rocked = false;
      const cues = runSpecial(sim, (k) => {
        if (k === 3) {
          expect(me.takeHit({ power: 0.5, damage: 3, angle: 30, from: -1 })).toBeGreaterThan(0);
          rocked = me.action === 'special';
        }
        if (k === 8) {
          expect(me.takeHit({ power: 4, damage: 60, angle: 45, from: -1 })).toBeGreaterThan(STAGE_TUNE.specialArmour);
          expect(me.action).toBe('tumble');
        }
      });
      expect(rocked, name).toBe(true);
      expect(cues.map((c) => c.phase), name).toEqual(['charge', 'end']);
      expect(me.action, name).not.toBe('special');
    }
  });

  it('a special ends when its fighter goes out, and when it is removed', () => {
    for (const name of Object.keys(KIND_OF) as SpecialName[]) {
      const sim = duel(KIND_OF[name]);
      const me = sim.get('me')!;
      const cues = runSpecial(sim, (k) => {
        if (k === 6) {
          me.mover.pos.y = -50;
          me.mover.ground = null;
        }
      });
      expect(me.action, name).toBe('out');
      expect(cues.map((c) => c.phase).at(-1), name).toBe('end');

      const s2 = duel(KIND_OF[name], 3);
      const f = s2.get('me')!;
      f.meter = 1;
      stepMe(s2, { special: true });
      for (let k = 0; k < 5; k++) stepMe(s2);
      expect(f.action).toBe('special');
      s2.remove('me');
      const ev = s2.step(new Map());
      expect(ev.specials, name).toEqual([{ id: 'me', special: name, phase: 'end', at: { x: f.mover.pos.x, y: f.mover.pos.y } }]);
      expect(s2.step(new Map()).specials).toEqual([]);
    }
  });

  it('a special hits about twice a normal hit', () => {
    const foeW = STATS.fists.weight;
    for (const name of Object.keys(KIND_OF) as SpecialName[]) {
      const kind = KIND_OF[name], fwd = attackFor(STATS[kind].move, 'forward', STATS[kind]);
      // the foe at the distance where the special does the most damage
      let best = { damage: 0, power: 0, launch: 0, at: 0 };
      for (let at = 0.4; at <= 5.2; at += 0.3) {
        const sim = duel(kind, at);
        const me = sim.get('me')!;
        me.meter = 1;
        const hits = [...stepMe(sim, { special: true }).hits];
        for (let k = 0; k < LONGEST && me.action === 'special'; k++) hits.push(...stepMe(sim).hits);
        const damage = sim.get('foe')!.damage;
        if (damage <= best.damage) continue;
        best = { damage, power: 0, launch: 0, at };
        for (const h of hits) if (h.special === name && h.power > best.power) { best.power = h.power; best.launch = h.launch; }
      }
      const where = `${name} (foe at ${best.at.toFixed(1)} m)`;
      expect(best.damage, `${where} hits at all`).toBeGreaterThan(0);
      expect(best.damage / fwd.damage, `${where}: damage × normal`).toBeGreaterThan(1.5);
      expect(best.damage / fwd.damage, `${where}: damage × normal`).toBeLessThan(3);
      // the strongest blow is SPECIAL_MULT × the body's forward swing, and launches about twice as fast
      expect(best.power / fwd.power, where).toBeCloseTo(SPECIAL_MULT, 6);
      const normal = knockback(fwd.power, fwd.damage, foeW);
      expect(best.launch / normal, where).toBeGreaterThan(1.7);
      expect(best.launch / normal, where).toBeLessThan(3.2);
    }
  });

  it('replays exactly and never leaves a fighter stuck in a special', () => {
    const go = () => {
      const sim = duel('blob', 3);
      const cues = runSpecial(sim);
      const f = sim.get('me')!;
      return { cues, x: f.mover.pos.x, y: f.mover.pos.y, d: sim.get('foe')!.damage };
    };
    expect(go()).toEqual(go());
  });
});
