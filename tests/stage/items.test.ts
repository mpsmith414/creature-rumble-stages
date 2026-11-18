import { describe, expect, it } from 'vitest';
import { LEVELS } from '../../src/levels';
import { TEST_LEVEL } from '../../src/levels/test';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { newBrainMemory, think, type BrainMemory } from '../../src/stage/brain';
import type { StageFighter } from '../../src/stage/fighter';
import {
  GROW, ITEM_NAMES, ITEM_TITLE, MAX_PRESENTS, NOODLE, PIE, PRESENT_GAP, PRESENT_LIFE, SHIELD_HITS, ZOOM, type ItemCue,
  type ItemName,
} from '../../src/stage/items';
import { platformsAt, solidAt, type Level } from '../../src/stage/level';
import { navGraph } from '../../src/stage/nav';
import { simulateBout } from '../../src/stage/report';
import { StageSim, type StageEvents } from '../../src/stage/sim';
import { DT, NO_INTENT, type Intent } from '../../src/stage/types';
import { attackSet } from '../../src/stage/attacks';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture, type Kind } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))])) as Record<Kind, BodyStats>;

const newSim = (seed = 1, level: Level = TEST_LEVEL, items = true) => new StageSim({ level, rng: mulberry32(seed), items });

/** Steps the sim `n` times with the given wanting per fighter (none: nothing), gathering every item cue. */
function stepFor(sim: StageSim, n: number, want: Record<string, Partial<Intent>> = {}, each?: (ev: StageEvents) => boolean | void): ItemCue[] {
  const cues: ItemCue[] = [];
  const intents = new Map<string, Intent>();
  for (let k = 0; k < n; k++) {
    intents.clear();
    for (const [id, w] of Object.entries(want)) intents.set(id, { ...NO_INTENT, ...w });
    const ev = sim.step(intents);
    cues.push(...ev.items);
    if (each?.(ev)) break;
  }
  return cues;
}

/** Holds `button` for a step, then lets go for a step (one press). */
function press(sim: StageSim, id: string, button: Partial<Intent>): ItemCue[] {
  return [...stepFor(sim, 1, { [id]: button }), ...stepFor(sim, 1)];
}

const secs = (s: number) => Math.round(s / DT);

