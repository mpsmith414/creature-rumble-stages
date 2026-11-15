import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { addArenaColliders } from '../../src/arena/colliders';
import { buildSkeleton } from '../../src/builder/skeleton';
import { Brain, type AttackPhase, type Rival } from '../../src/fight/brain';
import { Fighter, type FightCtx, type Hit } from '../../src/fight/fighter';
import { planFor } from '../../src/fight/moves';
import { Muscles } from '../../src/fight/muscles';
import { DASH_S, DODGE_T, JUMP_ATTACK, dodgeSpot, leapTime, type StuntCue } from '../../src/fight/stunts';
import { MOVE_POWER, TUNE, type Tune } from '../../src/fight/tune';
import { ragdollLayout } from '../../src/physics/layout';
import { createWorld, initPhysics } from '../../src/physics/world';
import { mulberry32 } from '../../src/util/rng';
import { loadFixture } from '../fixtures/fighters';

/** Stunts (design 2026-11-14 §3): leap, dash, dodge, rope spring, air chase; the brain's pace. */

beforeAll(initPhysics);

const DT = 1 / 60;
const UP = new Vector3(0, 1, 0);
const R = TUNE.ringRadius;

function ring(tune: Tune = TUNE): RAPIER.World {
  const w = createWorld(tune.gravity);
  addArenaColliders(w, tune);
  return w;
}

function fighter(w: RAPIER.World, kind: string, at: Vector3, yaw = 0, seed = 1, state: Fighter['state'] = 'fighting'): Fighter {
  const recipe = loadFixture(kind);
  const sk = buildSkeleton(recipe);
  const plan = planFor(recipe, sk);
  const f = new Fighter(`${kind}-${seed}`, w, ragdollLayout(sk, plan), plan, { tune: TUNE, rng: mulberry32(seed) });
  f.ragdoll.pose(at, yaw);
  f.state = state;
  return f;
}

/** Turned to face from `a` toward `b` (yaw about +y). */
const yawTo = (a: Vector3, b: Vector3) => Math.atan2(b.x - a.x, b.z - a.z);

/**
 * `thinkers` think and the world steps, for `secs`; `standers` are only held standing by their own muscles (no brain:
 * a target that does not move); `each` sees every tick, its hits and the stunt cues. Returns the time reached.
 */
function run(w: RAPIER.World, thinkers: Fighter[], secs: number, o: {
  from?: number; standers?: Fighter[]; others?: Fighter[]; boast?: boolean; seed?: number;
  each?: (t: number, hits: Hit[], cues: StuntCue[]) => void | boolean;
} = {}): number {
  const ctx: FightCtx = { others: o.others ?? [...thinkers, ...(o.standers ?? [])], boast: o.boast ?? false, tune: TUNE, rng: mulberry32(o.seed ?? 7) };
  const holds = (o.standers ?? []).map((f) => ({ f, m: new Muscles(f.ragdoll, f.layout) }));
  let t = o.from ?? 0;
  const end = t + secs;
  while (t < end - 1e-9) {
    const hits = thinkers.flatMap((f) => f.think(DT, t, ctx));
    for (const { f, m } of holds) {
      if (f.stun > 0 || f.flying || !f.ragdoll.pieces.length) continue;
      m.hover(DT, 1, new Vector3(), TUNE.gravity);
      m.stand(DT, 1, new Vector3(0, 0, 1), TUNE.gravity);
      m.brace(DT, 1, null, TUNE);
    }
    w.step();
    t += DT;
    const cues = thinkers.flatMap((f) => f.takeStuntCues());
    if (o.each?.(t, hits, cues) === true) break;
  }
  return t;
}

const quat = (f: Fighter) => { const r = f.ragdoll.torso.body.rotation(); return new Quaternion(r.x, r.y, r.z, r.w); };
/** cos of how far the torso leans from upright. */
const upright = (f: Fighter) => UP.clone().applyQuaternion(quat(f).multiply(f.ragdoll.torso.restQ.clone().invert())).dot(UP);
const level = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

