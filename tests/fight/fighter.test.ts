import type RAPIER from '@dimforge/rapier3d-compat';
import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, it, test, vi } from 'vitest';
import { addArenaColliders } from '../../src/arena/colliders';
import { buildSkeleton } from '../../src/builder/skeleton';
import { Fighter, type FightCtx, type Hit } from '../../src/fight/fighter';
import { planFor } from '../../src/fight/moves';
import { JUMP_ATTACK, SPRING_POWER } from '../../src/fight/stunts';
import { COOL_PACE } from '../../src/fight/brain';
import { MOVE_POWER, MOVE_TIMING, TUNE, knockMultiplier, launchFor, speedFor } from '../../src/fight/tune';
import { ragdollLayout } from '../../src/physics/layout';
import { createWorld, initPhysics } from '../../src/physics/world';
import { mulberry32 } from '../../src/util/rng';
import { loadFixture } from '../fixtures/fighters';

beforeAll(initPhysics);

const DT = 1 / 60;
const R = TUNE.ringRadius;

/** The ring (floor + bumper) in a fresh world, as the arena builds it. */
function ring(): RAPIER.World {
  const w = createWorld(TUNE.gravity);
  addArenaColliders(w, TUNE);
  return w;
}

/** A fighter from a fixture, standing on the ground point `at`, facing `yaw`, already fighting. */
function fighter(w: RAPIER.World, kind: string, at: Vector3, yaw = 0, seed = 1): Fighter {
  const recipe = loadFixture(kind);
  const sk = buildSkeleton(recipe);
  const plan = planFor(recipe, sk);
  const f = new Fighter(kind, w, ragdollLayout(sk, plan), plan, { tune: TUNE, rng: mulberry32(seed) });
  f.ragdoll.pose(at, yaw);
  f.state = 'fighting';
  return f;
}

/** Runs the fight loop (every fighter thinks, then the world steps) for `secs`; `each` sees every tick. */
function run(w: RAPIER.World, fs: Fighter[], secs: number, opts: { from?: number; boast?: boolean; seed?: number; each?: (t: number, hits: Hit[]) => void } = {}): number {
  const ctx: FightCtx = { others: fs, boast: opts.boast ?? false, tune: TUNE, rng: mulberry32(opts.seed ?? 7) };
  let t = opts.from ?? 0;
  const end = t + secs;
  while (t < end - 1e-9) {
    const hits = fs.flatMap((f) => f.think(DT, t, ctx));
    w.step();
    t += DT;
    opts.each?.(t, hits);
  }
  return t;
}

/**
 * Lays a fighter on its back along the bumper, limbs hanging either side: its torso at r = R + 0.2 (over the bumper's
 * middle, R + 0.15), resting on top (y = bumper + torso radius).
 */
function layOnBumper(f: Fighter): void {
  // creature up → along the edge (+z at angle 0), creature forward → up, creature right → in toward the centre
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 1, 0)));
  const torso = f.ragdoll.torso;
  const at = new Vector3(R + 0.2, TUNE.bumper + torso.seg.radius, 0);
  for (const p of f.ragdoll.pieces) {
    const pos = p.restP.clone().sub(torso.restP).applyQuaternion(q).add(at);
    const rq = q.clone().multiply(p.restQ);
    p.body.setTranslation(pos, true);
    p.body.setRotation({ x: rq.x, y: rq.y, z: rq.z, w: rq.w }, true);
  }
}

