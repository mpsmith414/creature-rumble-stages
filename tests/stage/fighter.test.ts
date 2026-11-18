import { describe, expect, it } from 'vitest';
import { TEST_LEVEL } from '../../src/levels/test';
import { MOVES } from '../../src/recipe/schema';
import { attackFor, type AttackDir } from '../../src/stage/attacks';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { knockback, STAGE_TUNE } from '../../src/stage/damage';
import { StageFighter } from '../../src/stage/fighter';
import type { Level } from '../../src/stage/level';
import { DT, NO_INTENT, type Intent, type V2 } from '../../src/stage/types';
import { KINDS, loadFixture, type Kind } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<Kind, BodyStats>;
const FISTS = STATS.fists;
const DIRS: AttackDir[] = ['forward', 'up', 'down', 'air'];

/** Only the main stage (top y = 0, x −12…12): nothing above to land on, so launches fly clear. */
const FLAT: Level = { ...TEST_LEVEL, platforms: TEST_LEVEL.platforms.filter((p) => p.id === 'main') };

/** One fighter stepping on a level, keeping the level time. */
class Run {
  t = 0;
  constructor(public f: StageFighter, public level: Level = FLAT) {}
  step(i: Partial<Intent> = {}) {
    this.f.act({ ...NO_INTENT, ...i }, this.level, this.t);
    this.t += DT;
    return this.f.events;
  }
  steps(n: number, i: Partial<Intent> = {}) {
    for (let k = 0; k < n; k++) this.step(i);
  }
  /** Steps until `done` (at most `max` steps); returns the steps taken. Fails if it never happens. */
  until(done: () => boolean, i: Partial<Intent> = {}, max = 600) {
    for (let k = 1; k <= max; k++) {
      this.step(i);
      if (done()) return k;
    }
    throw new Error('never happened');
  }
  /** Presses a button for one step and lets it go the next (held buttons only count once). */
  press(i: Partial<Intent>) {
    const e = [...this.step(i)];
    this.step();
    return e;
  }
}

/** A fighter dropped at `at` and stepped until it stands still. */
function standing(stats = FISTS, at: V2 = { x: 0, y: 0 }, level = FLAT): Run {
  const r = new Run(new StageFighter('a', stats, at), level);
  r.until(() => r.f.mover.ground !== null && r.f.action === 'idle');
  return r;
}

const HIT = { power: 1, damage: 8, angle: 40, from: 1 as const };

describe('StageFighter: moving', () => {
  it('stands, runs, faces the way it runs, jumps and lands', () => {
    const r = standing();
    expect(r.f.action).toBe('idle');
    r.steps(5, { mx: 1 });
    expect(r.f.action).toBe('run');
    expect(r.f.facing).toBe(1);
    r.steps(5, { mx: -1 });
    expect(r.f.facing).toBe(-1);
    r.steps(20);
    expect(r.f.action).toBe('idle');
    expect(r.press({ jump: true })).toContain('jump');
    expect(r.f.action).toBe('air');
    r.until(() => r.f.mover.ground !== null);
    expect(r.f.action).toBe('land');
    r.until(() => r.f.action === 'idle', {}, STAGE_TUNE.landSteps + 1);
  });

  it('created in the air it has its air jump', () => {
    const f = new StageFighter('a', FISTS, { x: 0, y: 5 });
    expect(f.mover.airJumpsLeft).toBe(FISTS.moves.airJumps);
    expect(f.action).toBe('air');
    expect(f.mover.w).toBe(FISTS.w);
    expect(f.mover.h).toBe(FISTS.h);
  });

  it('a held jump counts once; with the air jump spent, jump is the recovery leap', () => {
    const r = new Run(new StageFighter('a', FISTS, { x: 0, y: 5 }));
    const seen: string[] = [];
    for (let k = 0; k < 10; k++) seen.push(...r.step({ jump: true }));
    expect(seen).toEqual(['airJump']);
    r.step();
    expect(r.press({ jump: true })).toContain('recover');
    expect(r.press({ jump: true })).toEqual([]);
  });

  it('a fresh press of down drops through a thin platform; down held through a landing does not', () => {
    // Falls onto the left thin platform (top 3.5) holding down: it lands and stays.
    const r = new Run(new StageFighter('a', FISTS, { x: -6, y: 5 }), TEST_LEVEL);
    r.until(() => r.f.mover.ground === 'left', { my: -1 });
    r.steps(30, { my: -1 });
    expect(r.f.mover.ground).toBe('left');
    // Let go, press again: it drops.
    r.step();
    expect(r.press({ my: -1 })).toContain('drop');
    r.until(() => r.f.mover.ground === 'main');
  });

  it('down with attack is a down attack and never a drop', () => {
    const r = standing(FISTS, { x: -6, y: 3.5 }, TEST_LEVEL);
    expect(r.f.mover.ground).toBe('left');
    const e = r.step({ my: -1, attack: true });
    expect(e).not.toContain('drop');
    expect(r.f.action).toBe('attack');
    expect(r.f.attackDir).toBe('down');
    for (let k = 0; k < 40; k++) expect(r.step({ my: -1, attack: true })).not.toContain('drop');
    expect(r.f.mover.ground).toBe('left');
  });
});

