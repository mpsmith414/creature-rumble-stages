import { describe, expect, it } from 'vitest';
import { fillSlots, LINES } from '../../src/announcer/lines';
import { performCall, StageCalls, TRAIN_POP, type Call } from '../../src/show/stage-calls';
import { STAGE_TUNE } from '../../src/stage/damage';
import type { StageEvents } from '../../src/stage/sim';

const NAMES: Record<string, string> = { a: 'Pip', b: 'Captain Wobble', c: 'Zed' };
const events = (over: Partial<StageEvents> = {}): StageEvents => ({
  hits: [], outs: [], moves: [], specials: [], grabs: [], items: [], mischief: [], bumps: [], ...over,
});
const calls = (over: Partial<StageEvents> = {}, fighters: { id: string; damage: number }[] = [], c = new StageCalls((id) => NAMES[id] ?? id, () => 0)) =>
  c.calls(events(over), fighters.map((f) => ({ ...f, tune: STAGE_TUNE })));
const says = (cs: Call[]) => cs.filter((c): c is Extract<Call, { kind: 'say' }> => c.kind === 'say');
const pops = (cs: Call[]) => cs.filter((c): c is Extract<Call, { kind: 'pop' }> => c.kind === 'pop');

describe('StageCalls: what the show does for a step of the fight', () => {
  it('a hit pops a word and is chatter (a big launch is a big hit); a tumble pops bigger', () => {
    const small = calls({ hits: [{ attacker: 'a', target: 'b', at: { x: 1, y: 2 }, power: 1, launch: 6, tumble: false }] });
    expect(says(small)).toEqual([{ kind: 'say', beat: 'hit', slots: { name: 'Pip', other: 'Captain Wobble' } }]);
    expect(pops(small)).toHaveLength(1);
    expect(pops(small)[0].at).toEqual({ x: 1, y: 2 });
    const big = calls({ hits: [{ attacker: 'a', target: 'b', at: { x: 1, y: 2 }, power: 1, launch: 16, tumble: true }] });
    expect(says(big)[0].beat).toBe('bigHit');
    expect(pops(big)[0].size).toBeGreaterThan(pops(small)[0].size);
  });

  it('a present from the sky is announced with what is inside; opening one pops its name', () => {
    const drop = calls({ items: [{ phase: 'drop', item: 'custardPie', at: { x: 3, y: 15 } }] });
    const s = says(drop)[0];
    expect(s.beat).toBe('present');
    expect(s.slots.event).toBe('CUSTARD PIE');
    expect(s.title).toMatch(/PRESENT/);
    const open = calls({ items: [{ phase: 'open', item: 'icePop', id: 'a', at: { x: 3, y: 1 } }] });
    expect(pops(open)[0].word).toBe('ICE POP!');
    // a pie that splats someone pops SPLAT!; one that missed pops nothing
    expect(pops(calls({ items: [{ phase: 'end', item: 'custardPie', id: 'a', at: { x: 1, y: 1 }, target: 'b' }] }))[0].word).toBe('SPLAT!');
    expect(pops(calls({ items: [{ phase: 'end', item: 'custardPie', id: 'a', at: { x: 1, y: 1 } }] }))).toHaveLength(0);
  });

  it('a level mischief starting is called by name with its title; its end is quiet', () => {
    const s = says(calls({ mischief: [{ name: 'vines', phase: 'start' }] }))[0];
    expect(s).toMatchObject({ beat: 'levelEvent', slots: { event: 'SWINGING VINES' }, title: 'SWINGING VINES!' });
    expect(says(calls({ mischief: [{ name: 'vines', phase: 'end' }] }))).toHaveLength(0);
    // every title says what is happening (not just a place: "RIVER" read oddly in the lines)
    expect(says(calls({ mischief: [{ name: 'river', phase: 'start' }] }))[0]).toMatchObject({ slots: { event: 'SPLASHY RIVER' }, title: 'SPLASHY RIVER!' });
    expect(says(calls({ mischief: [{ name: 'airlock', phase: 'start' }] }))[0]).toMatchObject({ slots: { event: 'AIRLOCK OPEN' }, title: 'AIRLOCK OPEN!' });
  });

  it('a toy-train bump pops TOOT TOOT! with a boing (no one to name)', () => {
    const cs = calls({ bumps: [{ by: 'toyTrain', target: 'b', at: { x: 2, y: 1 }, launch: 9, tumble: false }] });
    expect(pops(cs)[0]).toMatchObject({ word: TRAIN_POP, at: { x: 2, y: 1 } });
    expect(cs.some((c) => c.kind === 'sound' && c.sound === 'boing')).toBe(true);
    expect(says(cs)).toHaveLength(0);
  });

  it('a special winding up names it (said without its "!"), a grab is the throw beat, a knockout names who flew', () => {
    const sp = says(calls({ specials: [{ id: 'a', special: 'megaPunch', phase: 'charge', at: { x: 0, y: 0 } }] }))[0];
    expect(sp).toMatchObject({ beat: 'special', slots: { name: 'Pip', special: 'MEGA PUNCH' }, title: 'MEGA PUNCH!' });
    expect(says(calls({ specials: [{ id: 'a', special: 'megaPunch', phase: 'impact', at: { x: 0, y: 0 } }] }))).toHaveLength(0);
    expect(says(calls({ grabs: [{ id: 'a', other: 'b', phase: 'grab' }] }))[0]).toMatchObject({ beat: 'throw', slots: { name: 'Pip', other: 'Captain Wobble' } });
    const ko = says(calls({ outs: ['b', 'c'] }))[0];
    expect(ko.beat).toBe('knockOut');
    expect(ko.slots.other).toBe('Captain Wobble and Zed');
    for (const l of LINES.knockOut) expect(fillSlots(l, ko.slots)).not.toMatch(/[{}]/);
  });

  /** The warnings and take-backs among some calls. */
  const warns = (cs: Call[]) => cs.filter((x): x is Extract<Call, { kind: 'warn' }> => x.kind === 'warn');
  const cancels = (cs: Call[]) => cs.filter((x) => x.kind === 'cancel');

  it('warns once as a creature reaches "about to fly", and again only after it cooled down and climbed back', () => {
    const c = new StageCalls((id) => NAMES[id] ?? id, () => 0);
    const step = (damage: number) => calls({}, [{ id: 'a', damage }], c);
    const fly = STAGE_TUNE.damageSteps[2];
    expect(warns(step(fly - 1))).toHaveLength(0);
    expect(warns(step(fly))).toEqual([{ kind: 'warn', who: [{ id: 'a', name: 'Pip' }] }]);
    expect(warns(step(fly + 30))).toHaveLength(0);
    // an Ice Pop: no warning, and a warning still held for it is taken back
    const cooled = step(0);
    expect(warns(cooled)).toHaveLength(0);
    expect(cancels(cooled)).toEqual([{ kind: 'cancel', id: 'a' }]);
    expect(warns(step(fly))).toHaveLength(1);
    // leaving the stage takes back a held warning too, and a comeback with the same id starts afresh
    expect(c.forget('a')).toEqual({ kind: 'cancel', id: 'a' });
    expect(warns(step(fly))).toHaveLength(1);
  });

  it('a creature knocked out on the very step it reaches "about to fly" is never warned (its knockout is called)', () => {
    const fly = STAGE_TUNE.damageSteps[2];
    const cs = calls({ outs: ['b'] }, [{ id: 'a', damage: fly }, { id: 'b', damage: fly + 40 }]);
    expect(warns(cs)).toEqual([{ kind: 'warn', who: [{ id: 'a', name: 'Pip' }] }]);
    expect(says(cs).map((x) => x.beat)).toContain('knockOut');
    expect(warns(calls({ outs: ['a'] }, [{ id: 'a', damage: fly }]))).toHaveLength(0);
  });

  it('several reaching "about to fly" in the same step are all warned, in one line naming them all', () => {
    const fly = STAGE_TUNE.damageSteps[2];
    const c = new StageCalls((id) => NAMES[id] ?? id, () => 0);
    const first = calls({}, [{ id: 'a', damage: fly }, { id: 'b', damage: fly }, { id: 'c', damage: fly }], c);
    expect(warns(first)).toEqual([{ kind: 'warn', who: [{ id: 'a', name: 'Pip' }, { id: 'b', name: 'Captain Wobble' }, { id: 'c', name: 'Zed' }] }]);
    // and one reaching it a step later gets its own warning (the first list is not changed under the caller)
    const later = calls({}, [{ id: 'a', damage: fly }, { id: 'b', damage: fly }, { id: 'c', damage: fly }, { id: 'd', damage: fly }], c);
    expect(warns(later)).toEqual([{ kind: 'warn', who: [{ id: 'd', name: 'd' }] }]);
    expect(warns(first)[0].who).toHaveLength(3);
  });
});