describe('leap', () => {
  test.each(['fists', 'legs', 'tiny', 'blob', 'wings', 'tail', 'horns'])('%s lands within 0.6 m of its spot, upright', (kind) => {
    const w = ring();
    const from = new Vector3(-3, 0, -1), to = new Vector3(2, 0, 1.5);
    const f = fighter(w, kind, from, yawTo(from, to));
    expect(f.tryStunt({ name: 'leap', to })).toBe(true);
    expect(f.stunt).toBe('leap');
    let landed: Vector3 | null = null, peak = 0, endAt = -1, up = 1;
    run(w, [f], 2, {
      each: (t, _h, cues) => {
        peak = Math.max(peak, f.ragdoll.pos().y - f.layout.standHeight);
        for (const c of cues) {
          if (c.stunt === 'leap' && c.phase === 'land') landed = c.at.clone();
          if (c.stunt === 'leap' && c.phase === 'end') { endAt = t; up = upright(f); }
        }
        return endAt >= 0;
      },
    });
    expect(landed, 'it landed').not.toBeNull();
    expect(level(landed!, to)).toBeLessThan(0.6);
    expect(up, 'upright as it lands').toBeGreaterThan(0.85);
    // a cartoon hop, not a teleport: in the air about the flight time, and clearly off the ground
    const T = leapTime(level(from, to));
    expect(endAt).toBeGreaterThan(T * 0.75);
    expect(peak).toBeGreaterThan(0.3);
    expect(f.standUps, 'the limp guard left it alone').toBe(0);
  });

  test('a leap that lands in reach of its foe strikes at once, harder (a jump attack)', () => {
    const w = ring();
    const a = fighter(w, 'fists', new Vector3(-3, 0, 0), Math.PI / 2, 1);
    const b = fighter(w, 'blob', new Vector3(1.5, 0, 0), -Math.PI / 2, 2);
    expect(a.tryStunt({ name: 'leap', to: new Vector3(1.5 - a.reach * 0.7, 0, 0), foe: b })).toBe(true);
    let ended = -1, attack: AttackPhase = 'none';
    const mine: Hit[] = [];
    run(w, [a], 2.5, {
      standers: [b],
      each: (t, hits, cues) => {
        if (ended < 0 && cues.some((c) => c.phase === 'end')) { ended = t; attack = a.attack; }
        mine.push(...hits.filter((h) => h.attacker === a));
      },
    });
    expect(ended).toBeGreaterThan(0);
    expect(attack, 'a wind-up the moment it lands').toBe('windup');
    expect(mine.length, 'the jump attack landed').toBeGreaterThan(0);
    expect(mine[0].power).toBeCloseTo(MOVE_POWER.punch * TUNE.knock * JUMP_ATTACK, 6);
  });
});

describe('dash', () => {
  test.each(['fists', 'blob', 'tiny', 'legs'])('%s moves at least 1.5 m in 0.3 s', (kind) => {
    const w = ring();
    const f = fighter(w, kind, new Vector3(-2, 0, 0), Math.PI / 2);
    const from = f.ragdoll.pos();
    expect(f.tryStunt({ name: 'dash', dir: new Vector3(1, 0, 0) })).toBe(true);
    let moved = 0;
    run(w, [f], DASH_S + DT / 2, { each: () => { moved = level(f.ragdoll.pos(), from); } });
    expect(moved).toBeGreaterThanOrEqual(1.5);
  });

  test('a side-step round a foe stays near it', () => {
    const w = ring();
    const a = fighter(w, 'fists', new Vector3(-1.3, 0, 0), Math.PI / 2, 1);
    const b = fighter(w, 'blob', new Vector3(0, 0, 0), -Math.PI / 2, 2);
    expect(a.tryStunt({ name: 'dash', dir: new Vector3(0, 0, 1), foe: b, side: 1 })).toBe(true);
    const start = a.ragdoll.pos();
    let far = 0;
    run(w, [a], DASH_S, { standers: [b], each: () => { far = Math.max(far, level(a.ragdoll.pos(), b.ragdoll.pos())); } });
    expect(level(a.ragdoll.pos(), start), 'it went round').toBeGreaterThan(1);
    expect(far, 'still in reach').toBeLessThan(a.reach * 1.2);
  });
});

