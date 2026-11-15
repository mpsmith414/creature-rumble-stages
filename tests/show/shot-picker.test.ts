import { Vector3 } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import type { Hit } from '../../src/fight/fighter';
import {
  BIG_FLIGHT, CALM_HOLD, COOLED, CUE_COOLDOWN, CUE_HOLD, FOLLOW_AFTER, MAX_HOLD, MIN_HOLD, QUICK_HOLD, ROTATE_MAX, ROTATE_MIN, ShotPicker,
  shotCues, URGENT, WAIT_FOR, type RingView, type ShotCue,
} from '../../src/show/shot-picker';
import { SHOT_NAMES, type ShotName } from '../../src/show/shots';
import { mulberry32 } from '../../src/util/rng';

const DT = 1 / 60;
const ring = (n: number, o: Partial<RingView> = {}): RingView => {
  const ids = Array.from({ length: n }, (_, i) => `f${i}`);
  return { ids, pair: n >= 2 ? [ids[0], ids[1]] : null, star: null, event: false, ...o };
};
/** Runs the picker `secs` with no cues; counts how long each shot is on and every cut's hold. */
function rotate(p: ShotPicker, r: RingView, secs: number) {
  const time: Partial<Record<ShotName, number>> = {}, holds: number[] = [];
  let held = 0;
  const repeats: string[] = [];
  let last = p.pick.shot;
  for (let t = 0; t < secs; t += DT) {
    const cut = p.update(DT, r, []);
    held += DT;
    if (cut) {
      holds.push(held);
      held = 0;
      if (cut.shot === last) repeats.push(cut.shot);
      last = cut.shot;
    }
    time[p.pick.shot] = (time[p.pick.shot] ?? 0) + DT;
  }
  return { time, holds, repeats };
}
const share = (time: Partial<Record<ShotName, number>>, ...names: ShotName[]) => {
  let all = 0, some = 0;
  for (const [k, v] of Object.entries(time)) { all += v; if (names.includes(k as ShotName)) some += v; }
  return some / all;
};

describe('the shot picker: the rotation', () => {
  test('moves on every 5–8 s, never longer than 9 s, never the same shot twice running', () => {
    const p = new ShotPicker(mulberry32(1));
    const { holds, repeats, time } = rotate(p, ring(4), 600);
    expect(holds.length).toBeGreaterThan(600 / ROTATE_MAX - 2);
    for (const h of holds.slice(1)) {
      expect(h).toBeGreaterThanOrEqual(ROTATE_MIN - DT);
      expect(h).toBeLessThanOrEqual(Math.min(MAX_HOLD, ROTATE_MAX) + 2 * DT);
    }
    expect(repeats).toEqual([]);
    expect(Object.keys(time).sort()).toEqual(['duel', 'hero', 'low', 'top', 'wide']);
  });

  test('two fighting: more duels and low shots; five or more: more wide and top shots; an event: top, wide and the crane', () => {
    const two = rotate(new ShotPicker(mulberry32(2)), ring(2), 3000).time;
    const five = rotate(new ShotPicker(mulberry32(2)), ring(6), 3000).time;
    const event = rotate(new ShotPicker(mulberry32(2)), ring(4, { event: true }), 3000).time;
    const four = rotate(new ShotPicker(mulberry32(2)), ring(4), 3000).time;
    expect(share(two, 'duel', 'low')).toBeGreaterThan(share(four, 'duel', 'low') + 0.1);
    expect(share(five, 'wide', 'top')).toBeGreaterThan(share(four, 'wide', 'top') + 0.1);
    expect(share(event, 'top', 'wide', 'crane')).toBeGreaterThan(share(four, 'top', 'wide', 'crane') + 0.1);
    expect(event.crane ?? 0).toBeGreaterThan(0);
    expect(four.crane ?? 0).toBe(0);
    expect(four.flier ?? 0).toBe(0); // the flier and ring-out shots come only from their moments
    expect(four.ringOut ?? 0).toBe(0);
  });

  test('a duel needs a pair; nobody fighting is the wide shot only', () => {
    const lone = rotate(new ShotPicker(mulberry32(3)), ring(1), 400).time;
    expect(lone.duel ?? 0).toBe(0);
    const none = rotate(new ShotPicker(mulberry32(3)), ring(0), 400).time;
    expect(Object.keys(none)).toEqual(['wide']);
  });

  test('the same dice give the same shots', () => {
    const a = rotate(new ShotPicker(mulberry32(9)), ring(4), 120), b = rotate(new ShotPicker(mulberry32(9)), ring(4), 120);
    expect(a).toEqual(b);
  });
});

