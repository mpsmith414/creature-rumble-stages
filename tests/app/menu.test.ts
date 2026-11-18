import { describe, expect, test } from 'vitest';
import { CLEAR_ASK, CLEAR_LABEL, CROWN_LABEL, FIGHTING_NOW, LEVEL_TITLE, menuModel, PICK_BACK, PICK_IN, PICK_NONE, PICK_PICK, PICK_SEND, PICK_TITLE, pickerChoices, pickerMove, withPictures, type MenuState } from '../../src/app/menu';

const base: MenuState = { phase: 'open', fighting: 0, joinShown: true, volume: 0.8, muted: false, level: 'jungle' };
const ids = (s: MenuState) => menuModel(s).flatMap((r) => r.items.map((i) => i.id));

describe('the TV menu', () => {
  test('Crown shows only while the fight is open with someone in it; Again! only after a crowning', () => {
    expect(ids(base)).not.toContain('crown');
    expect(ids(base)).not.toContain('again');
    const open = menuModel({ ...base, fighting: 2 });
    expect(open[0].items).toEqual([{ id: 'crown', label: CROWN_LABEL }]);
    expect(ids({ ...base, fighting: 2 })).not.toContain('again');
    expect(ids({ ...base, phase: 'crowned', fighting: 1 })).toEqual(expect.arrayContaining(['again']));
    expect(ids({ ...base, phase: 'crowned', fighting: 1 })).not.toContain('crown');
  });

  test('always: Level, Fighters, Show join code, Sound, Clear the stage and back to the fight', () => {
    expect(ids(base)).toEqual(['jungle', 'ship', 'toyroom', 'fighters', 'join', 'down', 'up', 'mute', 'clear', 'resume']);
    const labels = menuModel(base).flatMap((r) => r.items.map((i) => i.label));
    expect(labels).toEqual(expect.arrayContaining(['Fighters', 'Show join code', 'Clear the stage']));
  });

  test('the level row (Task 15): Level: Jungle / Space Ship / Toy Room, the one the fight is on picked', () => {
    const row = (s: MenuState) => menuModel(s).find((r) => r.id === 'level')!;
    expect(row(base).title).toBe(LEVEL_TITLE);
    expect(row(base).items.map((i) => i.label)).toEqual(['Jungle', 'Space Ship', 'Toy Room']);
    expect(row(base).items.filter((i) => i.selected).map((i) => i.id)).toEqual(['jungle']);
    expect(row({ ...base, level: 'toyroom' }).items.filter((i) => i.selected).map((i) => i.id)).toEqual(['toyroom']);
    // under Crown or Again! when they show, at the top otherwise
    expect(menuModel({ ...base, fighting: 2 }).map((r) => r.id).slice(0, 2)).toEqual(['fight', 'level']);
    expect(menuModel(base)[0].id).toBe('level');
  });

  test('no ring words in the menu', () => {
    const words = [CLEAR_ASK, CLEAR_LABEL, FIGHTING_NOW, ...[base, { ...base, fighting: 2 }, { ...base, phase: 'crowned' as const, fighting: 1 }]
      .flatMap((s) => menuModel(s).flatMap((r) => [r.title ?? '', ...r.items.map((i) => i.label)]))];
    for (const w of words) expect(w).not.toMatch(/(ring|rope|ropes|bumper|ball pit)/i);
  });

  test('the join code and the sound show their state; volume stops at its ends', () => {
    const row = (s: MenuState, id: string) => menuModel(s).find((r) => r.id === id)!;
    expect(row(base, 'join').items[0].selected).toBe(true);
    expect(row({ ...base, joinShown: false }, 'join').items[0].selected).toBe(false);
    expect(row(base, 'volume').level).toBe(8);
    expect(row({ ...base, volume: 0 }, 'volume').items[0].disabled).toBe(true);
    expect(row({ ...base, volume: 1 }, 'volume').items[1].disabled).toBe(true);
    const muted = row({ ...base, muted: true }, 'volume');
    expect(muted.off).toBe(true);
    expect(muted.items[2]).toMatchObject({ label: 'Sound on', selected: true });
  });
});

describe('the pad picker (Task 17): Start on a free controller picks a creature to steer', () => {
  const roster = [
    { id: 'a', name: 'Pip', thumb: 'data:image/jpeg;base64,AA==' },
    { id: 'r1', name: 'Mo', thumb: null },
    { id: 'r2', name: 'Zed', thumb: 'data:image/jpeg;base64,BB==' },
  ];

  test('the creatures in play come first (not those another pad steers), then the roster to send in', () => {
    const inPlay = [{ id: 'a', name: 'Pip' }, { id: 'b', name: 'Bonk' }, { id: 'c', name: 'Cog' }];
    const got = pickerChoices(inPlay, roster, (id) => id === 'c');
    expect(got).toEqual([
      { id: 'a', name: 'Pip', thumb: 'data:image/jpeg;base64,AA==', inPlay: true },
      { id: 'b', name: 'Bonk', thumb: null, inPlay: true }, // a dev fixture: no roster picture
      { id: 'r1', name: 'Mo', thumb: null, inPlay: false },
      { id: 'r2', name: 'Zed', thumb: 'data:image/jpeg;base64,BB==', inPlay: false },
    ]);
    expect(pickerChoices([], [], () => false)).toEqual([]);
  });

  test('every card shows its own creature: the roster picture, else a picture of its body (never the glove when there is one)', async () => {
    const inPlay = [{ id: 'a', name: 'Pip' }, { id: 'b', name: 'Bonk' }, { id: 'c', name: 'Cog' }];
    const roster2 = [...roster, { id: 'r3', name: 'Nub', thumb: null }];
    const bodies = new Set(['b', 'c', 'r1', 'r3']); // everyone but 'a' (which has a roster picture) and the missing ones
    const asked: string[] = [];
    const picture = async (id: string) => {
      asked.push(id);
      if (id === 'c') throw new Error('the GPU is busy'); // a failed picture: the glove, nothing breaks
      return bodies.has(id) ? `data:image/png;base64,${id}` : null;
    };
    const got = await withPictures(pickerChoices(inPlay, roster2, () => false), picture);
    expect(got.map((c) => [c.id, c.thumb])).toEqual([
      ['a', 'data:image/jpeg;base64,AA=='],
      ['b', 'data:image/png;base64,b'],
      ['c', null],
      ['r1', 'data:image/png;base64,r1'],
      ['r2', 'data:image/jpeg;base64,BB=='],
      ['r3', 'data:image/png;base64,r3'],
    ]);
    expect(asked.sort()).toEqual(['b', 'c', 'r1', 'r3']); // only the ones with no roster picture
  });

  test('the d-pad or stick moves along the row and stops at the ends', () => {
    expect(pickerMove(0, 3, 'right')).toBe(1);
    expect(pickerMove(1, 3, 'down')).toBe(2);
    expect(pickerMove(2, 3, 'right')).toBe(2);
    expect(pickerMove(2, 3, 'left')).toBe(1);
    expect(pickerMove(1, 3, 'up')).toBe(0);
    expect(pickerMove(0, 3, 'left')).toBe(0);
    expect(pickerMove(0, 0, 'right')).toBe(0);
  });

  test('its words are short and friendly, with no ring words', () => {
    for (const w of [PICK_TITLE, PICK_NONE, PICK_IN, PICK_SEND, PICK_PICK, PICK_BACK]) {
      expect(w.length).toBeLessThan(45);
      expect(w).not.toMatch(/(ring|rope|bumper|ball pit)/i);
    }
  });
});