describe('dodge', () => {
  test('hops back from the foe, quickly, on its feet', () => {
    const w = ring();
    const a = fighter(w, 'tiny', new Vector3(0.6, 0, 0), -Math.PI / 2, 1);
    const b = fighter(w, 'fists', new Vector3(-0.8, 0, 0), Math.PI / 2, 2);
    const d0 = level(a.ragdoll.pos(), b.ragdoll.pos());
    expect(a.tryStunt({ name: 'dodge', from: b, dist: 2 })).toBe(true);
    expect(a.stunt).toBe('dodge');
    let endAt = -1;
    run(w, [a], 1.5, { standers: [b], each: (t, _h, cues) => { if (cues.some((c) => c.phase === 'end')) endAt = t; return endAt >= 0; } });
    expect(endAt).toBeGreaterThan(0);
    expect(endAt).toBeLessThan(DODGE_T + 0.4);
    expect(level(a.ragdoll.pos(), b.ragdoll.pos()) - d0).toBeGreaterThan(1.2);
    expect(upright(a)).toBeGreaterThan(0.8);
  });

  test('the brain dodges a foe’s wind-up in reach, by chance, once per wind-up', () => {
    const brain = new Brain<Rival>('me', 1);
    const foe = { state: 'fighting', ragdoll: { pos: () => new Vector3(1, 0, 0) }, flying: false, attack: 'windup' as AttackPhase, reach: 1.8 };
    const me = { reach: 0.6, ringHeight: 0.8 };
    brain.target = foe;
    // the roll fails: no dodge, and none later in the same wind-up even with a winning roll
    expect(brain.pickStunt(new Vector3(0, 0, 0), 0.1, [foe], false, me, R, TUNE.edgeMargin, () => 0.99, true)?.name).not.toBe('dodge');
    expect(brain.pickStunt(new Vector3(0, 0, 0), 0.2, [foe], false, me, R, TUNE.edgeMargin, () => 0, true)?.name).not.toBe('dodge');
    // its next wind-up: a winning roll dodges
    foe.attack = 'cool';
    brain.pickStunt(new Vector3(0, 0, 0), 0.3, [foe], false, me, R, TUNE.edgeMargin, () => 0.99, true);
    foe.attack = 'windup';
    const pick = brain.pickStunt(new Vector3(0, 0, 0), 0.4, [foe], false, me, R, TUNE.edgeMargin, () => 0.1, true);
    expect(pick?.name).toBe('dodge');
    // small fighters dodge more: 0.3 is a dodge for a small one (0.35), not for a big one (0.2)
    const big = new Brain<Rival>('big', 1);
    big.target = foe;
    expect(big.pickStunt(new Vector3(0, 0, 0), 0.4, [foe], false, { reach: 1.8, ringHeight: 1.5 }, R, TUNE.edgeMargin, () => 0.3, true)?.name).not.toBe('dodge');
  });

  test('a dodge near the edge hops sideways, never out', () => {
    const lim = R - TUNE.edgeMargin;
    const spot = dodgeSpot(new Vector3(lim - 0.5, 0, 0), new Vector3(lim - 2, 0, 0), 2.5, lim);
    expect(Math.hypot(spot.x, spot.z)).toBeLessThanOrEqual(lim + 1e-9);
    expect(spot.distanceTo(new Vector3(lim - 0.5, 0, 0)), 'it still hopped').toBeGreaterThan(1.5);
  });
});

describe('rope spring', () => {
  test('leaps onto the bumper top, springs off at its foe and hits it', () => {
    const w = ring();
    const a = fighter(w, 'fists', new Vector3(R - 2, 0, 0), -Math.PI / 2, 1);
    const b = fighter(w, 'tail', new Vector3(-0.5, 0, 0.3), Math.PI / 2, 2);
    expect(a.tryStunt({ name: 'ropeSpring', foe: b })).toBe(true);
    let touch: StuntCue | null = null, endAt = -1;
    const hit: Hit[] = [];
    run(w, [a], 3, {
      standers: [b],
      each: (t, hits, cues) => {
        for (const c of cues) {
          if (c.phase === 'land') touch = c;
          if (c.phase === 'end') endAt = t;
        }
        hit.push(...hits.filter((h) => h.attacker === a && h.target === b));
        return endAt >= 0;
      },
    });
    expect(touch, 'it touched the bumper').not.toBeNull();
    const at = touch!.at;
    expect(Math.hypot(at.x, at.z), 'over the bumper').toBeGreaterThan(R - 0.5);
    expect(at.y, 'on top of it').toBeGreaterThan(TUNE.bumper);
    expect(touch!.other).toBe(b.id);
    expect(hit.length, 'the flying body attack hit').toBe(1);
    expect(endAt).toBeGreaterThan(0);
    expect(a.state).toBe('fighting');
    expect(Math.hypot(a.ragdoll.pos().x, a.ragdoll.pos().z), 'back in the ring').toBeLessThan(R);
  });

  test('the brain springs off the ropes when near them with its target well inward', () => {
    const brain = new Brain<Rival>('me', 1);
    const foe = { state: 'fighting', ragdoll: { pos: () => new Vector3(-1, 0, 0) }, flying: false, attack: 'none' as AttackPhase, reach: 1.8 };
    brain.target = foe;
    const pick = brain.pickStunt(new Vector3(R - 2, 0, 0), 1, [foe], false, { reach: 1.8, ringHeight: 1.4 }, R, TUNE.edgeMargin, () => 0.1, true);
    expect(pick?.name).toBe('ropeSpring');
  });
});