describe('tuning', () => {
  test('fresh fighters are hard to shift, wobbly ones fly', () => {
    expect(knockMultiplier(0, 0.035)).toBeCloseTo(0.3);
    expect(knockMultiplier(40, 0.035)).toBeCloseTo(1.7);
  });

  it('holds the balanced numbers (npm run balance; the spike started from knock 0.6, flop 1, recover 0.7)', () => {
    expect(TUNE).toEqual({
      knock: 0.21, flop: 0.45, bounce: 0.15, gravity: 16, build: 0.17, heal: 0.05, bumper: 0.65, ringRadius: 6.5, recoverS: 0.2,
      edgeMargin: 2.5, spin: 1, drift: 0.6, pop: 5, floorBounce: 0.45, bumperBounce: 0.95, stiff: 0.7, tumbleS: 0.35, bigLaunch: 9,
    });
    expect(MOVE_TIMING.punch).toEqual([0.45, 0.75, 0.4]);
    expect(MOVE_TIMING.divebomb).toEqual([0.45, 1.0, 0.8]);
    expect(MOVE_POWER).toEqual({ punch: 2.2, jab: 2.45, kick: 2.6, bump: 1.45, headbutt: 2.25, spin: 2.45, divebomb: 2.65 });
  });

  test('a launch pops up big from the first hit; only its outward part grows with wobble', () => {
    const fresh = launchFor(1, 1, 0.5, TUNE), wobbly = launchFor(1, 40, 0.5, TUNE);
    expect(fresh.up).toBeCloseTo(TUNE.pop / 0.5 ** 0.1);
    expect(wobbly.up).toBeCloseTo(fresh.up);
    expect(wobbly.out).toBeGreaterThan(fresh.out + 1);
    expect(fresh.out).toBeCloseTo((0.85 * 2.6 * (TUNE.drift + TUNE.build)) / 0.5 ** 0.3);
    const special = launchFor(1, 1, 0.5, TUNE, { out: 0.5, up: 1.2 });
    expect(special.up).toBeCloseTo(fresh.up * 1.2);
    expect(special.out).toBeCloseTo(fresh.out * 0.5);
  });

  it('small fighters scurry, big ones lumber, within limits', () => {
    expect(speedFor(1.4)).toBeCloseTo(4.5);
    expect(speedFor(0.7)).toBeCloseTo(4.5 * Math.SQRT2);
    expect(speedFor(0.1)).toBeCloseTo(4.5 * 1.6);
    expect(speedFor(2.4)).toBeCloseTo(4.5 * 0.764, 2);
    expect(speedFor(10)).toBeCloseTo(4.5 * 0.75);
  });
});

