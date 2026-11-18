import { describe, expect, test } from 'vitest';
import { Match } from '../../src/match/match';
import { ENTRANCE_S, GROUP_ENTRANCE_S, type MatchEvent } from '../../src/match/rules';

const names = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
const starts = (evs: MatchEvent[]) => evs.filter((e) => e.type === 'entranceStart');

/** A Match with `ids` already fighting. */
function withFighters(ids: string[], o?: { maxOnStage?: number; freeze?: boolean }): Match {
  const m = new Match(o);
  m.arrive(ids);
  m.tick(0.1);
  m.tick(GROUP_ENTRANCE_S + ENTRANCE_S);
  return m;
}

describe('Match', () => {
  test('first arrival enters alone without freezing', () => {
    const m = new Match();
    m.arrive(['a']);
    expect(m.tick(0.1)).toContainEqual({ type: 'entranceStart', ids: ['a'], group: false });
    expect(m.frozen).toBe(false);
    expect(m.entering).toEqual(['a']);
  });

  test('arrivals within the share window enter together', () => {
    const m = new Match();
    m.arrive(['a']);
    const first = m.tick(1.0);
    expect(first).toContainEqual({ type: 'entranceStart', ids: ['a'], group: false });
    m.arrive(['b']);
    const evs = m.tick(0.1);
    expect(evs).toContainEqual({ type: 'entranceStart', ids: ['a', 'b'], group: true });
    expect(starts(evs)).toHaveLength(1);
    expect(evs).not.toContainEqual({ type: 'entranceStart', ids: ['b'], group: false });
    expect(m.entering).toEqual(['a', 'b']);
    // the shared entrance runs the group length from the join
    expect(m.tick(GROUP_ENTRANCE_S - 0.1 - 1e-6)).toEqual([]);
    expect(m.tick(0.01)).toContainEqual({ type: 'entranceEnd', ids: ['a', 'b'] });
  });

  test('an arrival after the share window waits for the next entrance', () => {
    const m = new Match();
    m.arrive(['a']);
    m.tick(2.0);
    m.arrive(['b']);
    expect(m.onDeck).toEqual(['b']);
    expect(m.tick(0.1)).toEqual([]);
    const evs = m.tick(ENTRANCE_S);
    expect(evs).toContainEqual({ type: 'entranceEnd', ids: ['a'] });
    expect(evs).toContainEqual({ type: 'entranceStart', ids: ['b'], group: false });
    expect(m.onDeck).toEqual([]);
  });

  test('entrance freezes a running fight and ends after ENTRANCE_S', () => {
    const m = withFighters(['a']);
    expect(m.fighting).toEqual(['a']);
    m.arrive(['b']);
    m.tick(0.1);
    expect(m.frozen).toBe(true);
    expect(m.tick(ENTRANCE_S)).toContainEqual({ type: 'entranceEnd', ids: ['b'] });
    expect(m.frozen).toBe(false);
    expect(m.fighting).toEqual(['a', 'b']);
  });

  test('freeze:false never freezes', () => {
    const m = withFighters(['a'], { freeze: false });
    m.arrive(['b']);
    m.tick(0.1);
    expect(m.frozen).toBe(false);
  });

  test('ninth waits on deck and enters after a knockout', () => {
    const m = withFighters(names(8));
    expect(m.fighting).toHaveLength(8);
    m.arrive(['i']);
    expect(m.onDeck).toEqual(['i']);
    expect(m.tick(1)).toEqual([]);
    m.knockOut(['a']);
    const evs = m.tick(0.1);
    expect(evs).toContainEqual({ type: 'entranceStart', ids: ['i'], group: false });
    expect(m.onDeck).toEqual([]);
  });

  test('ten arrivals never exceed eight on the stage, entrances never overlap', () => {
    const m = new Match();
    let running = 0;
    const watch = (evs: MatchEvent[]) => {
      for (const e of evs) {
        // a group start that re-announces a running entrance is a join, not a second entrance
        if (e.type === 'entranceStart' && running === 0) running += 1;
        if (e.type === 'entranceEnd') running -= 1;
        expect(running).toBeLessThanOrEqual(1);
      }
      expect(m.fighting.length + m.entering.length).toBeLessThanOrEqual(8);
    };
    const ids = names(10);
    for (let t = 0; t < 40; t++) {
      if (t % 4 === 0 && t / 4 < 10) m.arrive([ids[t / 4]]);
      watch(m.tick(0.5));
    }
    for (let t = 0; t < 60; t++) watch(m.tick(0.5));
    expect(m.fighting).toHaveLength(8);
    expect(m.onDeck).toHaveLength(2);
    expect(m.fighting.length + m.onDeck.length + m.entering.length).toBe(10);
  });

  test('a joiner past capacity waits on deck', () => {
    const m = withFighters(names(7));
    m.arrive(['h']);
    m.tick(0.1);
    m.arrive(['i']);
    expect(m.onDeck).toEqual(['i']);
    expect(m.entering).toEqual(['h']);
  });

  test('lone fighter is announced once', () => {
    const m = new Match();
    m.arrive(['a']);
    m.tick(0.1);
    const end = m.tick(ENTRANCE_S);
    expect(end).toContainEqual({ type: 'lone', id: 'a' });
    expect(m.tick(1)).toEqual([]);
    expect(m.tick(1)).toEqual([]);
  });

  test('lone re-arms when the stage empties, so a fresh lone fighter is announced', () => {
    const m = new Match();
    m.arrive(['a']);
    m.tick(0.1);
    expect(m.tick(ENTRANCE_S)).toContainEqual({ type: 'lone', id: 'a' });
    m.knockOut(['a']);
    m.arrive(['b']);
    m.tick(0.1);
    expect(m.tick(ENTRANCE_S)).toContainEqual({ type: 'lone', id: 'b' });
  });

  test('lone is not announced while someone enters', () => {
    const m = withFighters(['a', 'b']);
    m.arrive(['c']);
    m.tick(0.1);
    m.knockOut(['a']);
    expect(m.tick(0.1)).not.toContainEqual(expect.objectContaining({ type: 'lone' }));
  });

  test('two falling out together is a tie', () => {
    const m = withFighters(['a', 'b']);
    const evs = m.knockOut(['a', 'b']);
    expect(evs).toContainEqual({ type: 'knockOut', ids: ['a', 'b'] });
    expect(evs).toContainEqual({ type: 'tie', ids: ['a', 'b'] });
    expect(m.fighting).toEqual([]);
  });

  test('a single fighter going out alone is just a knockout', () => {
    const m = withFighters(['a']);
    expect(m.knockOut(['a'])).toEqual([{ type: 'knockOut', ids: ['a'] }]);
  });

  test('one left with nobody waiting holds the stage', () => {
    const m = withFighters(['a', 'b', 'c']);
    expect(m.knockOut(['a'])).toEqual([{ type: 'knockOut', ids: ['a'] }]);
    expect(m.knockOut(['b'])).toContainEqual({ type: 'holdsStage', id: 'c' });
  });

  test('one left with somebody waiting does not hold the stage', () => {
    const m = withFighters(['a', 'b']);
    m.arrive(['c']);
    m.tick(0.1);
    const evs = m.knockOut(['a']);
    expect(evs).not.toContainEqual(expect.objectContaining({ type: 'holdsStage' }));
  });

  test('a knockout of unknown ids does nothing', () => {
    const m = withFighters(['a', 'b']);
    expect(m.knockOut(['zzz'])).toEqual([]);
  });

  test('crown picks most hits, again brings the cast back champion last (newcomers before it)', () => {
    const m = withFighters(['a', 'b', 'c']);
    const evs = m.crown(new Map([['a', 1], ['b', 5], ['c', 2]]));
    expect(evs).toEqual([{ type: 'crowned', id: 'b', others: ['a', 'c'] }]);
    expect(m.phase).toBe('crowned');
    expect(m.lastCast).toEqual(['a', 'c', 'b']);
    m.arrive(['d']);
    expect(m.onDeck).toEqual(['d']);
    expect(m.tick(1)).toEqual([]);
    const again = m.again();
    expect(again).toContainEqual({ type: 'again', ids: ['a', 'c', 'd', 'b'] });
    expect(starts(again)).toEqual([{ type: 'entranceStart', ids: ['a', 'c', 'd', 'b'], group: true }]);
    expect(m.phase).toBe('open');
    expect(m.fighting).toEqual([]);
    expect(m.entering).toEqual(['a', 'c', 'd', 'b']);
    expect(m.tick(GROUP_ENTRANCE_S)).toContainEqual({ type: 'entranceEnd', ids: ['a', 'c', 'd', 'b'] });
  });

  test('crown ties go to the earliest arrival, missing hits count as 0', () => {
    const m = withFighters(['a', 'b', 'c']);
    expect(m.crown(new Map([['b', 3], ['c', 3]]))[0]).toMatchObject({ id: 'b' });
    const n = withFighters(['a', 'b']);
    expect(n.crown(new Map())[0]).toMatchObject({ id: 'a' });
  });

  test('crown with nobody fighting does nothing; again outside crowned does nothing', () => {
    const m = new Match();
    expect(m.crown(new Map())).toEqual([]);
    expect(m.phase).toBe('open');
    expect(m.again()).toEqual([]);
  });

  test('again caps at maxOnStage and keeps extras on deck', () => {
    const m = withFighters(names(8));
    m.arrive(['i', 'j']);
    m.crown(new Map());
    const evs = m.again();
    expect(starts(evs)[0]).toMatchObject({ group: true });
    expect(m.entering).toHaveLength(8);
    expect(m.onDeck).toHaveLength(2);
  });

  test('again with more than fit: the champion still enters, last of those who go in; the rest wait after it', () => {
    const m = withFighters(names(8));
    m.arrive(['i', 'j']);
    const champ = m.fighting[0];
    m.crown(new Map([[champ, 9]]));
    m.again();
    expect(m.entering).toHaveLength(8);
    expect(m.entering[7]).toBe(champ);
    expect(m.onDeck).toEqual(['i', 'j']);
    expect(m.onDeck).not.toContain(champ);
  });

  test('reset clears everything', () => {
    const m = withFighters(['a', 'b']);
    m.arrive(['c']);
    m.reset();
    expect([m.fighting, m.onDeck, m.entering, m.lastCast]).toEqual([[], [], [], []]);
    expect(m.phase).toBe('open');
    expect(m.frozen).toBe(false);
  });
});

describe('Match on the stage (Task 15)', () => {
  test('entrances last as long as it is told (the stage’s drop-ins), a lone one and a group one', () => {
    const m = new Match({ entrance: 5, group: 4 });
    m.arrive(['a']);
    expect(m.tick(0.1)).toContainEqual({ type: 'entranceStart', ids: ['a'], group: false });
    expect(m.tick(4.85)).toEqual([]);
    expect(m.tick(0.1)).toContainEqual({ type: 'entranceEnd', ids: ['a'] });
    m.arrive(['b', 'c']);
    expect(m.tick(0.1)).toContainEqual({ type: 'entranceStart', ids: ['b', 'c'], group: true });
    expect(m.tick(3.85)).toEqual([]);
    expect(m.tick(0.1)).toContainEqual({ type: 'entranceEnd', ids: ['b', 'c'] });
  });

  test('a knockout is a knockOut; the last one left holds the stage', () => {
    const m = withFighters(['a', 'b']);
    expect(m.knockOut(['a'])).toEqual([{ type: 'knockOut', ids: ['a'] }, { type: 'holdsStage', id: 'b' }]);
  });
});
