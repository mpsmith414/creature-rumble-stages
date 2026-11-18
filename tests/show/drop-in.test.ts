import { Scene } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { LEVELS } from '../../src/levels';
import {
  DROP_IN_S, DropIn, DropInLooks, dropAt, dropHeight, dropSpot, dropSteps, GROUP_DROP_IN_S, landingAt, SOLO_STEPS, topSpot, type DropPhase,
} from '../../src/show/drop-in';
import { platformsAt } from '../../src/stage/level';

const FROM = 12;
/** The phases a drop-in goes through, sampled every 1/60 s from 0 to `end` s, each once in order. */
function phases(steps = SOLO_STEPS, end = DROP_IN_S + 0.5): DropPhase[] {
  const out: DropPhase[] = [];
  for (let t = 0; t <= end; t += 1 / 60) {
    const p = dropAt(t, steps, FROM).phase;
    if (out.at(-1) !== p) out.push(p);
  }
  return out;
}

describe('the drop-in timeline', () => {
  test('a lone drop-in is about 5 s: the camera swoops (it waits above), it floats down, lands, shows off, is done', () => {
    expect(DROP_IN_S).toBeGreaterThanOrEqual(4.5);
    expect(DROP_IN_S).toBeLessThanOrEqual(5.5);
    expect(phases()).toEqual(['wait', 'fall', 'land', 'showoff', 'done']);
    expect(SOLO_STEPS.done).toBe(DROP_IN_S);
    expect(dropAt(0.1, SOLO_STEPS, FROM).lift).toBe(FROM);
  });

  test('the fall starts at its height, comes down without a jump and touches down gently; its parachute opens then folds', () => {
    const s = SOLO_STEPS;
    let last = FROM, fastest = 0;
    for (let t = s.fall; t < s.land; t += 1 / 60) {
      const d = dropAt(t, s, FROM);
      expect(d.lift).toBeLessThanOrEqual(last + 1e-9);
      fastest = Math.max(fastest, last - d.lift);
      last = d.lift;
    }
    expect(fastest).toBeLessThan(FROM * 0.05); // never more than 5% of the drop in one frame
    expect(FROM - dropAt(s.land - 1 / 60, s, FROM).lift).toBeGreaterThan(FROM * 0.99);
    expect(dropAt(s.land - 1 / 60, s, FROM).lift).toBeLessThan(0.01); // gentle: it is nearly there a frame before
    expect(dropAt(s.fall + 0.5, s, FROM).chute).toBe(1);
    expect(dropAt(s.land + 0.01, s, FROM).squash).toBeGreaterThan(0.9);
    expect(dropAt(s.show + 0.01, s, FROM).chute).toBe(0);
    expect(dropAt(s.show + 0.5, s, FROM)).toMatchObject({ phase: 'showoff', lift: 0, squash: 0 });
    expect(dropAt(s.show + 0.5, s, FROM).show).toBeCloseTo(0.5, 6);
    expect(dropAt(Number.NaN, s, FROM).phase).toBe('wait');
  });

  test('a group of eight (the champion last) all land, one after another, and the drop-in is still about 5 s', () => {
    const others = Array.from({ length: 7 }, (_, i) => dropSteps(true, i, 7));
    const champ = dropSteps(true, 0, 7, true);
    const lands = others.map((s) => s.land);
    for (let i = 1; i < lands.length; i++) expect(lands[i]).toBeGreaterThan(lands[i - 1]);
    expect(champ.land).toBeGreaterThan(lands.at(-1)! + 0.3);
    for (const s of [...others, champ]) {
      expect(s.done).toBeGreaterThanOrEqual(s.show + 0.5); // everyone shows off a moment
      expect(s.done).toBeLessThanOrEqual(GROUP_DROP_IN_S + 0.01);
    }
    expect(phases(champ, GROUP_DROP_IN_S + 0.5)).toEqual(['wait', 'fall', 'land', 'showoff', 'done']);
  });
});

describe('DropIn: drop-ins under way', () => {
  const spot = (x: number) => ({ x, y: 0 });

  test('a lone drop-in has a close-up on its spot, says when it lands, and is over after about 5 s', () => {
    const d = new DropIn();
    d.start([{ id: 'a', at: spot(3), from: FROM }], 10);
    expect(d.active).toBe(true);
    expect(d.focus()).toEqual({ x: 3, y: 0 });
    expect(d.state('a')?.phase).toBe('wait');
    const landed: string[] = [];
    let t = 10;
    for (; t < 10 + DROP_IN_S - 0.05; t += 1 / 60) d.update(t, landed);
    expect(landed).toEqual(['a']);
    expect(d.active).toBe(true);
    d.update(10 + DROP_IN_S + 0.01);
    expect(d.active).toBe(false);
    expect(d.state('a')).toBeNull();
  });

  test('arrivals close together share it: a newcomer joining drops as a group (no close-up), each on its own clock', () => {
    const d = new DropIn();
    d.start([{ id: 'a', at: spot(3), from: FROM }], 0);
    d.update(1);
    d.start([{ id: 'a', at: spot(3), from: FROM }, { id: 'b', at: spot(-3), from: FROM }], 1); // the match names both
    expect(d.focus()).toBeNull();
    expect(d.ids().sort()).toEqual(['a', 'b']);
    expect(d.state('a')?.phase).toBe('fall'); // a carries on where it was
    expect(d.state('b')?.phase).toBe('wait');
    d.update(1 + GROUP_DROP_IN_S - 0.1);
    expect(d.state('b')?.phase).not.toBe('wait');
    d.update(1 + GROUP_DROP_IN_S + 0.01);
    expect(d.active).toBe(false);
  });

  test('after Again! the champion drops last; cancel ends them all (or some) at once', () => {
    const d = new DropIn();
    const who = ['a', 'b', 'c', 'champ'].map((id, i) => ({ id, at: spot(i * 3 - 4), from: FROM }));
    d.start(who, 0, { group: true, champion: 'champ' });
    const landed: string[] = [];
    for (let t = 0; t < GROUP_DROP_IN_S; t += 1 / 60) d.update(t, landed);
    expect(landed.at(-1)).toBe('champ');
    expect(landed).toHaveLength(4);
    d.start(who, 10, { group: true });
    d.cancel(['a']);
    expect(d.has('a')).toBe(false);
    expect(d.has('b')).toBe(true);
    d.cancel();
    expect(d.active).toBe(false);
  });
});

