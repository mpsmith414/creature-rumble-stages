import { describe, expect, test, vi } from 'vitest';
import { animState, type AnimState } from '../../src/anim/pose';
import { CARRY_S, LONE_EVERY_S, LONE_RETRY_S, RumbleShow, type Card, type ShowView } from '../../src/app/show';
import type { DrawOptions } from '../../src/app/stage-show';
import type { BodyData } from '../../src/builder/build';
import { buildSkeleton } from '../../src/builder/skeleton';
import { LEVELS } from '../../src/levels';
import { Match } from '../../src/match/match';
import { DROP_IN_S, GROUP_DROP_IN_S, topSpot } from '../../src/show/drop-in';
import type { StageFighter } from '../../src/stage/fighter';
import { platformsAt, solidAt, type Level, type LevelId } from '../../src/stage/level';
import type { StageSim } from '../../src/stage/sim';
import { NO_INTENT, type V2 } from '../../src/stage/types';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture } from '../fixtures/fighters';

const DT = 1 / 60;

/** A card for a fixture kind (its body is only the skeleton: the pictures are fakes here). */
function card(kind: string, id = kind): Card {
  const recipe = loadFixture(kind);
  return { id, recipe, body: { skeleton: buildSkeleton(recipe) } as BodyData, maker: 'Pickle', name: recipe.name };
}

/** A fake picture: it records what it is asked to draw, and runs the show's changes to each creature's pose. */
function fakeView() {
  const drawn = new Map<string, { hidden: boolean; chute: number; a: AnimState }>();
  const on = new Set<string>();
  const log = {
    levels: [] as LevelId[], closeUps: [] as { at: V2; height: number }[], kos: [] as V2[], pops: [] as string[],
    crowns: [] as [string, boolean][], stopConfetti: 0, uncrown: 0,
  };
  const view = {
    useLevel: (l: Level) => void log.levels.push(l.id),
    add: (f: StageFighter) => void on.add(f.id),
    remove: (id: string) => void on.delete(id),
    ids: () => [...on],
    draw: (sim: StageSim, _loop: unknown, _dt: number, o: DrawOptions) => {
      drawn.clear();
      for (const f of sim.fighters()) {
        const a = animState(f);
        const r = o.adjust?.(f, a);
        drawn.set(f.id, { hidden: r === false, chute: typeof r === 'number' ? r : 0, a });
      }
    },
    closeUp: (at: V2, height: number) => void log.closeUps.push({ at: { ...at }, height }),
    knockOut: (at: V2) => void log.kos.push({ ...at }),
    pop: (_at: V2, word?: string) => void log.pops.push(word ?? ''),
    crown: (id: string, confetti = true) => void log.crowns.push([id, confetti]),
    stopConfetti: () => void log.stopConfetti++,
    uncrown: () => void log.uncrown++,
  };
  return { view: view as unknown as ShowView, drawn, on, log };
}

/** The whole show on the jungle with a real match and fight; words, sounds and pictures are counted fakes. */
function rig(seed = 5) {
  const match = new Match({ entrance: DROP_IN_S, group: GROUP_DROP_IN_S });
  const { view, drawn, on, log } = fakeView();
  const said: string[] = [];
  const announcer = {
    say: vi.fn((beat: string) => { said.push(beat); return { text: beat, spoken: false }; }),
    warn: vi.fn((who: readonly { id: string }[]) => { said.push('aboutToFly'); return { text: who.map((w) => w.id).join() }; }),
    cancelHeld: vi.fn<(id: string) => void>(),
    warm: vi.fn(), prefetch: vi.fn<(t: string) => void>(),
  };
  const roster = { fought: vi.fn(async () => {}), crowned: vi.fn(async () => {}) };
  const crowd = { roar: vi.fn() };
  const sfx = { boing: vi.fn(), bonk: vi.fn(), whoosh: vi.fn(), fanfare: vi.fn(), thud: vi.fn(), sproing: vi.fn(), ding: vi.fn(), airhorn: vi.fn() };
  const banner = { hide: vi.fn() };
  const show = new RumbleShow({ view, rng: mulberry32(seed), match, announcer, sfx, crowd, roster, banner });
  let t = 0;
  const run = (secs: number, each?: () => void) => {
    for (let i = 0; i < Math.round(secs / DT); i++) {
      show.frame(DT, (t += DT));
      each?.();
    }
  };
  const fighter = (id: string) => show.sim.get(id);
  return { show, match, view, drawn, on, log, said, announcer, roster, crowd, sfx, banner, run, fighter, now: () => t };
}