describe('presents', () => {
  it('drop about every 15 s (± 3 s, from the seed) at one of the level drop spots, the same for the same seed', () => {
    const drops = (seed: number) => {
      const sim = newSim(seed), out: { t: number; x: number; item: ItemName }[] = [];
      stepFor(sim, secs(50), {}, (ev) => {
        for (const c of ev.items) if (c.phase === 'drop') out.push({ t: sim.t, x: c.at.x, item: c.item });
      });
      return out;
    };
    const a = drops(3);
    expect(a.length).toBeGreaterThanOrEqual(2);
    let last = 0;
    for (const d of a) {
      expect(d.t - last).toBeGreaterThanOrEqual(PRESENT_GAP.mean - PRESENT_GAP.spread - DT);
      expect(d.t - last).toBeLessThanOrEqual(PRESENT_GAP.mean + PRESENT_GAP.spread + DT);
      expect(TEST_LEVEL.drops).toContain(d.x);
      expect(ITEM_NAMES).toContain(d.item);
      last = d.t;
    }
    expect(drops(3)).toEqual(a);
    expect(drops(4)).not.toEqual(a);
  });

  it('without the items on, no present ever drops (and no random number is drawn)', () => {
    const r1 = mulberry32(5), r2 = mulberry32(5);
    const sim = new StageSim({ level: TEST_LEVEL, rng: r1 });
    expect(stepFor(sim, secs(40)).length).toBe(0);
    expect(r1()).toBe(r2());
  });

  it('parachutes down and lands on the first platform below it (riding a moving one), on every level', () => {
    const sim = newSim(1, TEST_LEVEL, false);
    sim.items.drop(sim.t, sim.level, 'icePop', -6);
    let land: ItemCue | undefined;
    stepFor(sim, secs(10), {}, (ev) => !!(land = ev.items.find((c) => c.phase === 'land')));
    expect(land!.at.y).toBeCloseTo(3.5, 6);
    expect(sim.items.presents[0].on).toBe('left');
    // the centre platform swings ±3 m every 6 s: a present landing on it rides along
    const p = sim.items.drop(sim.t, sim.level, 'icePop', 0);
    stepFor(sim, secs(10), {}, () => p.on !== null);
    const on = p.on!;
    const x0 = p.x;
    stepFor(sim, secs(1));
    if (on === 'centre') {
      expect(p.x).not.toBeCloseTo(x0, 3);
      const c = platformsAt(sim.level, sim.t).find((q) => q.id === 'centre')!;
      expect(p.y).toBeCloseTo(c.y, 6);
    } else expect(on).toBe('main');

    for (const level of [TEST_LEVEL, ...Object.values(LEVELS)]) {
      for (const x of level.drops) {
        const s = newSim(1, level, false);
        const q = s.items.drop(s.t, s.level, 'icePop', x);
        stepFor(s, secs(12), {}, () => q.on !== null);
        expect(q.on, `${level.id} drop at ${x}`).not.toBeNull();
      }
    }
  });

  it('at most MAX_PRESENTS lie about; an unopened one wraps itself up after PRESENT_LIFE', () => {
    const sim = newSim(7);
    let most = 0, wrapped = 0;
    stepFor(sim, secs(100), {}, (ev) => {
      most = Math.max(most, sim.items.presents.length);
      wrapped += ev.items.filter((c) => c.phase === 'end' && c.id === undefined).length;
    });
    expect(most).toBeLessThanOrEqual(MAX_PRESENTS);
    expect(wrapped).toBeGreaterThan(0);
    const s2 = newSim(1, TEST_LEVEL, false);
    const p = s2.items.drop(0, s2.level, 'icePop', 9);
    stepFor(s2, secs(10), {}, () => p.on !== null);
    const landed = s2.t;
    stepFor(s2, secs(PRESENT_LIFE + 1), {}, () => s2.items.presents.length === 0);
    expect(s2.t - landed).toBeCloseTo(PRESENT_LIFE, 1);
  });

  it('a creature touching one opens it and gets what is inside', () => {
    const sim = newSim(1, TEST_LEVEL, false);
    const f = sim.add('a', STATS.fists, { x: -6, y: 3.5 });
    sim.items.drop(sim.t, sim.level, 'bubbleShield', -6);
    const cues = stepFor(sim, secs(8), {}, () => f.item !== null);
    expect(f.item).toBe('bubbleShield');
    expect(cues.find((c) => c.phase === 'open')).toMatchObject({ id: 'a', item: 'bubbleShield' });
    expect(sim.items.presents.length).toBe(0);
    expect(ITEM_TITLE.bubbleShield).toBe('BUBBLE SHIELD');
  });
});