describe('the shot picker: the fight’s moments', () => {
  const settle = (p: ShotPicker, r: RingView, secs: number) => { for (let t = 0; t < secs; t += DT) p.update(DT, r, []); };
  /** A picker whose opening shot has held long enough for any moment to cut in. */
  const ready = (seed: number) => {
    const p = new ShotPicker(mulberry32(seed));
    settle(p, ring(4), CALM_HOLD + 0.05);
    return p;
  };

  test('each moment cuts to its shot, on whom it is about', () => {
    const cases: [ShotCue, ShotName, string | undefined, string | undefined][] = [
      [{ kind: 'ringOut', id: 'f1' }, 'ringOut', 'f1', undefined],
      [{ kind: 'special', id: 'f2' }, 'hero', 'f2', undefined],
      [{ kind: 'throw', id: 'f0', other: 'f3' }, 'duel', 'f0', 'f3'],
      [{ kind: 'launch', id: 'f3' }, 'flier', 'f3', undefined],
      [{ kind: 'event' }, 'crane', undefined, undefined],
      [{ kind: 'round' }, 'crane', undefined, undefined],
    ];
    for (const [cue, shot, a, b] of cases) {
      const cut = ready(4).update(DT, ring(4), [cue]);
      expect(cut?.shot, cue.kind).toBe(shot);
      expect(cut?.a).toBe(a);
      expect(cut?.b).toBe(b);
    }
    const pads = new Set<ShotName>();
    for (let s = 0; s < 20; s++) pads.add(ready(s).update(DT, ring(4), [{ kind: 'pad', id: 'f1' }])!.shot);
    expect([...pads].sort()).toEqual(['hero', 'low']);
  });

  test('a ring-out cuts in at once; a special or throw after QUICK_HOLD s; the rest after CALM_HOLD s', () => {
    const at = (secs: number, cue: ShotCue) => {
      const p = new ShotPicker(mulberry32(5));
      settle(p, ring(4), secs);
      return p.update(DT, ring(4), [cue]) !== null;
    };
    expect(URGENT.has('ringOut') && URGENT.has('special') && URGENT.has('throw')).toBe(true);
    expect(at(0, { kind: 'ringOut', id: 'f1' })).toBe(true);
    for (const cue of [{ kind: 'special', id: 'f0' }, { kind: 'throw', id: 'f0', other: 'f1' }] as ShotCue[]) {
      expect(at(QUICK_HOLD - 0.1, cue), cue.kind).toBe(false);
      expect(at(QUICK_HOLD + 0.05, cue), cue.kind).toBe(true);
    }
    for (const cue of [{ kind: 'launch', id: 'f0' }, { kind: 'pad', id: 'f0' }, { kind: 'event' }, { kind: 'round' }] as ShotCue[]) {
      expect(at(CALM_HOLD - 0.1, cue), cue.kind).toBe(false);
      expect(at(CALM_HOLD + 0.05, cue), cue.kind).toBe(true);
    }
    expect(MIN_HOLD).toBeLessThanOrEqual(CALM_HOLD);
  });

  test('by priority: ring-out > special > grab or throw > big launch > pad jump > event; the higher wins', () => {
    const order: ShotCue[] = [
      { kind: 'event' }, { kind: 'pad', id: 'f0' }, { kind: 'launch', id: 'f1' }, { kind: 'throw', id: 'f2', other: 'f3' },
      { kind: 'special', id: 'f0' }, { kind: 'ringOut', id: 'f1' },
    ];
    expect(ready(5).update(DT, ring(4), order)?.shot).toBe('ringOut'); // all at once: the ring-out wins
    expect(ready(5).update(DT, ring(4), order.slice(0, 5))?.shot).toBe('hero');
    expect(ready(5).update(DT, ring(4), order.slice(0, 3))?.shot).toBe('flier');
    // a lower moment never cuts a higher one's shot, however long it has held
    const s = ready(5);
    s.update(DT, ring(4), [{ kind: 'special', id: 'f0' }]);
    settle(s, ring(4), CALM_HOLD - 0.2);
    for (const c of order.slice(0, 4)) expect(s.update(DT, ring(4), [c]), c.kind).toBeNull();
    expect(s.update(DT, ring(4), [{ kind: 'ringOut', id: 'f2' }])?.shot).toBe('ringOut');
  });

  test('a big launch or a pad jump does not cut in again within CUE_COOLDOWN s of the last of its kind', () => {
    for (const [first, second] of [
      [{ kind: 'pad', id: 'f0' }, { kind: 'pad', id: 'f1' }], [{ kind: 'launch', id: 'f0' }, { kind: 'launch', id: 'f1' }],
    ] as [ShotCue, ShotCue][]) {
      const p = ready(6);
      expect(p.update(DT, ring(4), [first])).not.toBeNull();
      settle(p, ring(4), CUE_COOLDOWN - 0.3); // its shot is over and the rotation's has held CALM_HOLD...
      expect(p.pick.rank).toBe(0);
      expect(p.update(DT, ring(4), [second]), first.kind).toBeNull(); // ...but no second one yet
      settle(p, ring(4), 1); // the cool-down is over (and the rotation shot has held CALM_HOLD)
      expect(p.update(DT, ring(4), [second])?.a, first.kind).toBe('f1');
    }
    expect([...COOLED].sort()).toEqual(['launch', 'pad']);
  });

  test('a special or a throw has no cool-down: a pad jump’s hero shot just before does not hold it back', () => {
    const p = ready(6);
    p.update(DT, ring(4), [{ kind: 'pad', id: 'f0' }]);
    settle(p, ring(4), CUE_HOLD.pad + QUICK_HOLD + 0.05);
    p.update(DT, ring(4), [{ kind: 'special', id: 'f3' }]); // (f3: not in the ring's pair, so never already on screen)
    expect([p.pick.shot, p.pick.a]).toEqual(['hero', 'f3']); // cut to (or already on it, if the rotation chose it)
    settle(p, ring(4), 1.5);
    expect(p.update(DT, ring(4), [{ kind: 'special', id: 'f2' }])).toBeNull(); // a second special soon after waits...
    settle(p, ring(4), CUE_HOLD.special - 1.5 + 0.05);
    expect([p.pick.shot, p.pick.a]).toEqual(['hero', 'f2']); // ...and comes the moment the first one's shot ends
    settle(p, ring(4), CUE_HOLD.special + QUICK_HOLD + 0.05);
    expect(p.update(DT, ring(4), [{ kind: 'throw', id: 'f0', other: 'f3' }])?.shot).toBe('duel');
  });

  test('a special, a throw or an event that comes too soon waits its turn and is shown late, not dropped', () => {
    for (const [cue, shot, waitS] of [
      [{ kind: 'special', id: 'f1' }, 'hero', QUICK_HOLD], [{ kind: 'throw', id: 'f1', other: 'f2' }, 'duel', QUICK_HOLD],
      [{ kind: 'event' }, 'crane', CALM_HOLD],
    ] as [ShotCue, ShotName, number][]) {
      const p = new ShotPicker(mulberry32(3));
      p.update(DT, ring(4), []); // a rotation shot that has only just begun
      expect(p.update(DT, ring(4), [cue]), cue.kind).toBeNull();
      let cut: ShotName | null = null, at = 0;
      for (let t = 0; t < WAIT_FOR[cue.kind]! + 0.2 && !cut; t += DT) {
        const c = p.update(DT, ring(4), []);
        if (c) { cut = c.shot; at = t; }
      }
      expect(cut, cue.kind).toBe(shot);
      expect(at, cue.kind).toBeGreaterThanOrEqual(waitS - 2 * DT - 2 * DT);
    }
  });

  test('a waiting moment is given up once its fighter is out of the fight, or after WAIT_FOR s', () => {
    const p = new ShotPicker(mulberry32(3));
    p.update(DT, ring(4), []);
    p.update(DT, ring(4), [{ kind: 'special', id: 'f1' }]);
    const without = { ...ring(4), ids: ['f0', 'f2', 'f3'] };
    for (let t = 0; t < 2; t += DT) expect(p.update(DT, without, [])?.shot ?? null).not.toBe('hero');
    // a special stuck behind a long higher shot is given up after WAIT_FOR s
    const q = new ShotPicker(mulberry32(3));
    q.update(DT, ring(4), [{ kind: 'ringOut', id: 'f0' }]);
    q.update(DT, ring(4), [{ kind: 'special', id: 'f1' }]);
    expect(WAIT_FOR.special).toBeLessThan(CUE_HOLD.ringOut);
    settle(q, ring(4), CUE_HOLD.ringOut + 0.05);
    expect(q.pick.shot).not.toBe('hero');
  });

  test('a waiting moment comes before the next rotation shot when the shot on screen ends', () => {
    const p = new ShotPicker(mulberry32(3));
    p.update(DT, ring(4), [{ kind: 'ringOut', id: 'f0' }]);
    settle(p, ring(4), 1);
    p.update(DT, ring(4), [{ kind: 'throw', id: 'f1', other: 'f2' }]); // during the ring-out: it waits
    settle(p, ring(4), CUE_HOLD.ringOut - 1 + 0.05);
    expect(p.pick.shot).toBe('duel');
    expect(p.pick.a).toBe('f1');
  });

  test('every ring-out is seen: a second one cuts in on the first one’s shot at once', () => {
    const p = ready(6);
    p.update(DT, ring(4), [{ kind: 'ringOut', id: 'f0' }]);
    settle(p, ring(4), 0.3);
    expect(p.update(DT, ring(4), [{ kind: 'ringOut', id: 'f0' }])).toBeNull(); // the same flier: nothing new
    expect(p.update(DT, ring(4), [{ kind: 'ringOut', id: 'f1' }])?.a).toBe('f1');
  });

  test('a special already in a close shot on its attacker (its hero shot, a duel it is in) needs no cut', () => {
    const p = ready(6);
    p.update(DT, ring(4), [{ kind: 'throw', id: 'f0', other: 'f1' }]);
    settle(p, ring(4), QUICK_HOLD + 0.05);
    expect(p.update(DT, ring(4), [{ kind: 'special', id: 'f1' }])).toBeNull();
    expect(p.update(DT, ring(4), [{ kind: 'special', id: 'f2' }])?.a).toBe('f2');
  });

  test('a special whose attacker is in the frame of the shot on screen (any shot) needs no cut; one out of it cuts', () => {
    const p = ready(6);
    const seen = ring(4, { inView: new Set(['f0', 'f1']) });
    expect(p.update(DT, seen, [{ kind: 'special', id: 'f1' }])).toBeNull();
    expect(p.update(DT, seen, [{ kind: 'special', id: 'f2' }])?.a).toBe('f2');
    const q = ready(6);
    q.update(DT, seen, [{ kind: 'special', id: 'f1' }]);
    for (let t = 0; t < WAIT_FOR.special! + 0.1; t += DT) expect(q.update(DT, seen, [])?.rank ?? 0).toBe(0); // nor waits for one
  });

  test('a moment of the same priority waits until the shot has held 2.5 s', () => {
    const p = ready(7);
    p.update(DT, ring(4), [{ kind: 'throw', id: 'f0', other: 'f1' }]);
    settle(p, ring(4), MIN_HOLD - 0.2);
    expect(p.update(DT, ring(4), [{ kind: 'throw', id: 'f2', other: 'f3' }])).toBeNull();
  });

  test('after a moment’s shot the rotation comes back; a ring-out watches its fall 1.6 s', () => {
    const p = new ShotPicker(mulberry32(7));
    p.update(DT, ring(4), [{ kind: 'ringOut', id: 'f1' }]);
    expect(CUE_HOLD.ringOut).toBe(1.6);
    settle(p, ring(4), 1.5);
    expect(p.pick.shot).toBe('ringOut');
    settle(p, ring(4), 0.15);
    expect(p.pick.shot).not.toBe('ringOut');
    expect(p.pick.rank).toBe(0);
    for (const hold of Object.values(CUE_HOLD)) expect(hold).toBeLessThanOrEqual(MAX_HOLD);
  });

  test('a special’s hero shot follows its own blow to a flier shot on the one it launched (once it has been seen)', () => {
    const p = ready(8);
    p.update(DT, ring(4), [{ kind: 'special', id: 'f0' }]);
    expect(p.update(DT, ring(4), [{ kind: 'launch', id: 'f1', by: 'f0' }])).toBeNull(); // too soon: the release is seen first
    settle(p, ring(4), FOLLOW_AFTER);
    expect(p.update(DT, ring(4), [{ kind: 'launch', id: 'f2', by: 'f3' }])).toBeNull(); // someone else's blow: no
    const cut = p.update(DT, ring(4), [{ kind: 'launch', id: 'f1', by: 'f0' }]);
    expect(cut?.shot).toBe('flier');
    expect(cut?.a).toBe('f1');
  });

  test('dev: next steps through every shot in turn, and no moment cuts it away', () => {
    const p = new ShotPicker(mulberry32(9));
    const seen = [p.pick.shot];
    for (let i = 0; i < SHOT_NAMES.length; i++) seen.push(p.next(ring(4)).shot);
    expect(seen).toEqual([...SHOT_NAMES, SHOT_NAMES[0]]);
    settle(p, ring(4), CALM_HOLD + 0.1);
    expect(p.update(DT, ring(4), [{ kind: 'ringOut', id: 'f1' }])).toBeNull();
  });
});