describe('StageFighter: attacks', () => {
  it('attack timing: the area shows only for the active steps', () => {
    for (const [dir, my] of [['forward', 0], ['up', 1], ['down', -1]] as const) {
      const r = standing();
      const a = attackFor(FISTS.move, dir, FISTS);
      const live: number[] = [];
      for (let k = 0; k < a.windup + a.active + a.cool; k++) {
        r.step({ attack: true, my });
        expect(r.f.action, `${dir} ${k}`).toBe('attack');
        expect(r.f.attackDir).toBe(dir);
        if (r.f.attackArea()) live.push(k);
      }
      expect(live, dir).toEqual(Array.from({ length: a.active }, (_, i) => a.windup + i));
      r.step({ attack: true, my });
      expect(r.f.action, dir).toBe('idle');
      expect(r.f.attackDir).toBeNull();
      expect(r.f.attackArea()).toBeNull();
    }
  });

  it('in the air the attack is the air attack (or up with the stick up)', () => {
    const r = standing();
    r.press({ jump: true });
    r.step({ attack: true });
    expect(r.f.attackDir).toBe('air');
    const r2 = standing();
    r2.press({ jump: true });
    r2.step({ attack: true, my: 1 });
    expect(r2.f.attackDir).toBe('up');
  });

  it('an air attack ends when the fighter lands', () => {
    const r = standing();
    r.step({ jump: true });
    r.steps(40); // Coming down, so it lands mid-attack.
    r.step({ attack: true });
    expect(r.f.action).toBe('attack');
    r.until(() => r.f.mover.ground !== null);
    expect(r.f.action).toBe('land');
    expect(r.f.attackDir).toBeNull();
  });

  it('the area is in front of the attacker, turned toward the stick', () => {
    const r = standing();
    r.step({ attack: true, mx: -1 });
    expect(r.f.facing).toBe(-1);
    const a = attackFor(FISTS.move, 'forward', FISTS);
    r.steps(a.windup);
    const area = r.f.attackArea()!;
    expect(area.x).toBeCloseTo(r.f.mover.pos.x - a.area.dx);
    expect(area.y).toBeCloseTo(r.f.mover.pos.y + a.area.dy);
    expect(area.r).toBe(a.area.r);
    expect(area.x).toBeLessThan(r.f.mover.pos.x - FISTS.w / 2);
  });

  it('a new attack forgets who the last one hit', () => {
    const r = standing();
    r.step({ attack: true });
    r.f.attackHits.add('b');
    r.until(() => r.f.action === 'idle');
    r.step({ attack: true });
    expect(r.f.attackHits.size).toBe(0);
  });

  it('every move has every direction', () => {
    for (const move of MOVES) {
      for (const dir of DIRS) {
        for (const k of KINDS) {
          const a = attackFor(move, dir, STATS[k]);
          const tag = `${move} ${dir} ${k}`;
          for (const n of [a.windup, a.active, a.cool, a.power, a.damage, a.area.r]) {
            expect(Number.isFinite(n), tag).toBe(true);
            expect(n, tag).toBeGreaterThan(0);
          }
          for (const n of [a.windup, a.active, a.cool]) expect(Number.isInteger(n), tag).toBe(true);
          expect(Math.abs(a.angle), tag).toBeLessThanOrEqual(180);
          expect(a.area.dy + a.area.r, tag).toBeGreaterThan(0);
        }
      }
    }
    const reach = (move: 'kick' | 'jab', s: BodyStats) => {
      const a = attackFor(move, 'forward', s).area;
      return a.dx + a.r;
    };
    expect(reach('kick', FISTS)).toBeGreaterThan(reach('jab', FISTS));
    expect(reach('kick', STATS.legs)).toBeGreaterThan(reach('jab', STATS.tiny));
  });
});