/** Sends `f` far off the side of the level: it is out on the next step. */
const knockOff = (f: StageFighter) => {
  f.mover.pos.x = 1000;
  f.mover.pos.y = 0;
};

describe('RumbleShow: drop-ins', () => {
  test('an arrival drops in: frozen fight, a close-up on its spot, hidden above, falling under a parachute, TA-DA as it lands, then it fights', () => {
    const r = rig();
    r.show.register(card('fists', 'a'));
    expect(r.announcer.prefetch).toHaveBeenCalledTimes(1); // the intro fetches as soon as it is made
    expect(r.announcer.prefetch.mock.calls[0][0]).toContain('Pickle');
    r.show.arrive(['a']);
    expect(r.fighter('a')).toBeUndefined(); // waiting holds nothing on the stage
    r.run(DT);
    const f = r.fighter('a')!;
    expect(f.action).toBe('frozen');
    expect(r.said).toContain('intro');
    expect(r.drawn.get('a')!.hidden).toBe(true); // waiting above the view while the camera swoops in
    const spot = { ...f.mover.pos };
    expect(r.log.closeUps.at(-1)!.at.x).toBeCloseTo(spot.x, 6);
    r.run(1);
    const falling = r.drawn.get('a')!;
    expect(falling.hidden).toBe(false);
    expect(falling.a.action).toBe('air');
    expect(falling.a.pos.y).toBeGreaterThan(spot.y + 1);
    expect(falling.chute).toBeGreaterThan(0.5);
    r.run(1.5);
    expect(r.log.pops).toContain('TA-DA!');
    expect(r.sfx.boing).toHaveBeenCalled();
    expect(f.mover.pos).toEqual(spot); // the fight never moved it
    r.run(DROP_IN_S - 2.5 + 0.1);
    expect(r.match.fighting).toEqual(['a']);
    expect(f.action).not.toBe('frozen');
    r.run(1);
    expect(r.show.drop.active).toBe(false);
  });

  test('a newcomer freezes the fight in place; it carries on exactly afterwards', () => {
    const r = rig();
    for (const k of ['fists', 'legs', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'legs']);
    r.run(2);
    const before = r.show.sim.steps;
    r.show.arrive(['blob']);
    r.run(DROP_IN_S - 0.2);
    expect(r.show.sim.steps).toBe(before);
    expect(r.show.sim.fighters().every((f) => f.action === 'frozen')).toBe(true);
    r.run(1);
    expect(r.show.sim.steps).toBeGreaterThan(before);
    expect(r.show.sim.fighters().some((f) => f.action === 'frozen')).toBe(false);
  });

  test('arrivals close together share one drop-in (a group line, no close-up), and it is still about 5 s', () => {
    const r = rig();
    for (const k of ['fists', 'legs']) r.show.register(card(k));
    r.show.arrive(['fists']);
    r.run(0.5);
    r.show.arrive(['legs']);
    r.run(DT);
    expect(r.match.entering).toEqual(['fists', 'legs']);
    expect(r.said).toContain('groupIntro');
    expect(r.show.drop.ids().sort()).toEqual(['fists', 'legs']);
    const closeUps = r.log.closeUps.length;
    r.run(1);
    expect(r.log.closeUps.length).toBe(closeUps); // a group: the camera shows the whole level
    r.run(GROUP_DROP_IN_S - 0.9);
    expect(r.match.fighting).toEqual(['fists', 'legs']);
    expect(r.show.drop.active).toBe(false);
  });

  test('past 8 they wait on deck; a knockout lets the next one drop in', () => {
    const r = rig(11);
    const ids = Array.from({ length: 10 }, (_, i) => `f${i}`);
    ids.forEach((id, i) => r.show.register(card(KINDS[i % KINDS.length], id)));
    r.show.quickFill(ids);
    expect(r.show.sim.fighters()).toHaveLength(8);
    expect(r.match.onDeck).toHaveLength(2);
    knockOff(r.fighter('f0')!);
    r.run(0.1);
    expect(r.match.entering).toEqual(['f8']);
    expect(r.show.drop.has('f8')).toBe(true);
    expect(r.show.sim.fighters().length).toBeLessThanOrEqual(8);
  });
});