describe('where they land and where the champion is crowned', () => {
  const W = 0.8;

  test('a newcomer lands on the first platform under it (never through one), never on a moving one or the bed', () => {
    for (const level of Object.values(LEVELS)) {
      for (const e of level.entries) {
        const s = landingAt(level, 0, e.x, W);
        if (!s) continue; // under a lift or the bed: that entry is not used
        const plats = platformsAt(level, 0);
        const on = plats.find((p) => Math.abs(p.y - s.y) < 1e-9 && Math.abs(s.x - p.x) <= p.w / 2)!;
        expect(on.path).toBeUndefined();
        expect(on.bounce).toBeUndefined();
        expect(Math.abs(s.x - on.x)).toBeLessThanOrEqual(on.w / 2 - W / 2); // the whole box stands on it
        // nothing over it that it would have passed through
        const over = plats.filter((p) => p.y > s.y && Math.abs(s.x - p.x) < p.w / 2 + W / 2);
        expect(over, `${level.id} ${e.x}`).toEqual([]);
      }
      // most entries are spots
      expect(level.entries.filter((e) => landingAt(level, 0, e.x, W)).length).toBeGreaterThanOrEqual(level.entries.length - 2);
    }
    // the space ship's catwalk entries land on the catwalks, the bridge's on the bridge
    expect(landingAt(LEVELS.ship, 0, -7.5, W)?.y).toBe(3.5);
    expect(landingAt(LEVELS.ship, 0, -1.5, W)?.y).toBe(7);
  });

  test('newcomers spread out: each drops above the entry furthest from everyone', () => {
    const level = LEVELS.jungle, taken = [{ x: -10, y: 0 }];
    const a = dropSpot(level, 0, taken, W);
    expect(a.x).toBeGreaterThan(5);
    const b = dropSpot(level, 0, [...taken, a], W);
    expect(Math.abs(b.x - a.x)).toBeGreaterThan(3);
    expect(Math.abs(b.x - taken[0].x)).toBeGreaterThan(3);
  });

  test('the champion is crowned in the middle of the highest platform that stays put', () => {
    expect(topSpot(LEVELS.jungle)).toEqual({ x: 0, y: 7 }); // the canopy (the crown branch moves)
    expect(topSpot(LEVELS.ship)).toEqual({ x: 0, y: 7 }); // the bridge
    const toy = topSpot(LEVELS.toyroom);
    expect(toy.y).toBe(3.5);
    expect(Math.abs(toy.x)).toBeLessThan(5);
  });

  test('a newcomer starts above the top of the view', () => {
    expect(dropHeight(0, 10, 1.4)).toBeGreaterThan(10 + 1.4 - 0.01);
    expect(dropHeight(7, 10, 1.4)).toBeGreaterThan(3 + 1.4);
    expect(dropHeight(20, 10, 1.4)).toBe(1.4); // already above the view: just its height
  });
});

describe('DropInLooks', () => {
  test('a parachute over each falling creature, a beam on the space ship; nothing when nobody drops; disposed cleanly', () => {
    const scene = new Scene(), looks = new DropInLooks(scene);
    const visible = (prefix: string) => looks.root.children.filter((m) => m.name.startsWith(prefix) && m.visible).length;
    looks.update([{ x: 0, y: 3, w: 0.8, h: 1.4, chute: 1, floor: 0 }, { x: 2, y: 5, w: 0.8, h: 1.4, chute: 0.5, floor: 0 }], false, 10, 0);
    expect(visible('drop-chute')).toBe(2);
    expect(visible('drop-beam')).toBe(0);
    const chute = looks.root.children.find((m) => m.name === 'drop-chute-0')!;
    expect(chute.position.y).toBeGreaterThan(3 + 1.4 * 0.5); // its strings reach down to the creature's shoulders
    expect(chute.position.y + chute.scale.y).toBeGreaterThan(3 + 1.4); // the canopy over its head
    expect(chute.position.z).toBeLessThan(0); // behind the play plane
    looks.update([{ x: 0, y: 3, w: 0.8, h: 1.4, chute: 1, floor: 0 }], true, 10, 0);
    expect(visible('drop-chute')).toBe(0);
    expect(visible('drop-beam')).toBe(1);
    const beam = looks.root.children.find((m) => m.name === 'drop-beam-0')!;
    expect(beam.position.y).toBe(0); // it shines down to the landing spot
    expect(beam.position.y + beam.scale.y).toBeGreaterThan(10); // from above the view
    looks.update([], false, 10, 0);
    expect(visible('drop-')).toBe(0);
    looks.dispose();
    expect(scene.children).not.toContain(looks.root);
  });
});