describe('StageFighter: damage and launches', () => {
  it('a fresh hit staggers, a high-damage hit tumbles', () => {
    const r = standing();
    const soft = r.f.takeHit(HIT);
    expect(r.f.action).toBe('hitstun');
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThan(STAGE_TUNE.tumbleFrom);
    expect(r.f.damage).toBe(8);

    const r2 = standing();
    r2.f.damage = 120;
    const hard = r2.f.takeHit(HIT);
    expect(r2.f.action).toBe('tumble');
    expect(hard).toBeGreaterThanOrEqual(STAGE_TUNE.tumbleFrom);
    // Damage adds before the knockback is worked out.
    expect(r2.f.damage).toBe(128);
    expect(hard).toBeCloseTo(knockback(HIT.power, 128, FISTS.weight));
  });

  it('a launch follows the attacker’s facing and angle; the launched one turns to face the attacker', () => {
    const r = standing();
    r.f.damage = 100;
    const v = r.f.takeHit({ ...HIT, angle: 40, from: -1 });
    const a = (40 * Math.PI) / 180;
    expect(r.f.mover.vel.x).toBeCloseTo(-Math.cos(a) * v);
    expect(r.f.mover.vel.y).toBeCloseTo(Math.sin(a) * v);
    expect(r.f.facing).toBe(1);
  });

  it('hit downward or flat on the ground, a fighter pops up, never into the floor', () => {
    for (const angle of [-60, 0, 180]) {
      const r = standing();
      r.f.takeHit({ ...HIT, angle });
      expect(r.f.mover.vel.y, `${angle}`).toBeGreaterThan(0);
      r.steps(STAGE_TUNE.hitFreeze + 1);
      expect(r.f.mover.pos.y).toBeGreaterThanOrEqual(0);
    }
    // In the air a downward hit sends it down.
    const air = new StageFighter('a', FISTS, { x: 0, y: 5 });
    air.takeHit({ ...HIT, angle: -45 });
    expect(air.mover.vel.y).toBeLessThan(0);
  });

  it('a hit cancels an attack', () => {
    const r = standing();
    r.step({ attack: true });
    r.f.takeHit(HIT);
    expect(r.f.attackDir).toBeNull();
    expect(r.f.attackArea()).toBeNull();
    expect(r.f.action).toBe('hitstun');
  });

  it('hit freeze stops timers and movement, then the launch goes on', () => {
    const r = standing();
    r.f.damage = 100;
    r.f.takeHit(HIT);
    expect(r.f.freeze).toBe(STAGE_TUNE.hitFreeze);
    const at = { ...r.f.mover.pos }, t0 = r.f.actionT;
    for (let k = 0; k < STAGE_TUNE.hitFreeze; k++) {
      r.step({ mx: 1, jump: k % 2 === 0, attack: true });
      expect(r.f.mover.pos).toEqual(at);
      expect(r.f.actionT).toBe(t0);
    }
    expect(r.f.freeze).toBe(0);
    r.step();
    expect(r.f.mover.pos.x).toBeGreaterThan(at.x);
    expect(r.f.mover.pos.y).toBeGreaterThan(at.y);
  });

  it('hitstun ends and the fighter is free again', () => {
    const r = standing();
    r.f.takeHit(HIT);
    r.until(() => r.f.action !== 'hitstun', { attack: true, mx: 1 });
    expect(['idle', 'run', 'air', 'land']).toContain(r.f.action);
    r.until(() => r.f.mover.ground !== null && r.f.action !== 'land');
    r.press({ attack: true });
    expect(r.f.action).toBe('attack');
  });

  it('tumble is a clean spin and ends in control', () => {
    // Up in the air with its air jump and recovery leap used.
    const r = standing();
    r.press({ jump: true });
    r.press({ jump: true });
    r.press({ jump: true });
    expect(r.f.mover.airJumpsLeft).toBe(0);
    expect(r.f.mover.recoveryUsed).toBe(true);
    r.f.damage = 120;
    r.f.takeHit({ ...HIT, angle: 90 });
    expect(r.f.action).toBe('tumble');
    const x0 = r.f.mover.pos.x, w = r.f.mover.w, h = r.f.mover.h;
    // Mashing every button and the stick until its last step changes nothing: no attack, no dodge, no jump, no
    // steering, and the box stays whole.
    for (let k = 0; r.f.freeze > 0 || r.f.actionT < r.f.actionLen - 1; k++) {
      expect(r.step({ mx: k % 2 ? 1 : -1, my: 1, attack: k % 2 === 0, jump: k % 2 === 1, dodge: k % 3 === 0 })).toEqual([]);
      expect(r.f.action).toBe('tumble');
      expect(r.f.attackArea()).toBeNull();
      expect(r.f.attackDir).toBeNull();
      expect(r.f.mover.pos.x).toBeCloseTo(x0, 9);
      expect([r.f.mover.w, r.f.mover.h]).toEqual([w, h]);
      expect(k).toBeLessThan(300);
    }
    r.step();
    expect(r.f.mover.ground).toBeNull();
    expect(r.f.action).toBe('air');
    // Back in control in the air: the air jump and the recovery leap are there again, and it can attack.
    r.step();
    expect(r.press({ jump: true })).toContain('airJump');
    expect(r.press({ jump: true })).toContain('recover');
    r.step({ attack: true });
    expect(r.f.action).toBe('attack');
  });

  it('a tumble ignores the stick: the same launch flies the same arc', () => {
    const runs = [standing(), standing()];
    for (const r of runs) {
      r.f.damage = 200;
      r.f.takeHit({ ...HIT, angle: 35 });
    }
    expect(runs[0].f.actionLen).toBeGreaterThan(40);
    for (let k = 0; k < 40; k++) {
      runs[0].step({ mx: 1, my: -1 });
      runs[1].step({ mx: -1, my: 1 });
      expect(runs[0].f.mover.pos).toEqual(runs[1].f.mover.pos);
    }
  });

  it('a tumble that lands ends in a landing without a long slide, then the fighter can act', () => {
    const r = standing();
    r.f.damage = 100;
    r.f.takeHit({ ...HIT, angle: 30, from: -1 });
    expect(r.f.action).toBe('tumble');
    r.until(() => r.f.mover.ground !== null);
    expect(r.f.action).toBe('land');
    const x = r.f.mover.pos.x;
    r.until(() => r.f.action === 'idle');
    expect(Math.abs(r.f.mover.pos.x - x)).toBeLessThan(1);
    r.press({ attack: true });
    expect(r.f.action).toBe('attack');
  });

  it('a tune with zero-length stagger, tumble and landing never leaves a fighter stuck', () => {
    const tune = { ...STAGE_TUNE, hitstunBase: 0, hitstunPerSpeed: 0, tumbleBase: 0, tumblePerSpeed: 0, landSteps: 0 };
    const r = new Run(new StageFighter('a', FISTS, { x: 0, y: 0 }, tune));
    r.until(() => r.f.action === 'idle', {}, 60);
    r.f.takeHit({ ...HIT, damage: 1 });
    expect(r.f.action).toBe('hitstun');
    r.until(() => r.f.isFree(), {}, tune.hitFreeze + 2);
    r.until(() => r.f.action === 'idle', {}, 300);
    r.f.damage = 150;
    r.f.takeHit({ ...HIT, angle: 80 });
    expect(r.f.action).toBe('tumble');
    r.until(() => r.f.isFree(), {}, tune.hitFreeze + 2);
    r.until(() => r.f.action === 'idle', {}, 600);
  });
});