describe('air chase', () => {
  /** `b` popped up by a big blow from `a`'s side. */
  function launched() {
    const w = ring();
    const a = fighter(w, 'fists', new Vector3(-1, 0, 0), Math.PI / 2, 1);
    const b = fighter(w, 'blob', new Vector3(0.5, 0, 0), -Math.PI / 2, 2);
    const c = fighter(w, 'tiny', new Vector3(0, 0, 2), Math.PI, 3);
    const d = fighter(w, 'horns', new Vector3(0, 0, -2), 0, 4);
    run(w, [], 0.2, { standers: [a, b, c, d] }); // settle
    b.knock(new Vector3(-1, 0, 0), 3);
    return { w, a, b, c, d };
  }

  test('leaps after a flier and strikes it in the air, softly upward', () => {
    const { w, a, b } = launched();
    expect(b.flying).toBe(true);
    expect(a.tryStunt({ name: 'airChase', foe: b })).toBe(true);
    expect(b.airChased).toBe(1);
    const hit: { h: Hit; flying: boolean }[] = [];
    run(w, [a], 2, {
      others: [a, b],
      each: (_t, hits, cues) => {
        for (const h of hits) if (h.target === b) hit.push({ h, flying: true });
        return cues.some((c) => c.phase === 'end');
      },
    });
    expect(hit.length, 'struck it once in the air').toBe(1);
    expect(a.stunt).toBeNull();
  });

  test('at most two chases per flight', () => {
    const { a, b, c, d } = launched();
    expect(a.tryStunt({ name: 'airChase', foe: b })).toBe(true);
    expect(c.tryStunt({ name: 'airChase', foe: b })).toBe(true);
    expect(d.tryStunt({ name: 'airChase', foe: b }), 'a third is refused').toBe(false);
    expect(b.airChased).toBe(2);
  });

  test('nobody chases a fighter that is not flying', () => {
    const w = ring();
    const a = fighter(w, 'fists', new Vector3(-1, 0, 0), Math.PI / 2, 1);
    const b = fighter(w, 'blob', new Vector3(0.5, 0, 0), -Math.PI / 2, 2);
    expect(a.tryStunt({ name: 'airChase', foe: b })).toBe(false);
  });
});