describe('power-ups', () => {
  /** A sim with fighter `a` (fists) standing on the main stage at x, given `item`. */
  function withItem(item: ItemName, kind: Kind = 'fists', x = 0): { sim: StageSim; f: StageFighter } {
    const sim = newSim(1, TEST_LEVEL, false);
    const f = sim.add('a', STATS[kind], { x, y: 0 });
    stepFor(sim, 3);
    f.giveItem(item, sim.t);
    return { sim, f };
  }

  it('Grow Juice: box, look, power and weight grow for 10 s from the bottom centre, then all come back', () => {
    const { sim, f } = withItem('growJuice');
    const base = f.stats, x = f.mover.pos.x, y = f.mover.pos.y;
    const cues = stepFor(sim, 2);
    expect(cues.some((c) => c.phase === 'use')).toBe(true);
    expect(f.mover.w).toBeCloseTo(base.w * GROW.size, 6);
    expect(f.mover.h).toBeCloseTo(base.h * GROW.size, 6);
    expect(f.stats.weight).toBeCloseTo(base.weight * GROW.weight, 6);
    expect(f.mover.pos.x).toBeCloseTo(x, 6);
    expect(f.mover.pos.y).toBeCloseTo(y, 6);
    expect(base.w).toBe(STATS.fists.w); // the body itself is never changed
    stepFor(sim, 20);
    expect(f.lookScale()).toBeCloseTo(GROW.size, 6);
    // a swing hits ×1.4 as hard
    stepFor(sim, 1, { a: { attack: true } });
    let power = 0;
    stepFor(sim, 30, {}, () => {
      const k = f.strike();
      if (k) power = k.power;
      return power > 0;
    });
    expect(power).toBeCloseTo(f.attackSet().forward.power * GROW.power, 6);
    const ended = stepFor(sim, secs(GROW.seconds));
    expect(ended.some((c) => c.phase === 'end' && c.item === 'growJuice')).toBe(true);
    expect(f.stats).toBe(STATS.fists);
    expect(f.mover.h).toBe(STATS.fists.h);
    stepFor(sim, 20);
    expect(f.lookScale()).toBe(1);
  });

  it('Grow Juice waits for room overhead (ruling R7) and never leaves the box inside a solid', () => {
    // a low solid roof over a floor: standing under it there is no room to grow
    const roofed: Level = {
      ...TEST_LEVEL, drops: [0], mischief: [],
      platforms: [
        { id: 'main', kind: 'solid', x: 0, y: 0, w: 24, h: 4 },
        { id: 'roof', kind: 'solid', x: -6, y: 2.4, w: 4, h: 0.3 },
      ],
    };
    const sim = new StageSim({ level: roofed, rng: mulberry32(1) });
    const f = sim.add('a', STATS.fists, { x: -6, y: 0 });
    stepFor(sim, 3);
    expect(f.mover.h).toBeLessThan(2.1);
    expect(f.mover.h * GROW.size).toBeGreaterThan(2.1);
    f.giveItem('growJuice', sim.t);
    stepFor(sim, 10);
    expect(f.grown).toBe(false);
    // walking out from under the roof, it grows
    stepFor(sim, secs(2), { a: { mx: 1 } }, () => f.grown);
    expect(f.grown).toBe(true);
    const ps = platformsAt(roofed, sim.t);
    expect(solidAt(ps, f.mover.pos.x, f.mover.pos.y, f.mover.w, f.mover.h)).toBeNull();
  });

  it('Zoom Sneakers: new movement (run ×1.5, an extra air jump) for 10 s, the body’s own never changed (ruling R27)', () => {
    const { sim, f } = withItem('zoomSneakers');
    const base = STATS.fists.moves;
    expect(f.stats.moves).not.toBe(base);
    expect(f.stats.moves.run).toBeCloseTo(base.run * ZOOM.run, 6);
    expect(f.stats.moves.airJumps).toBe(base.airJumps + ZOOM.airJumps);
    expect(STATS.fists.moves.run).toBe(base.run);
    expect(navGraph(TEST_LEVEL, f.stats.moves)).not.toBe(navGraph(TEST_LEVEL, base));
    stepFor(sim, secs(1), { a: { mx: 1 } });
    expect(f.mover.vel.x).toBeCloseTo(base.run * ZOOM.run, 3);
    // two air jumps now
    press(sim, 'a', { jump: true });
    let airJumps = 0;
    for (let k = 0; k < 2; k++) {
      stepFor(sim, 1, { a: { jump: true } });
      if (f.events.includes('airJump')) airJumps++;
      stepFor(sim, 1);
    }
    expect(airJumps).toBe(2);
    expect(f.mover.airJumpsLeft).toBe(0);
    stepFor(sim, secs(ZOOM.seconds));
    expect(f.item).toBeNull();
    expect(f.stats.moves).toBe(base);
  });

  it('Pool Noodle: 4 swings that reach much further and hit ×1.5 as hard, then it is gone', () => {
    const { sim, f } = withItem('poolNoodle');
    const plain = STATS.fists;
    const noodle = f.attackSet().forward;
    expect(noodle.area.dx).toBeCloseTo(attackSet(plain).forward.area.dx + NOODLE.reach, 6);
    expect(noodle.power).toBeCloseTo(attackSet(plain).forward.power * NOODLE.power, 6);
    let uses = 0;
    for (let k = 0; k < NOODLE.swings; k++) {
      uses += press(sim, 'a', { item: true }).filter((c) => c.phase === 'use').length;
      stepFor(sim, 40);
    }
    expect(uses).toBe(NOODLE.swings);
    const after = stepFor(sim, 3);
    expect(f.item).toBeNull();
    expect(f.attackSet().forward.area.dx).toBeLessThan(noodle.area.dx);
    expect(after.some((c) => c.phase === 'end') || f.item === null).toBe(true);
    // a noodle bonk lands from beyond its own reach, harder
    const s2 = newSim(1, TEST_LEVEL, false);
    const a = s2.add('a', STATS.fists, { x: 0, y: 0 }), b = s2.add('b', STATS.blob, { x: 0, y: 0 });
    stepFor(s2, 3);
    b.mover.pos.x = a.mover.pos.x + plain.reach + b.mover.w / 2 + 0.8;
    a.facing = 1;
    a.giveItem('poolNoodle', s2.t);
    let hit = 0;
    stepFor(s2, 1, { a: { attack: true } });
    stepFor(s2, 30, {}, (ev) => {
      hit = ev.hits.find((h) => h.target === 'b')?.power ?? 0;
      return hit > 0;
    });
    expect(hit).toBeCloseTo(attackSet(plain).forward.power * NOODLE.power, 6);
  });

  it('Custard Pie: `item` throws it in an arc; it splats a creature ahead (stunned 1.2 s); a miss splats on the floor', () => {
    const sim = newSim(1, TEST_LEVEL, false);
    const a = sim.add('a', STATS.fists, { x: 0, y: 0 }), b = sim.add('b', STATS.blob, { x: 3.5, y: 0 });
    stepFor(sim, 3);
    a.facing = 1;
    a.giveItem('custardPie', sim.t);
    const cues = press(sim, 'a', { item: true });
    let splat: ItemCue | undefined, stunAt = -1;
    cues.push(...stepFor(sim, secs(2), {}, (ev) => {
      if (b.action === 'hitstun' && stunAt < 0) stunAt = sim.steps;
      splat = ev.items.find((c) => c.phase === 'end' && c.item === 'custardPie');
      return !!splat;
    }));
    expect(cues.some((c) => c.phase === 'use' && c.id === 'a')).toBe(true);
    expect(a.item).toBeNull();
    expect(splat).toMatchObject({ id: 'a', target: 'b' });
    expect(b.action).toBe('hitstun');
    expect(b.actionLen).toBe(Math.round(PIE.stun / DT));
    expect(b.damage).toBe(PIE.damage);
    expect(sim.items.pies.length).toBe(0);
    // thrown at nobody, it lands and is gone
    a.giveItem('custardPie', sim.t);
    a.facing = -1;
    press(sim, 'a', { item: true });
    let floor: ItemCue | undefined;
    stepFor(sim, secs(3), {}, (ev) => !!(floor = ev.items.find((c) => c.phase === 'end')));
    expect(floor?.target).toBeUndefined();
    expect(floor!.at.x).toBeLessThan(a.mover.pos.x);
    expect(sim.items.pies.length).toBe(0);
  });

  it('a pie the Bubble Shield stops is no splat: no target on its end cue, no stun', () => {
    const sim = newSim(1, TEST_LEVEL, false);
    const a = sim.add('a', STATS.fists, { x: 0, y: 0 }), b = sim.add('b', STATS.blob, { x: 3.5, y: 0 });
    stepFor(sim, 3);
    a.facing = 1;
    a.giveItem('custardPie', sim.t);
    b.giveItem('bubbleShield', sim.t);
    press(sim, 'a', { item: true });
    let end: ItemCue | undefined;
    stepFor(sim, secs(2), {}, (ev) => !!(end = ev.items.find((c) => c.phase === 'end' && c.item === 'custardPie')));
    expect(end).toBeDefined();
    expect(end!.target).toBeUndefined();
    expect(b.action).not.toBe('hitstun');
    expect(b.damage).toBe(0);
    expect(b.itemUses).toBe(SHIELD_HITS - 1);
    expect(sim.items.pies.length).toBe(0);
  });

  it('Bubble Shield: the next 3 hits bounce off (no damage, no launch), then it pops and the next lands', () => {
    const { f } = withItem('bubbleShield');
    for (let k = 0; k < SHIELD_HITS; k++) {
      expect(f.takeHit({ power: 2, damage: 10, angle: 45, from: 1 })).toBe(0);
      expect(f.damage).toBe(0);
    }
    expect(f.item).toBeNull();
    expect(f.itemCues.filter((c) => c.phase === 'use').length).toBe(SHIELD_HITS);
    expect(f.itemCues.at(-1)).toMatchObject({ phase: 'end', item: 'bubbleShield' });
    expect(f.takeHit({ power: 2, damage: 10, angle: 45, from: 1 })).toBeGreaterThan(0);
    expect(f.damage).toBe(10);
  });

  it('Ice Pop: damage back to 0 at once, keeping the power-up it has', () => {
    const { sim, f } = withItem('poolNoodle');
    f.damage = 120;
    f.giveItem('icePop', sim.t);
    expect(f.damage).toBe(0);
    expect(f.item).toBe('poolNoodle');
  });

  it('one at a time: a new present ends the power-up it had', () => {
    const { sim, f } = withItem('poolNoodle');
    f.giveItem('zoomSneakers', sim.t);
    expect(f.item).toBe('zoomSneakers');
    expect(f.itemCues.map((c) => `${c.phase} ${c.item}`)).toEqual(['open poolNoodle', 'end poolNoodle', 'open zoomSneakers']);
    f.giveItem('custardPie', sim.t);
    expect(f.item).toBe('custardPie');
    expect(f.stats).toBe(STATS.fists);
  });

  it('removing a holder drops nothing stuck', () => {
    const sim = newSim(1, TEST_LEVEL, false);
    const a = sim.add('a', STATS.fists, { x: 0, y: 0 }), b = sim.add('b', STATS.legs, { x: 6, y: 3.5 });
    stepFor(sim, 3);
    a.giveItem('growJuice', sim.t);
    stepFor(sim, 2);
    b.giveItem('custardPie', sim.t);
    b.facing = -1;
    // b throws its pie, then both leave: a grown with juice, b with its pie in the air
    stepFor(sim, 1, { b: { item: true } });
    stepFor(sim, PIE.windup + 1, {}, () => sim.items.pies.length > 0);
    expect(sim.items.pies.length).toBe(1);
    sim.remove('a');
    sim.remove('b');
    const cues = stepFor(sim, 1);
    expect(cues).toContainEqual(expect.objectContaining({ phase: 'end', item: 'growJuice', id: 'a' }));
    expect(a.item).toBeNull();
    expect(a.mover.h).toBe(STATS.fists.h);
    // the pie flies on and splats; nothing is left on the level
    stepFor(sim, secs(3), {}, () => sim.items.pies.length === 0);
    expect(sim.items.pies.length).toBe(0);
    expect(sim.items.presents.length).toBe(0);
    // and one that goes out loses its power-up
    const c = sim.add('c', STATS.tiny, { x: 0, y: 0 });
    stepFor(sim, 3);
    c.giveItem('poolNoodle', sim.t);
    c.mover.pos.x = TEST_LEVEL.bounds.right + 1;
    const out = stepFor(sim, 2);
    expect(out).toContainEqual(expect.objectContaining({ phase: 'end', item: 'poolNoodle', id: 'c' }));
    expect(c.item).toBeNull();
  });

  it('items stay fair to replay: a bout with presents replays exactly', () => {
    const recipes = (['fists', 'legs', 'blob', 'tail'] as Kind[]).map(loadFixture);
    const a = simulateBout(recipes, { seed: 9, seconds: 40 });
    expect(simulateBout(recipes, { seed: 9, seconds: 40 })).toEqual(a);
  });
});