describe('Fighter', () => {
  test('a lone fighter stands for 10 s, hopping round the ring now and then', () => {
    const w = ring();
    const f = fighter(w, 'fists', new Vector3(0, 0, 0));
    const H = f.ragdoll.pos().y; // posed standing: the torso at its stand height
    let lo = Infinity, hi = -Infinity, hops = 0, since = Infinity;
    run(w, [f], 10, {
      each: (t) => {
        hops += f.takeStuntCues().filter((c) => c.phase === 'start').length;
        // between its hops (once a landing has had 0.4 s to settle) it stands at its height
        since = f.stunt ? 0 : since + DT;
        if (t >= 2 && since > 0.4) { const y = f.ragdoll.pos().y; lo = Math.min(lo, y); hi = Math.max(hi, y); }
      },
    });
    expect(lo).toBeGreaterThan(0.85 * H);
    expect(hi).toBeLessThan(1.15 * H);
    expect(hops, 'it hopped about').toBeGreaterThan(0);
    expect(f.state).toBe('fighting');
  });

  test('a steady fighter lying flat for 2 s is stood up', () => {
    const w = ring();
    const f = fighter(w, 'legs', new Vector3(1, 0, 2), 0.7);
    const H = f.layout.standHeight;
    // lying on its back, creature up → +x, its torso resting on the floor
    const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(0, 1, 0)));
    const torso = f.ragdoll.torso, at = new Vector3(1, torso.seg.radius, 2);
    const layFlat = () => {
      for (const p of f.ragdoll.pieces) {
        const pos = p.restP.clone().sub(torso.restP).applyQuaternion(q).add(at);
        const rq = q.clone().multiply(p.restQ);
        p.body.setTranslation(pos, true);
        p.body.setRotation({ x: rq.x, y: rq.y, z: rq.z, w: rq.w }, true);
        p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    };
    layFlat();
    expect(f.ragdoll.pos().y).toBeLessThan(0.45 * H);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx: FightCtx = { others: [f], boast: false, tune: TUNE, rng: mulberry32(7) };
    // held down (laid flat again every tick) until the guard stands it up
    let t = 0;
    while (f.standUps === 0 && t < 3) {
      layFlat();
      f.think(DT, t, ctx);
      w.step();
      t += DT;
    }
    expect(f.standUps).toBe(1);
    expect(t).toBeGreaterThan(1.95);
    expect(t).toBeLessThan(2.1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('stand up');
    // stood where it lay, and it stays up on its own muscles
    expect(f.ragdoll.pos().setY(0).distanceTo(new Vector3(1, 0, 2))).toBeLessThan(0.6);
    run(w, [f], 1, { from: t });
    expect(f.ragdoll.pos().y).toBeGreaterThan(0.7 * H);
    expect(f.standUps).toBe(1);
    warn.mockRestore();
  });

  test('a stunned fighter lying flat is left alone', () => {
    const w = ring();
    const f = fighter(w, 'legs', new Vector3(0, 0, 0));
    const ctx: FightCtx = { others: [f], boast: false, tune: TUNE, rng: mulberry32(7) };
    let t = 0;
    while (t < 2.5) {
      f.stun = 1;
      for (const p of f.ragdoll.pieces) {
        const tr = p.body.translation();
        p.body.setTranslation({ x: tr.x, y: tr.y - f.ragdoll.pos().y + 0.1, z: tr.z }, true);
      }
      f.think(DT, t, ctx);
      w.step();
      t += DT;
    }
    expect(f.standUps).toBe(0);
  });

  test('two fighters land hits within 10 s', () => {
    const w = ring();
    const a = fighter(w, 'fists', new Vector3(-1.5, 0, 0), Math.PI / 2, 1);
    const b = fighter(w, 'blob', new Vector3(1.5, 0, 0), -Math.PI / 2, 2);
    const all: Hit[] = [];
    run(w, [a, b], 10, { each: (_t, h) => all.push(...h) });
    expect(a.hits + b.hits).toBeGreaterThan(0);
    expect(all).toHaveLength(a.hits + b.hits);
    for (const h of all) {
      expect(h.attacker).not.toBe(h.target);
      // a normal blow, a jump attack (× JUMP_ATTACK) or a rope spring's flying body
      const base = MOVE_POWER[h.attacker.plan.move] * TUNE.knock;
      expect([base, base * JUMP_ATTACK, SPRING_POWER * TUNE.knock].some((p) => Math.abs(p - h.power) < 1e-9), `power ${h.power}`).toBe(true);
      expect(h.launch).toBeGreaterThan(0);
      expect(Number.isFinite(h.at.x + h.at.y + h.at.z)).toBe(true);
    }
  });

  test('a hit raises wobble by its power and launches by the knockback rule', () => {
    const w = ring();
    const f = fighter(w, 'tail', new Vector3(0, 0, 0));
    const hits: Hit[] = [];
    const g = fighter(w, 'horns', new Vector3(0, 0, 1.2), Math.PI, 3);
    run(w, [g, f], 10, { each: (_t, h) => hits.push(...h.filter((x) => x.target === f)) });
    expect(hits.length).toBeGreaterThan(0);
    let wobble = 0;
    for (const h of hits) {
      wobble += h.power;
      // what the first hit launched by, given the wobble it had then (healing is slow over a few seconds)
      if (h === hits[0]) {
        const { out, up } = launchFor(h.power, h.power, f.ragdoll.mass, TUNE);
        // a stagger is pushed level (at least 3 m/s); a pop or a big hit flies at the launch's own speed
        expect(h.launch).toBeCloseTo(h.reaction === 'stagger' ? Math.max(out, 3) : Math.hypot(out, up), 3);
      }
    }
    expect(f.wobble).toBeGreaterThan(wobble - 10 * TUNE.heal - 1e-9);
    expect(f.wobble).toBeLessThanOrEqual(wobble);
  });

  test('a big hit sends the fighter flying; it stays limp until it is down, then stands again', () => {
    const w = ring();
    const f = fighter(w, 'fists', new Vector3(0, 0, 0));
    const H = f.ragdoll.pos().y;
    let t = run(w, [f], 2);
    f.knock(f.ragdoll.pos().add(new Vector3(-1, 0, 0)), 3);
    const stun = f.stun;
    expect(stun).toBeCloseTo(TUNE.flop * (0.45 + 3 * 0.18));
    expect(f.flying).toBe(true);
    expect(f.reaction).toBe('big');
    const knockedAt = t;
    let top = 0, landed = -1, up = -1, limpInAir = true;
    t = run(w, [f], stun + 3, {
      from: t,
      each: (now) => {
        const y = f.ragdoll.pos().y;
        top = Math.max(top, y);
        if (f.flying && f.stun <= 0) limpInAir = false;
        if (landed < 0 && !f.flying) landed = now;
        // down (it may land in a heap or on its feet), then standing tall on its own muscles again (at once, if it came
        // down on its feet with its stun spent)
        if (landed >= 0 && up < 0 && f.stun <= 0 && y > 0.85 * H) up = now;
      },
    });
    expect(top - H, 'popped up well over its own height').toBeGreaterThan(H);
    expect(limpInAir, 'limp all through the flight').toBe(true);
    expect(landed - knockedAt).toBeGreaterThan(0.4); // a real flight
    expect(landed - knockedAt).toBeLessThan(2.5);
    expect(up, 'it stood again').toBeGreaterThanOrEqual(landed);
    expect(up - landed).toBeLessThanOrEqual(stun + 1.5);
    expect(f.stun).toBeLessThanOrEqual(0);
  });

  test('fighter lying on the bumper is nudged off within 4 s', () => {
    const w = ring();
    const f = fighter(w, 'fists', new Vector3(0, 0, 0));
    layOnBumper(f);
    f.stun = Infinity; // limp for good: no muscles, only the bumper rule can move it
    let fell = -1;
    run(w, [f], 4, { each: (t) => { if (fell < 0 && f.ragdoll.pos().y < -2.5) fell = t; } });
    expect(fell).toBeGreaterThan(3); // it lay there the full 3 s first
    expect(fell).toBeLessThan(4);
  });

  test('a limp fighter left on the bumper stays there without the rule', () => {
    // the same placement, but nobody thinks: it really does rest on the bumper (so the rule above is what moves it)
    const w = ring();
    const f = fighter(w, 'fists', new Vector3(0, 0, 0));
    layOnBumper(f);
    for (let i = 0; i < 240; i++) w.step();
    const p = f.ragdoll.pos();
    expect(p.y).toBeGreaterThan(TUNE.bumper);
    expect(Math.hypot(p.x, p.z)).toBeGreaterThan(R);
  });

  test('showing off plays the signature move without hitting anyone, then fights as normal', () => {
    const [wind, strike, cool] = MOVE_TIMING.punch;
    const showEnd = wind + strike + cool * 0.7 * COOL_PACE; // the earliest a cool-down can end (× 0.7–1.3, × the pace)
    const setup = () => {
      const w = ring();
      const a = fighter(w, 'fists', new Vector3(-0.7, 0, 0), Math.PI / 2, 1);
      const b = fighter(w, 'horns', new Vector3(0.7, 0, 0), -Math.PI / 2, 2); // its headbutt winds up slower than a punch
      return { w, a, b };
    };
    // control: the same start without showing off lands a punch soon after that window (with stunts and circling a
    // first exchange is less certain to the tick)
    {
      const { w, a, b } = setup();
      run(w, [a, b], showEnd + 1);
      expect(a.hits).toBeGreaterThan(0);
    }
    const { w, a, b } = setup();
    a.showOff();
    expect(a.attack).toBe('windup');
    const phases = new Set<string>();
    run(w, [a, b], showEnd, { each: () => phases.add(a.attack) });
    expect(a.hits).toBe(0);
    expect([...phases]).toEqual(expect.arrayContaining(['windup', 'strike', 'cool']));
    // back to normal: the show-off ends and the next punches land
    run(w, [a, b], 10, { from: showEnd });
    expect(a.hits).toBeGreaterThan(0);
  });

  test('a fighter still entering only moves for a show-off', () => {
    const w = ring();
    const f = fighter(w, 'horns', new Vector3(0, 0, 0));
    f.state = 'entering';
    const ctx: FightCtx = { others: [f], boast: false, tune: TUNE, rng: mulberry32(1) };
    expect(f.think(DT, 0, ctx)).toEqual([]);
    expect(f.attack).toBe('none');
    f.showOff();
    const H = f.ragdoll.pos().y;
    let t = 0, low = Infinity;
    const seen = new Set<string>();
    // until the move is over (after it an entering fighter has no muscles: the entrance poses it — tests/show/entrance.test.ts)
    while (t < 3 && f.attack !== 'none') {
      f.think(DT, t, ctx); w.step(); t += DT; seen.add(f.attack);
      low = Math.min(low, f.ragdoll.pos().y);
    }
    expect(seen).toContain('strike');
    expect(f.attack).toBe('none'); // the show-off ends by itself
    expect(f.state).toBe('entering');
    expect(low).toBeGreaterThan(0.85 * H); // it held itself up to show the move
  });
});