describe('shotCues: a ring-loop step’s moments for the camera', () => {
  test('ring-outs, releases, grabs and throws, big launches, pad jumps, events’ starts', () => {
    const at = new Vector3();
    const hit = (target: string, reaction: string, launch: number) =>
      ({ attacker: { id: 'x' }, target: { id: target }, reaction, launch }) as unknown as Hit;
    const cues = shotCues({
      outs: ['o'],
      specials: [{ id: 's', special: 'quake', phase: 'charge', at }, { id: 's', special: 'quake', phase: 'release', at }] as never,
      stunts: [
        { id: 'g', stunt: 'grab', phase: 'start', at, other: 'h' }, { id: 'g', stunt: 'grab', phase: 'end', at, other: 'h' },
        { id: 'g', stunt: 'throw', phase: 'start', at, other: 'h' }, { id: 'l', stunt: 'leap', phase: 'start', at },
      ],
      features: [
        { type: 'pad', pad: 0, id: 'p', at }, { type: 'ball', id: 'b', at },
        { type: 'event', event: 'pinball', phase: 'start' }, { type: 'event', event: 'pinball', phase: 'end' },
      ],
      hits: [hit('a', 'stagger', 3), hit('b', 'pop', 9.5), hit('c', 'big', BIG_FLIGHT + 1), hit('d', 'big', 1)],
    }, 9);
    expect(cues).toEqual([
      { kind: 'ringOut', id: 'o' }, { kind: 'special', id: 's' },
      { kind: 'throw', id: 'g', other: 'h' }, { kind: 'throw', id: 'g', other: 'h' },
      { kind: 'launch', id: 'b', by: 'x' }, { kind: 'launch', id: 'c', by: 'x' },
      { kind: 'pad', id: 'p' }, { kind: 'event' },
    ]);
  });
});