describe('RumbleShow: the empty stage', () => {
  test('with nobody on the stage (the start screen) nothing happens: no present, no mischief, no words', () => {
    const r = rig();
    r.run(60);
    expect(r.said).toEqual([]);
    expect(r.show.sim.items.presents).toEqual([]);
    expect(r.show.sim.mischief.active).toBeNull();
    // and after everyone was knocked out
    r.show.register(card('blob'));
    r.show.quickFill(['blob']);
    r.run(1);
    knockOff(r.fighter('blob')!);
    r.run(0.1);
    r.said.length = 0;
    r.run(60);
    expect(r.said).toEqual([]);
  });

  test('an emptied stage clears what was under way: no present frozen in the air, no mischief left running', () => {
    const r = rig();
    r.show.register(card('blob'));
    r.show.quickFill(['blob']);
    r.run(1);
    r.show.sim.items.drop(r.show.sim.t, r.show.sim.level);
    r.show.sim.mischief.start('vines', r.show.sim.t, 30);
    r.run(DT);
    expect(r.show.sim.items.presents.length).toBeGreaterThan(0);
    knockOff(r.fighter('blob')!);
    r.run(0.1);
    expect(r.match.fighting).toEqual([]);
    expect(r.show.sim.items.presents).toEqual([]);
    expect(r.show.sim.items.pies).toEqual([]);
    expect(r.show.sim.mischief.active).toBeNull();
    r.run(30);
    expect(r.show.sim.items.presents).toEqual([]);
    expect(r.show.sim.mischief.active).toBeNull();
    // the next fight on the stage gets its presents again
    r.sfx.ding.mockClear();
    r.show.register(card('fists'));
    r.show.quickFill(['fists']);
    r.run(25);
    expect(r.sfx.ding).toHaveBeenCalled();
  });
});

describe('RumbleShow: knockouts', () => {
  test('a knockout: its effect, the crowd roars, the roster counts the bout, it leaves the stage; the last one holds the stage', () => {
    const r = rig();
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    r.run(0.5);
    knockOff(r.fighter('blob')!);
    r.run(DT * 2);
    expect(r.log.kos).toHaveLength(1);
    expect(r.said).toContain('knockOut');
    expect(r.crowd.roar).toHaveBeenCalled();
    expect(r.roster.fought).toHaveBeenCalledWith(['blob']);
    expect(r.fighter('blob')).toBeUndefined();
    expect(r.on.has('blob')).toBe(false);
    expect(r.said).toContain('holdsStage');
    expect(r.match.fighting).toEqual(['fists']);
  });

  test('a warning still held for a creature that goes out is taken back', () => {
    const r = rig();
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    r.fighter('blob')!.damage = 999;
    r.run(DT * 2);
    expect(r.announcer.warn).toHaveBeenCalled();
    knockOff(r.fighter('blob')!);
    r.run(DT * 2);
    expect(r.announcer.cancelHeld).toHaveBeenCalledWith('blob');
  });

  test('two out together is a tie', () => {
    const r = rig();
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    r.run(0.2);
    knockOff(r.fighter('fists')!);
    knockOff(r.fighter('blob')!);
    r.run(DT * 2);
    expect(r.match.fighting).toEqual([]);
    expect(r.said).toContain('tie');
  });

  test(`a lone fighter taunts every ${LONE_EVERY_S} s while it stays alone; a taunt over a big line is tried again soon`, () => {
    const r = rig();
    r.show.register(card('blob'));
    r.show.quickFill(['blob']);
    r.run(DT);
    expect(r.said.filter((b) => b === 'lone')).toHaveLength(1);
    r.run(LONE_EVERY_S * 2 + 0.5);
    expect(r.said.filter((b) => b === 'lone')).toHaveLength(3);
    const q = rig();
    q.show.register(card('blob'));
    let quiet = true;
    q.announcer.say.mockImplementation((beat: string) => {
      if (beat === 'lone' && quiet) return { text: '', spoken: false };
      q.said.push(beat);
      return { text: beat, spoken: false };
    });
    q.show.quickFill(['blob']);
    q.run(1);
    expect(q.said.filter((b) => b === 'lone')).toHaveLength(0);
    quiet = false;
    q.run(LONE_RETRY_S + 0.1);
    expect(q.said.filter((b) => b === 'lone')).toHaveLength(1);
  });
});