describe('StageFighter: dodge', () => {
  it('dodge: during the no-hit window a hit changes nothing', () => {
    const r = standing();
    r.step({ dodge: true });
    expect(r.f.action).toBe('dodge');
    r.steps(STAGE_TUNE.dodgeSafeFrom, { dodge: true });
    expect(r.f.canBeHit()).toBe(false);
    const before = { damage: r.f.damage, vel: { ...r.f.mover.vel }, action: r.f.action, t: r.f.actionT, freeze: r.f.freeze };
    expect(r.f.takeHit({ ...HIT, damage: 30 })).toBe(0);
    expect({ damage: r.f.damage, vel: { ...r.f.mover.vel }, action: r.f.action, t: r.f.actionT, freeze: r.f.freeze }).toEqual(before);
    r.until(() => r.f.action !== 'dodge');
    expect(r.f.canBeHit()).toBe(true);
    expect(r.f.takeHit(HIT)).toBeGreaterThan(0);
  });

  it('a dodge with the stick held rolls that way; without, it stays put', () => {
    const roll = standing();
    roll.step({ dodge: true, mx: 1 });
    roll.until(() => roll.f.action !== 'dodge');
    expect(roll.f.mover.pos.x).toBeGreaterThan(1);
    const still = standing();
    still.step({ dodge: true });
    still.until(() => still.f.action !== 'dodge');
    expect(Math.abs(still.f.mover.pos.x)).toBeLessThan(0.01);
  });

  it('a dodge started in the air does not roll when it touches down', () => {
    const r = new Run(new StageFighter('a', FISTS, { x: 0, y: 0.4 }));
    r.step({ dodge: true, mx: 1 });
    expect(r.f.action).toBe('dodge');
    let fastest = 0, landed = false;
    while (r.f.action === 'dodge') {
      r.step({ dodge: true, mx: 1 });
      fastest = Math.max(fastest, Math.abs(r.f.mover.vel.x));
      if (r.f.mover.ground !== null && r.f.actionT < STAGE_TUNE.dodgeSafeTo) landed = true;
    }
    expect(landed).toBe(true);
    expect(fastest).toBeLessThan(1);
  });

  it('dodges cannot be chained back to back', () => {
    const r = standing();
    r.step({ dodge: true });
    r.until(() => r.f.action !== 'dodge');
    r.step({ dodge: true });
    expect(r.f.action).not.toBe('dodge');
  });
});