describe('performCall (Task 15: shared by the dev page and the Rumble)', () => {
  it('says, warns, takes back, pops and plays what the calls say', () => {
    const log: string[] = [];
    const sinks = {
      announcer: {
        say: (beat: string) => (log.push(`say ${beat}`), { text: beat }),
        warn: (who: readonly { name: string }[]) => (log.push(`warn ${who.map((w) => w.name).join()}`), { text: 'w' }),
        cancelHeld: (id: string) => void log.push(`cancel ${id}`),
      },
      sfx: {
        bonk: () => void log.push('bonk'), whoosh: () => void log.push('whoosh'), thud: () => void log.push('thud'),
        airhorn: () => void log.push('airhorn'), ding: () => void log.push('ding'), sproing: () => void log.push('sproing'),
        boing: (m: number) => void log.push(`boing ${m}`),
      },
      pop: (at: { x: number; y: number }, word: string) => void log.push(`pop ${word} ${at.x}`),
      said: [] as string[],
    };
    const all: Call[] = [
      { kind: 'say', beat: 'hit', slots: {} }, { kind: 'warn', who: [{ id: 'a', name: 'Pip' }] }, { kind: 'cancel', id: 'a' },
      { kind: 'pop', at: { x: 2, y: 1 }, word: 'POW!', size: 1 }, { kind: 'sound', sound: 'boing' }, { kind: 'sound', sound: 'thud' },
    ];
    for (const c of all) performCall(c, sinks);
    expect(log).toEqual(['say hit', 'warn Pip', 'cancel a', 'pop POW! 2', 'boing 1', 'thud']);
    expect(sinks.said).toEqual(['hit', 'aboutToFly']);
  });
});