describe('RumbleShow: crown and Again!', () => {
  test('crown and Again! only act when the phase allows, and a second press does nothing', () => {
    const r = rig();
    expect(r.show.crown()).toBe(false); // nobody fighting
    expect(r.show.again()).toBe(false);
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    expect(r.show.again()).toBe(false);
    expect(r.show.crown()).toBe(true);
    expect(r.show.crown()).toBe(false);
    expect(r.sfx.fanfare).toHaveBeenCalledTimes(1);
    expect(r.roster.crowned).toHaveBeenCalledTimes(1);
    expect(r.show.again()).toBe(true);
    expect(r.show.again()).toBe(false);
  });

  /** Five on the jungle mid-action: a tumbles, b holds c, d swings a pool noodle, e winds up its special; vines and a present. */
  function busy() {
    const r = rig(3);
    const kinds = ['fists', 'legs', 'blob', 'tail', 'horns'];
    const ids = ['a', 'b', 'c', 'd', 'e'];
    ids.forEach((id, i) => r.show.register(card(kinds[i], id)));
    r.show.quickFill(ids);
    r.run(0.5);
    r.show.loop.thinking = false; // (set up undisturbed: nobody hits e out of its special)
    r.run(1.5); // (anyone hit meanwhile gets back on its feet)
    const [a, b, c, d, e] = ids.map((id) => r.fighter(id)!);
    a.takeHit({ power: 2.5, damage: 60, angle: 70, from: 1 });
    b.seize(c);
    d.giveItem('poolNoodle', r.show.sim.t);
    e.meter = 1;
    r.show.loop.steer('e', () => ({ ...NO_INTENT, special: true }));
    r.run(DT * 2);
    r.show.loop.steer('e', null);
    r.show.sim.items.drop(r.show.sim.t, r.show.sim.level);
    r.show.sim.mischief.start('vines', r.show.sim.t);
    r.run(DT);
    expect(a.action).toBe('tumble');
    expect(b.holding).toBe(c);
    expect(d.item).toBe('poolNoodle');
    expect(e.action).toBe('special');
    expect(r.show.sim.items.presents.length).toBeGreaterThan(0);
    r.show.loop.thinking = true;
    return { r, a, b, c, d, e };
  }

  /** Nobody is stuck: no hold, no special, no frozen fighter, no power-up, presents or mischief left. */
  function calm(r: ReturnType<typeof rig>, dropping = false) {
    for (const f of r.show.sim.fighters()) {
      expect(f.holding, f.id).toBeNull();
      expect(f.heldBy, f.id).toBeNull();
      // (dropping in after Again!, everyone is frozen in the air on its spot until the drop-in ends)
      expect(dropping ? f.frozenFrom : f.action, f.id).not.toMatch(/^(special|grab|held|throw|frozen|attack)$/);
      expect(f.item, f.id).toBeNull();
    }
    expect(r.show.sim.items.presents).toEqual([]);
    expect(r.show.sim.items.pies).toEqual([]);
    expect(r.show.sim.mischief.active).toBeNull();
  }

  test('crown and again mid-action: a launch, a grab, an item and a special all end cleanly; the champion is carried up top', () => {
    const { r } = busy();
    expect(r.show.crown()).toBe(true);
    const champ = r.show.champion!;
    calm(r);
    expect(r.show.loop.thinking).toBe(false);
    expect(r.log.crowns).toEqual([[champ, false]]); // the crown at once, the confetti once it is up there
    r.run(CARRY_S / 2);
    const top = topSpot(LEVELS.jungle);
    expect(r.drawn.get(champ)!.a.action).toBe('air'); // carried up
    r.run(CARRY_S / 2 + 0.2);
    expect(r.log.crowns.at(-1)).toEqual([champ, true]);
    r.run(4);
    calm(r);
    const f = r.fighter(champ)!;
    expect(f.mover.pos.x).toBeCloseTo(top.x, 6);
    expect(f.mover.pos.y).toBeCloseTo(top.y, 6);
    expect(r.drawn.get(champ)!.a.action).toBe('showoff'); // it struts up there
    expect(r.log.closeUps.at(-1)!.at.x).toBeCloseTo(top.x, 6); // the camera on it

    // Again!: the next level, a fresh fight, the cast dropping in together, the champion last and crowned
    expect(r.show.again()).toBe(true);
    expect(r.show.levelId).toBe('ship');
    expect(r.log.levels).toEqual(['ship']);
    expect(r.log.stopConfetti).toBe(1);
    expect(r.log.crowns.at(-1)).toEqual([champ, false]);
    expect(r.match.entering.at(-1)).toBe(champ);
    expect(r.show.sim.fighters().map((x) => x.id).sort()).toEqual([...r.match.entering].sort());
    calm(r, true);
    expect(r.show.sim.fighters().every((x) => x.damage === 0)).toBe(true);
    const landed: string[] = [];
    r.run(GROUP_DROP_IN_S + 0.2, () => {
      for (const id of r.show.drop.ids()) if (r.show.drop.state(id)?.phase === 'showoff' && !landed.includes(id)) landed.push(id);
    });
    expect(landed.at(-1)).toBe(champ);
    expect(r.match.fighting.length).toBe(r.show.sim.fighters().length);
    expect(r.show.drop.active).toBe(false);
    expect(r.show.sim.fighters().some((x) => x.action === 'frozen')).toBe(false);
    expect(r.show.loop.thinking).toBe(true);
    const steps = r.show.sim.steps;
    r.run(2);
    expect(r.show.sim.steps).toBeGreaterThan(steps); // the fight goes on
  });

  test('a knockout after the crowning (one launched just before it) says no line over the crown line; its effect and sounds still come', () => {
    const r = rig();
    for (const k of ['fists', 'blob', 'legs']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob', 'legs']);
    r.run(0.5);
    expect(r.show.crown()).toBe(true);
    const champ = r.show.champion!;
    const flier = ['fists', 'blob', 'legs'].find((id) => id !== champ)!;
    r.said.length = 0;
    r.sfx.whoosh.mockClear();
    r.fighter(flier)!.damage = 999; // about to fly: no warning either
    r.run(0.5);
    knockOff(r.fighter(flier)!);
    r.run(DT * 2);
    expect(r.fighter(flier)).toBeUndefined();
    expect(r.log.kos).toHaveLength(1); // the knockout's effect
    expect(r.sfx.whoosh).toHaveBeenCalled();
    expect(r.said).not.toContain('knockOut');
    expect(r.said).not.toContain('aboutToFly');
    expect(r.said).toEqual([]); // the champion's line stands
  });

  test('the toy room: a champion crowned under a toy block is carried out from under it, never drawn inside a solid', () => {
    const r = rig();
    r.show.setLevel('toyroom');
    r.show.register(card('legs', 'a'));
    r.show.quickFill(['a']);
    r.run(0.2);
    r.show.loop.thinking = false;
    const f = r.fighter('a')!;
    f.mover.pos.x = -9; // on the floor under blockL (its underside 2.5 m up)
    f.mover.pos.y = 0;
    f.mover.vel.x = f.mover.vel.y = 0;
    expect(solidAt(platformsAt(r.show.sim.level, r.show.sim.t), -9, 0, f.mover.w, f.mover.h)).toBeNull();
    expect(r.show.crown()).toBe(true);
    let frames = 0;
    r.run(CARRY_S + 0.2, () => {
      const a = r.drawn.get('a')!.a;
      frames++;
      const hit = solidAt(platformsAt(r.show.sim.level, r.show.sim.t), a.pos.x, a.pos.y, f.mover.w, f.mover.h);
      if (hit) throw new Error(`drawn inside ${hit.id} at (${a.pos.x.toFixed(2)}, ${a.pos.y.toFixed(2)})`);
    });
    expect(frames).toBeGreaterThan(90);
    const top = topSpot(LEVELS.toyroom), a = r.drawn.get('a')!.a;
    expect(a.pos.x).toBeCloseTo(top.x, 6);
    expect(a.pos.y).toBeCloseTo(top.y, 6);
  });

  test('Again! straight after the crown (a launch still under way) leaves nothing stuck either', () => {
    const { r } = busy();
    r.show.crown();
    r.run(DT * 3);
    expect(r.show.again()).toBe(true);
    calm(r, true);
    r.run(GROUP_DROP_IN_S + 0.5);
    expect(r.show.sim.fighters().some((x) => x.action === 'frozen')).toBe(false);
    expect(r.match.fighting.length).toBeGreaterThan(0);
    expect(r.match.entering).toEqual([]);
  });

  test('crowning mid-drop-in sends the newcomer back on deck: off the stage, the fight unfrozen', () => {
    const r = rig();
    for (const k of ['fists', 'legs', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'legs']);
    r.run(0.5);
    r.show.arrive(['blob']);
    r.run(1);
    expect(r.fighter('blob')).toBeDefined();
    expect(r.show.crown()).toBe(true);
    expect(r.match.onDeck).toEqual(['blob']);
    expect(r.fighter('blob')).toBeUndefined();
    expect(r.on.has('blob')).toBe(false);
    expect(r.show.drop.active).toBe(false);
    expect(r.show.sim.fighters().some((f) => f.action === 'frozen')).toBe(false);
    // Again! brings it in with the rest
    r.show.again();
    expect(r.match.entering).toContain('blob');
  });

  test('Again! goes round the levels in order: jungle, space ship, toy room, jungle', () => {
    const r = rig();
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    const seen: LevelId[] = [r.show.levelId];
    for (let i = 0; i < 3; i++) {
      r.run(GROUP_DROP_IN_S + 0.5);
      expect(r.show.crown()).toBe(true);
      r.run(0.5);
      expect(r.show.again()).toBe(true);
      seen.push(r.show.levelId);
    }
    expect(seen).toEqual(['jungle', 'ship', 'toyroom', 'jungle']);
  });

  test('after a round that 10 fought, Again! drops the champion in last and still crowned; nothing leaks over many rounds', () => {
    const r = rig(11);
    const ids = Array.from({ length: 10 }, (_, i) => `f${i}`);
    ids.forEach((id, i) => r.show.register(card(KINDS[i % KINDS.length], id)));
    r.show.quickFill(ids);
    knockOff(r.fighter('f0')!);
    knockOff(r.fighter('f1')!);
    r.run(GROUP_DROP_IN_S + 1);
    expect(r.match.lastCast).toHaveLength(10);
    for (let round = 0; round < 4; round++) {
      expect(r.show.crown()).toBe(true);
      const champ = r.show.champion!;
      r.run(1);
      expect(r.show.again()).toBe(true);
      expect(r.match.entering).toHaveLength(8);
      expect(r.match.entering[7]).toBe(champ);
      expect(r.on.size).toBeLessThanOrEqual(8);
      expect(r.show.cardCount).toBeLessThanOrEqual(10);
      r.run(GROUP_DROP_IN_S + 1);
      expect(r.match.fighting).toContain(champ);
    }
  });
});

describe('RumbleShow: the level and clearing the stage', () => {
  test('the TV menu’s level pick moves everyone there now, dropping in together; the same level again does nothing', () => {
    const r = rig();
    for (const k of ['fists', 'legs', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'legs', 'blob']);
    r.run(1);
    r.show.setLevel('jungle');
    expect(r.log.levels).toEqual([]);
    r.show.setLevel('toyroom');
    expect(r.show.levelId).toBe('toyroom');
    expect(r.log.levels).toEqual(['toyroom']);
    expect(r.show.sim.level.id).toBe('toyroom');
    expect(r.show.drop.ids().sort()).toEqual(['blob', 'fists', 'legs']);
    expect(r.show.sim.fighters().every((f) => f.action === 'frozen')).toBe(true);
    r.run(GROUP_DROP_IN_S + 0.2);
    expect(r.show.sim.fighters().some((f) => f.action === 'frozen')).toBe(false);
    expect(r.match.fighting).toHaveLength(3);
  });

  test('a level pick after the crowning: the champion stands crowned on the new level’s top platform', () => {
    const r = rig();
    for (const k of ['fists', 'legs']) r.show.register(card(k));
    r.show.quickFill(['fists', 'legs']);
    r.run(0.5);
    r.show.crown();
    const champ = r.show.champion!;
    r.show.setLevel('ship');
    expect(r.show.champion).toBe(champ);
    expect(r.log.crowns.at(-1)).toEqual([champ, true]); // already up top on the new level: crowned under its confetti
    r.run(1);
    const top = topSpot(LEVELS.ship), f = r.fighter(champ)!;
    expect(f.mover.pos.x).toBeCloseTo(top.x, 6);
    expect(f.mover.pos.y).toBeCloseTo(top.y, 6);
    expect(r.match.phase).toBe('crowned');
    expect(r.show.again()).toBe(true);
    expect(r.show.levelId).toBe('toyroom'); // Again! goes on from the level picked
  });

  test('a level pick after the confetti: the old shower stops and the champion is crowned again on the new level', () => {
    const r = rig();
    for (const k of ['fists', 'legs', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'legs', 'blob']);
    r.run(0.5);
    r.show.crown();
    const champ = r.show.champion!;
    r.run(CARRY_S + 0.2);
    expect(r.log.crowns.at(-1)).toEqual([champ, true]);
    const stopped = r.log.stopConfetti;
    r.show.setLevel('toyroom');
    expect(r.log.stopConfetti).toBe(stopped + 1);
    expect(r.log.crowns.at(-1)).toEqual([champ, true]);
    expect(r.show.loop.thinking).toBe(false);
    r.sfx.ding.mockClear();
    r.run(30);
    expect(r.sfx.ding).not.toHaveBeenCalled(); // no presents on a crowned level
    expect(r.show.sim.mischief.active).toBeNull();
  });

  test('a level pick while crowned keeps the fight over even when the champion is no longer on the stage', () => {
    const r = rig();
    for (const k of ['fists', 'legs', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'legs', 'blob']);
    r.run(0.5);
    r.show.crown();
    const champ = r.show.champion!;
    r.run(CARRY_S + 0.2);
    knockOff(r.fighter(champ)!);
    r.run(0.1);
    expect(r.fighter(champ)).toBeUndefined();
    r.show.setLevel('ship');
    expect(r.show.loop.thinking).toBe(false);
    r.sfx.ding.mockClear();
    r.run(30);
    expect(r.sfx.ding).not.toHaveBeenCalled();
    expect(r.show.sim.mischief.active).toBeNull();
    expect(r.show.sim.fighters().every((f) => f.action !== 'attack' && f.action !== 'special')).toBe(true);
  });

  test('while crowned the others turn toward the champion in their pose; the fight’s own facing is left alone', () => {
    const r = rig();
    for (const k of ['fists', 'legs', 'blob', 'tail']) r.show.register(card(k));
    r.show.quickFill(['fists', 'legs', 'blob', 'tail']);
    r.run(0.5);
    r.show.crown();
    const champ = r.show.champion!;
    // everyone else stands facing away from where the champion goes
    const top = topSpot(LEVELS.jungle);
    for (const f of r.show.sim.fighters()) if (f.id !== champ) f.facing = top.x >= f.mover.pos.x ? -1 : 1;
    const facing = new Map(r.show.sim.fighters().map((f) => [f.id, f.facing]));
    r.run(CARRY_S + 3);
    const cx = r.fighter(champ)!.mover.pos.x;
    let standing = 0;
    for (const f of r.show.sim.fighters()) {
      if (f.id === champ) continue;
      expect(f.facing, f.id).toBe(facing.get(f.id)); // the sim's facing is the fight's, never the show's
      const a = r.drawn.get(f.id)!.a;
      if (a.action !== 'idle' && a.action !== 'land') continue;
      standing++;
      expect(a.facing, f.id).toBe(cx >= f.mover.pos.x ? 1 : -1);
    }
    expect(standing).toBeGreaterThan(0);
  });

  test('Clear the stage: everyone off, the crown gone, the start screen’s state', () => {
    const r = rig();
    for (const k of ['fists', 'legs']) r.show.register(card(k));
    r.show.quickFill(['fists', 'legs']);
    r.run(0.5);
    r.show.crown();
    r.show.reset();
    expect(r.match.fighting).toEqual([]);
    expect(r.match.phase).toBe('open');
    expect(r.show.sim.fighters()).toEqual([]);
    expect(r.on.size).toBe(0);
    expect(r.log.uncrown).toBe(1);
    expect(r.show.champion).toBeNull();
    expect(r.show.cardCount).toBe(0);
    expect(r.banner.hide).toHaveBeenCalled();
  });

  test('a creature is laid out from its own body’s skeleton (the worker’s), so its picture always fits its pose', () => {
    const recipe = loadFixture('tail'), other = buildSkeleton(loadFixture('fists'));
    const { stats } = RumbleShow.check(recipe, { skeleton: other } as BodyData);
    expect(stats.layout.boneSegment).toHaveLength(other.bones.length);
  });
});

describe('RumbleShow: a controller steers a creature (Task 17)', () => {
  test('the steered one follows its pad while the fight is open, stands while crowned, and follows again after Again!', () => {
    const r = rig();
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    let asked = 0;
    r.show.steer('fists', () => {
      asked++;
      return { ...NO_INTENT, mx: 1 };
    });
    expect(r.show.steered('fists')).toBe(true);
    const x0 = r.fighter('fists')!.mover.pos.x;
    r.run(0.5);
    expect(asked).toBeGreaterThanOrEqual(29);
    expect(r.fighter('fists')!.mover.pos.x).toBeGreaterThan(x0 + 1);
    // crowned: nobody moves, the pad included
    expect(r.show.crown()).toBe(true);
    const n = asked;
    r.run(1);
    expect(asked).toBe(n);
    // Again!: a new fight on the next level; the pad steers it again once the fight is open
    expect(r.show.again()).toBe(true);
    r.run(GROUP_DROP_IN_S + 0.5);
    expect(r.show.levelId).toBe('ship');
    expect(asked).toBeGreaterThan(n);
    // given back: the AI drives it
    r.show.steer('fists', null);
    expect(r.show.steered('fists')).toBe(false);
    const m = asked;
    r.run(0.5);
    expect(asked).toBe(m);
  });

  test('a level pick keeps the pad on its creature', () => {
    const r = rig();
    for (const k of ['fists', 'blob']) r.show.register(card(k));
    r.show.quickFill(['fists', 'blob']);
    let asked = 0;
    r.show.steer('blob', () => (asked++, NO_INTENT));
    r.show.setLevel('toyroom');
    r.run(GROUP_DROP_IN_S + 0.5);
    const n = asked;
    r.run(0.5);
    expect(asked).toBeGreaterThan(n);
  });
});