describe('the brain and items', () => {
  /** Brains for the listed ids on `sim`, stepped for up to `seconds`; `each` stops early by returning true. */
  function think4(sim: StageSim, brains: string[], seconds: number, each?: (ev: StageEvents) => boolean | void): void {
    const rng = mulberry32(17), mem = new Map<string, BrainMemory>(brains.map((id) => [id, newBrainMemory()]));
    const intents = new Map<string, Intent>(), others: StageFighter[] = [];
    for (let s = 0; s < secs(seconds); s++) {
      intents.clear();
      const fs = sim.fighters();
      for (const f of fs) {
        const m = mem.get(f.id);
        if (!m) continue;
        others.length = 0;
        for (const g of fs) if (g !== f) others.push(g);
        intents.set(f.id, think({ self: f, others, level: sim.level, t: sim.t, items: sim.items }, rng, m));
      }
      if (each?.(sim.step(intents))) break;
    }
  }

  it('goes for a present within reach (up on a platform) before going after a far foe', () => {
    for (const k of KINDS) {
      const sim = newSim(2, TEST_LEVEL, false);
      const me = sim.add('me', STATS[k], { x: -9, y: 0 });
      sim.add('foe', STATS.blob, { x: 10, y: 0 });
      sim.items.drop(sim.t, sim.level, 'bubbleShield', -6);
      think4(sim, ['me'], 12, () => me.item !== null);
      expect(me.item, k).toBe('bubbleShield');
    }
  });

  it('throws a custard pie at a foe in front, and it splats', () => {
    let splats = 0;
    for (const k of KINDS) {
      const sim = newSim(3, TEST_LEVEL, false);
      const me = sim.add('me', STATS[k], { x: -3, y: 0 });
      sim.add('foe', STATS.blob, { x: 2.5, y: 0 });
      stepFor(sim, 3);
      me.giveItem('custardPie', sim.t);
      think4(sim, ['me'], 6, (ev) => {
        if (ev.items.some((c) => c.phase === 'end' && c.target === 'foe')) splats++;
        return me.item === null && sim.items.pies.length === 0;
      });
      expect(me.item, k).toBeNull();
    }
    expect(splats).toBeGreaterThanOrEqual(5);
  });

  it('swings the noodle at a foe from beyond its own reach', () => {
    let far = 0;
    for (const k of KINDS) {
      const sim = newSim(4, TEST_LEVEL, false);
      const me = sim.add('me', STATS[k], { x: -2, y: 0 });
      const foe = sim.add('foe', STATS.blob, { x: 3, y: 0 });
      stepFor(sim, 3);
      me.giveItem('poolNoodle', sim.t);
      think4(sim, ['me'], 6, (ev) => {
        const h = ev.hits.find((x) => x.attacker === 'me');
        if (!h) return false;
        const gap = Math.abs(foe.mover.pos.x - me.mover.pos.x) - foe.mover.w / 2;
        if (gap > STATS[k].reach + 0.3) far++;
        return true;
      });
    }
    expect(far).toBeGreaterThanOrEqual(4);
  });
});
