import { describe, expect, it } from 'vitest';
import { TEST_LEVEL } from '../../src/levels/test';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { newBrainMemory, think } from '../../src/stage/brain';
import { StageFighter } from '../../src/stage/fighter';
import { PIE } from '../../src/stage/items';
import { KID_POWER, kidMoves, kidShare } from '../../src/stage/kid-power';
import { METER_LAND, METER_PER_S, METER_TAKEN } from '../../src/stage/specials';
import { StageSim, type StageEvents } from '../../src/stage/sim';
import { DT, NO_INTENT, type Intent } from '../../src/stage/types';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture, type Kind } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<Kind, BodyStats>;
const newSim = (seed = 1) => new StageSim({ level: TEST_LEVEL, rng: mulberry32(seed) });

/** Steps `n` times (or until `each` says stop), each fighter wanting what `want` gives it (none: nothing). */
function steps(sim: StageSim, n: number, want: Record<string, Partial<Intent>> = {}, each?: (ev: StageEvents) => boolean | void): void {
  const intents = new Map<string, Intent>();
  for (let k = 0; k < n; k++) {
    intents.clear();
    for (const [id, w] of Object.entries(want)) intents.set(id, { ...NO_INTENT, ...w });
    const ev = sim.step(intents);
    if (each?.(ev)) return;
  }
}

/**
 * `a` (fists) jabs `b` (legs, already on `pre` damage) standing beside it, with kid power as given: how fast `b` was
 * launched, how much damage the jab added, and how far sideways `b` flew before it came down.
 */
function jab(o: { aKid: boolean; bKid: boolean; pre?: number }): { launch: number; damage: number; flew: number } {
  const sim = newSim();
  const a = sim.add('a', STATS.fists, { x: 0, y: 0 }), b = sim.add('b', STATS.legs, { x: 0.6, y: 0 });
  steps(sim, 10);
  a.kid = o.aKid;
  b.kid = o.bKid;
  b.damage = o.pre ?? 100;
  const before = b.damage, x0 = b.mover.pos.x;
  let launch = 0;
  steps(sim, 40, { a: { attack: true } }, (ev) => {
    const h = ev.hits.find((x) => x.target === 'b');
    if (h) launch = h.launch;
    return launch > 0;
  });
  const damage = b.damage - before;
  // flies until it comes down (or leaves the level)
  steps(sim, 600, {}, () => b.action === 'out' || (b.mover.ground !== null && b.action !== 'tumble' && b.action !== 'hitstun'));
  return { launch, damage, flew: Math.abs(b.mover.pos.x - x0) };
}