describe('never starts', () => {
  const leap = { name: 'leap' as const, to: new Vector3(2, 0, 0) };

  test('while entering, stunned, flying, staggered or in another stunt', () => {
    const w = ring();
    const e = fighter(w, 'fists', new Vector3(0, 0, 0), 0, 1, 'entering');
    expect(e.tryStunt(leap), 'entering').toBe(false);
    const s = fighter(w, 'fists', new Vector3(2, 0, 2), 0, 2);
    s.stun = 1;
    expect(s.tryStunt(leap), 'stunned').toBe(false);
    const f = fighter(w, 'fists', new Vector3(-2, 0, 2), 0, 3);
    f.knock(new Vector3(-3, 0, 2), 3);
    expect(f.flying).toBe(true);
    expect(f.tryStunt(leap), 'flying').toBe(false);
    const g = fighter(w, 'blob', new Vector3(-2, 0, -2), 0, 4);
    g.knock(new Vector3(-3, 0, -2), 0.2);
    expect(g.reaction).toBe('stagger');
    expect(g.tryStunt(leap), 'staggered').toBe(false);
    const h = fighter(w, 'fists', new Vector3(2, 0, -2), 0, 5);
    expect(h.tryStunt(leap)).toBe(true);
    expect(h.tryStunt({ name: 'dash', dir: new Vector3(1, 0, 0) }), 'already in a stunt').toBe(false);
  });

  test('during an attack’s wind-up or strike', () => {
    const w = ring();
    const f = fighter(w, 'fists', new Vector3(0, 0, 0));
    f.showOff();
    expect(f.attack).toBe('windup');
    expect(f.tryStunt(leap), 'wind-up').toBe(false);
    run(w, [f], 0.5, { boast: false, others: [f], each: () => f.attack === 'strike' });
    if (f.attack === 'strike') expect(f.tryStunt(leap), 'strike').toBe(false);
  });

  test('during a special', () => {
    const w = ring();
    const a = fighter(w, 'fists', new Vector3(-1, 0, 0), Math.PI / 2, 1);
    const b = fighter(w, 'blob', new Vector3(1, 0, 0), -Math.PI / 2, 2);
    a.special.meter = 1;
    let saw = false;
    run(w, [a], 3, {
      standers: [b],
      each: () => {
        if (a.special.active === null) return false;
        saw = true;
        expect(a.tryStunt(leap)).toBe(false);
        return true;
      },
    });
    expect(saw, 'its special started').toBe(true);
  });

  test('a pop or a big hit ends a stunt under way (with its end cue)', () => {
    const w = ring();
    const f = fighter(w, 'fists', new Vector3(-2, 0, 0), Math.PI / 2);
    expect(f.tryStunt({ name: 'leap', to: new Vector3(3, 0, 0) })).toBe(true);
    f.takeStuntCues();
    f.knock(new Vector3(-3, 0, 0), 3);
    expect(f.stunt).toBeNull();
    expect(f.takeStuntCues().map((c) => c.phase)).toEqual(['end']);
  });
});