describe('StageFighter: out', () => {
  it('out at the bounds', () => {
    const b = TEST_LEVEL.bounds;
    const f = new StageFighter('a', FISTS, { x: 0, y: 0 });
    const at = (x: number, y: number) => {
      f.mover.pos.x = x;
      f.mover.pos.y = y;
      return f.isOut(TEST_LEVEL);
    };
    expect(at(0, 0)).toBe(false);
    expect(at(b.left + 0.1, b.bottom + 0.1)).toBe(false);
    expect(at(b.right - 0.1, b.top - 0.1)).toBe(false);
    expect(at(b.left - 0.1, 0)).toBe(true);
    expect(at(b.right + 0.1, 0)).toBe(true);
    expect(at(0, b.bottom - 0.1)).toBe(true);
    expect(at(0, b.top + 0.1)).toBe(true);
  });

  it('a fighter that crosses a bound is out and stays still', () => {
    const r = new Run(new StageFighter('a', FISTS, { x: 20, y: 0 }));
    r.until(() => r.f.action === 'out');
    expect(r.f.isOut(FLAT)).toBe(true);
    const at = { ...r.f.mover.pos };
    r.steps(10, { mx: 1, jump: true });
    expect(r.f.mover.pos).toEqual(at);
    expect(r.f.takeHit(HIT)).toBe(0);
  });
});