describe('kid power (owner, 2026-11-20): a child on a controller hits harder and is hard for the computer to knock about', () => {
  it('the numbers: kid on CPU deals more, CPU or mischief on a kid takes less, kid vs kid and CPU vs CPU are plain', () => {
    expect(KID_POWER).toMatchObject({ dealPower: 1.6, dealDamage: 1.6, takeKnock: 0.45, takeDamage: 0.4, meter: 2, recovery: 1.25, cpuFocus: 0.5 });
    expect(kidShare(true, false)).toMatchObject({ power: 1.6, damage: 1.6, stun: 1 });
    expect(kidShare(false, true)).toMatchObject({ power: 0.45, damage: 0.4, stun: 0.5 });
    expect(kidShare(true, true)).toMatchObject({ power: 1, damage: 1, stun: 1 });
    expect(kidShare(false, false)).toMatchObject({ power: 1, damage: 1, stun: 1 });
  });

  it('a kid hit by a CPU flies at most about half as far as a CPU would and takes ~0.4× the damage', () => {
    const cpu = jab({ aKid: false, bKid: false }), kid = jab({ aKid: false, bKid: true });
    expect(cpu.launch).toBeGreaterThan(0);
    expect(kid.damage).toBeCloseTo(cpu.damage * KID_POWER.takeDamage, 6);
    expect(kid.launch).toBeLessThanOrEqual(cpu.launch * 0.5);
    expect(kid.flew).toBeLessThanOrEqual(cpu.flew * 0.5);
    // it still gets bumped: it feels the hit
    expect(kid.launch).toBeGreaterThan(1);
  });

  it('a kid’s hit launches a CPU further than a CPU’s same hit, with more damage', () => {
    const cpu = jab({ aKid: false, bKid: false }), kid = jab({ aKid: true, bKid: false });
    expect(kid.damage).toBeCloseTo(cpu.damage * KID_POWER.dealDamage, 6);
    expect(kid.launch).toBeGreaterThan(cpu.launch * 1.5);
    expect(kid.flew).toBeGreaterThan(cpu.flew);
  });

  it('kid vs kid uses the normal numbers both ways', () => {
    const cpu = jab({ aKid: false, bKid: false }), kids = jab({ aKid: true, bKid: true });
    expect(kids).toEqual(cpu);
  });

  it('a throw by a kid flies a CPU further; a CPU’s throw of a kid much less far', () => {
    const throwOf = (aKid: boolean, bKid: boolean) => {
      const sim = newSim();
      const a = sim.add('a', STATS.fists, { x: 0, y: 0 }), b = sim.add('b', STATS.legs, { x: 0.7, y: 0 });
      steps(sim, 10);
      a.kid = aKid;
      b.kid = bKid;
      b.damage = 60;
      let launch = 0;
      steps(sim, 240, { a: { grab: true } }, (ev) => {
        const h = ev.hits.find((x) => x.target === 'b');
        if (h) launch = h.launch;
        return launch > 0;
      });
      return launch;
    };
    const plain = throwOf(false, false);
    expect(plain).toBeGreaterThan(0);
    expect(throwOf(true, false)).toBeGreaterThan(plain * 1.5);
    expect(throwOf(false, true)).toBeLessThanOrEqual(plain * 0.5);
    expect(throwOf(true, true)).toBeCloseTo(plain, 9);
  });

  it('mischief (a train bump: a hit nobody threw) counts as the computer’s: a kid takes it lightly', () => {
    const at = { x: 0, y: 0 };
    const cpu = new StageFighter('c', STATS.legs, at), kid = new StageFighter('k', STATS.legs, at);
    kid.kid = true;
    cpu.damage = kid.damage = 100;
    const lc = cpu.takeHit({ power: 1, damage: 6, angle: 70, from: 1 });
    const lk = kid.takeHit({ power: 1, damage: 6, angle: 70, from: 1 });
    expect(kid.damage - 100).toBeCloseTo(6 * KID_POWER.takeDamage, 9);
    expect(lk).toBeLessThanOrEqual(lc * KID_POWER.takeKnock);
    expect(lk).toBeGreaterThan(0);
  });

  it('a CPU’s pie stuns a kid half as long for less damage; a kid’s pie on a CPU adds more damage', () => {
    const pie = (aKid: boolean, bKid: boolean) => {
      const sim = new StageSim({ level: TEST_LEVEL, rng: mulberry32(1), items: false });
      const a = sim.add('a', STATS.fists, { x: 0, y: 0 }), b = sim.add('b', STATS.blob, { x: 3.5, y: 0 });
      steps(sim, 3);
      a.facing = 1;
      a.kid = aKid;
      b.kid = bKid;
      a.giveItem('custardPie', sim.t);
      steps(sim, 1, { a: { item: true } });
      let stun = 0;
      steps(sim, 120, {}, () => {
        if (b.action === 'hitstun') stun = b.actionLen;
        return stun > 0;
      });
      return { stun, damage: b.damage };
    };
    const plain = pie(false, false);
    expect(plain).toEqual({ stun: Math.round(PIE.stun / DT), damage: PIE.damage });
    expect(pie(false, true)).toEqual({ stun: Math.round((PIE.stun * 0.5) / DT), damage: PIE.damage * KID_POWER.takeDamage });
    expect(pie(true, false)).toEqual({ stun: plain.stun, damage: PIE.damage * KID_POWER.dealDamage });
    expect(pie(true, true)).toEqual(plain);
  });

  it('the special meter fills twice as fast for a kid: over time, from hits landed and from hits taken', () => {
    const sim = newSim();
    const a = sim.add('a', STATS.fists, { x: -6, y: 0 }), b = sim.add('b', STATS.fists, { x: 6, y: 0 });
    a.kid = true;
    steps(sim, 60);
    expect(a.meter).toBeCloseTo(2 * b.meter, 9);
    expect(b.meter).toBeCloseTo(60 * METER_PER_S * DT, 9);
    a.meter = b.meter = 0;
    a.landed(null, { x: 0, y: 0 });
    b.landed(null, { x: 0, y: 0 });
    expect(a.meter).toBeCloseTo(KID_POWER.meter * METER_LAND, 9);
    expect(b.meter).toBeCloseTo(METER_LAND, 9);
    a.meter = b.meter = 0;
    a.takeHit({ power: 0.1, damage: 1, angle: 45, from: 1 });
    b.takeHit({ power: 0.1, damage: 1, angle: 45, from: 1 });
    expect(a.meter).toBeCloseTo(KID_POWER.meter * METER_TAKEN, 9);
    expect(b.meter).toBeCloseTo(METER_TAKEN, 9);
  });

  it('a kid’s recovery leap is 1.25× as strong, from a new MoveStats object (the body’s own is never changed: R27)', () => {
    const base = STATS.fists.moves, was = { ...base };
    const k = kidMoves(base);
    expect(k).not.toBe(base);
    expect(k.recovery).toBeCloseTo(base.recovery * KID_POWER.recovery, 9);
    expect({ ...k, recovery: base.recovery }).toEqual(base);
    expect(base).toEqual(was);
    expect(kidMoves(base)).toBe(k);

    const leap = (kid: boolean) => {
      const sim = newSim();
      const f = sim.add('f', STATS.fists, { x: 0, y: 6 });
      f.kid = kid;
      f.mover.airJumpsLeft = 0;
      let vy = 0;
      steps(sim, 1, { f: { jump: true } }, () => {
        if (f.events.includes('recover')) vy = f.mover.vel.y;
      });
      return { vy, stats: f.stats };
    };
    const plain = leap(false), kid = leap(true);
    expect(plain.vy).toBeGreaterThan(0);
    // one step of gravity after the leap's speed is set
    expect(kid.vy - plain.vy).toBeCloseTo(base.recovery * (KID_POWER.recovery - 1), 6);
    expect(kid.stats).toBe(STATS.fists);
  });

  it('the computer prefers a CPU over an otherwise equal kid (still goes for a kid that is all there is)', () => {
    let cpuPicks = 0, plainCpu = 0;
    const N = 60;
    for (let seed = 1; seed <= N; seed++) {
      for (const kid of [true, false]) {
        const rng = mulberry32(seed);
        const sim = new StageSim({ level: TEST_LEVEL, rng });
        const me = sim.add('me', STATS.fists, { x: 0, y: 0 });
        sim.add('cpu', STATS.legs, { x: -3, y: 0 });
        sim.add('kid', STATS.legs, { x: 3, y: 0 });
        sim.get('kid')!.kid = kid;
        const m = newBrainMemory();
        think({ self: me, others: sim.fighters().filter((f) => f !== me), level: sim.level, t: 0 }, rng, m);
        if (m.target === 'cpu') {
          if (kid) cpuPicks++;
          else plainCpu++;
        }
      }
    }
    expect(cpuPicks).toBeGreaterThanOrEqual(N * 0.9);
    // without kid power the two are a toss-up
    expect(plainCpu).toBeGreaterThan(N * 0.25);
    expect(plainCpu).toBeLessThan(N * 0.75);

    const rng = mulberry32(3), sim = new StageSim({ level: TEST_LEVEL, rng });
    const me = sim.add('me', STATS.fists, { x: 0, y: 0 });
    sim.add('kid', STATS.legs, { x: 3, y: 0 }).kid = true;
    const m = newBrainMemory();
    think({ self: me, others: sim.fighters().filter((f) => f !== me), level: sim.level, t: 0 }, rng, m);
    expect(m.target).toBe('kid');
  });

  it('off by default: a new fighter has no kid power', () => {
    expect(new StageFighter('x', STATS.fists, { x: 0, y: 0 }).kid).toBe(false);
  });
});