describe('pace', () => {
  test('its first act after its entrance is a leap at the nearest foe', () => {
    const w = ring();
    const a = fighter(w, 'fists', new Vector3(-4, 0, 0), Math.PI / 2, 1, 'entering');
    const far = fighter(w, 'tail', new Vector3(4, 0, 3), 0, 2);
    const near = fighter(w, 'blob', new Vector3(1, 0, -1), 0, 3);
    a.state = 'fighting';
    const cues: StuntCue[] = [];
    run(w, [a], 0.5, { standers: [far, near], each: (_t, _h, cs) => { cues.push(...cs); } });
    expect(cues[0]).toMatchObject({ stunt: 'leap', phase: 'start', other: near.id });
  });

  test.each([['fists', 'horns'], ['tiny', 'blob'], ['legs', 'wings'], ['tail', 'fists']])(
    'a fighter with a target (%s against %s) is never under 0.5 m/s (its torso) for over 1 s while unstunned',
    (k1, k2) => {
      const w = ring();
      const a = fighter(w, k1, new Vector3(-1.5, 0, 0), Math.PI / 2, 1);
      const b = fighter(w, k2, new Vector3(1.5, 0, 0), -Math.PI / 2, 2);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const still = new Map<Fighter, number>([[a, 0], [b, 0]]);
      let worst = 0, worstAt = "";
      run(w, [a, b], 20, {
        each: () => {
          for (const f of [a, b]) {
            const v = f.ragdoll.torso.body.linvel();
            // unstunned: not stunned, flying or staggered (its latest hit over), still in the ring, not in its special
            // (a belly bomb goes straight up and down)
            const steady = f.state === 'fighting' && f.stun <= 0 && !f.flying && f.reaction === 'none' && f.special.active === null;
            const s = steady && Math.hypot(v.x, v.y, v.z) < 0.5 ? still.get(f)! + DT : 0;
            still.set(f, s);
            if (s > worst) { worst = s; worstAt = `${f.id} ${f.attack} ${f.stunt} y ${f.ragdoll.pos().y.toFixed(2)}`; }
          }
          return a.state !== 'fighting' || b.state !== 'fighting';
        },
      });
      warn.mockRestore();
      expect(worst, worstAt).toBeLessThanOrEqual(1);
      // (console.warn is quiet only to keep the output clean: moving on its own, nobody was stood up by the limp guard)
      expect(a.standUps + b.standUps, 'limp-guard stand-ups').toBe(0);
    },
    30_000,
  );

  test('a target let go (no body left) is never looked at again', () => {
    const brain = new Brain<Rival>('me', 1);
    const gone = { state: 'gone', ragdoll: { pos: (): Vector3 => { throw new Error('no body'); } }, flying: true, attack: 'none' as AttackPhase, reach: 1 };
    const foe = { state: 'fighting', ragdoll: { pos: () => new Vector3(3, 0, 0) }, flying: false, attack: 'none' as AttackPhase, reach: 1 };
    brain.target = gone;
    expect(() => brain.pickStunt(new Vector3(0, 0, 0), 1, [foe], false, { reach: 1, ringHeight: 1.4 }, R, TUNE.edgeMargin, () => 0.5, true)).not.toThrow();
    expect(brain.target).toBe(foe);
  });

  test('a second without a blow makes it eager: no side-step, no waiting beat, it swings', () => {
    const foe = { state: 'fighting', ragdoll: { pos: () => new Vector3(1, 0, 0) }, flying: false, attack: 'none' as AttackPhase, reach: 1.8 };
    const me = { reach: 2, ringHeight: 1.4 };
    // fresh from a blow (at 0.5 s): a side-step round its foe, and (rng 0.5 ≥ the idle beat) no swing yet
    const calm = new Brain<Rival>('calm', 1);
    calm.blow(0.5);
    expect(calm.pickStunt(new Vector3(0, 0, 0), 1, [foe], false, me, R, TUNE.edgeMargin, () => 0.5, true)?.name).toBe('dash');
    calm.steer(new Vector3(0, 0, 0), 1, [foe], false, 2, R, TUNE.edgeMargin, () => 0.5);
    expect(calm.atk.phase).toBe('none');
    // 2 s on with no blow: no side-step, and it swings at once
    const eager = new Brain<Rival>('eager', 1);
    eager.blow(0.5);
    expect(eager.pickStunt(new Vector3(0, 0, 0), 2.5, [foe], false, me, R, TUNE.edgeMargin, () => 0.5, true)?.name).not.toBe('dash');
    eager.steer(new Vector3(0, 0, 0), 2.5, [foe], false, 2, R, TUNE.edgeMargin, () => 0.5);
    expect(eager.atk.phase).toBe('windup');
  });

  test('in reach the brain circles its target', () => {
    const brain = new Brain<Rival>('me', 1);
    const foe = { state: 'fighting', ragdoll: { pos: () => new Vector3(1, 0, 0) }, flying: false, attack: 'none' as AttackPhase, reach: 1.8 };
    // close in (its foe 1 m off, its reach 2 m): creeping in, and strafing round it faster than it creeps
    const { want } = brain.steer(new Vector3(0, 0, 0), 0, [foe], false, 2, R, TUNE.edgeMargin, () => 0.5);
    expect(Math.abs(want.z), 'sideways round it').toBeGreaterThan(Math.abs(want.x));
    expect(Math.abs(want.z)).toBeGreaterThanOrEqual(0.25);
  });

  test('a far target is closed on with a leap; a cornered fighter leaps over its foe toward the middle', () => {
    const me = { reach: 1.8, ringHeight: 1.4 };
    const b1 = new Brain<Rival>('a', 1);
    const far = { state: 'fighting', ragdoll: { pos: () => new Vector3(4, 0, 0) }, flying: false, attack: 'none' as AttackPhase, reach: 1.8 };
    b1.target = far;
    const leap = b1.pickStunt(new Vector3(-2, 0, 0), 1, [far], false, me, R, TUNE.edgeMargin, () => 0.1, true);
    expect(leap?.name).toBe('leap');
    if (leap?.name === 'leap') expect(level(leap.to, far.ragdoll.pos())).toBeCloseTo(me.reach * 0.7, 6);
    const b2 = new Brain<Rival>('b', 1);
    const foe = { ...far, ragdoll: { pos: () => new Vector3(R - 2.5, 0, 0) } };
    b2.target = foe;
    const over = b2.pickStunt(new Vector3(R - 1, 0, 0), 1, [foe], false, me, R, TUNE.edgeMargin, () => 0.1, true);
    expect(over?.name).toBe('leap');
    if (over?.name === 'leap') expect(over.to.x, 'past the foe, toward the middle').toBeLessThan(R - 2.5);
  });
});
