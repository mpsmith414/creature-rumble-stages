import type RAPIER from '@dimforge/rapier3d-compat';
import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { addArenaColliders } from '../../src/arena/colliders';
import { buildSkeleton } from '../../src/builder/skeleton';
import { Fighter, type FightCtx, type Hit } from '../../src/fight/fighter';
import { planFor } from '../../src/fight/moves';
import { Muscles } from '../../src/fight/muscles';
import { TUNE, launchFor, type Tune } from '../../src/fight/tune';
import { ragdollLayout } from '../../src/physics/layout';
import type { Piece } from '../../src/physics/ragdoll';
import { createWorld, initPhysics } from '../../src/physics/world';
import { mulberry32 } from '../../src/util/rng';
import { KINDS, loadFixture } from '../fixtures/fighters';

/** Springy bodies (design 2026-11-14 §2): braced limbs, graded hit reactions, launches across the ring, the kip-up. */

beforeAll(initPhysics);

const DT = 1 / 60;
const UP = new Vector3(0, 1, 0);

function ring(tune: Tune = TUNE): RAPIER.World {
  const w = createWorld(tune.gravity);
  addArenaColliders(w, tune);
  return w;
}

function fighter(w: RAPIER.World, kind: string, at: Vector3, yaw = 0, tune: Tune = TUNE, seed = 1): Fighter {
  const recipe = loadFixture(kind);
  const sk = buildSkeleton(recipe);
  const plan = planFor(recipe, sk);
  const f = new Fighter(`${kind}-${seed}`, w, ragdollLayout(sk, plan), plan, { tune, rng: mulberry32(seed) });
  f.ragdoll.pose(at, yaw);
  f.state = 'fighting';
  return f;
}

/** Every fighter thinks, then the world steps, for `secs`; `each` sees every tick. Returns the time reached. */
function run(w: RAPIER.World, fs: Fighter[], secs: number, o: { from?: number; tune?: Tune; each?: (t: number, hits: Hit[]) => void } = {}): number {
  const ctx: FightCtx = { others: fs, boast: false, tune: o.tune ?? TUNE, rng: mulberry32(7) };
  let t = o.from ?? 0;
  const end = t + secs;
  while (t < end - 1e-9) {
    const hits = fs.flatMap((f) => f.think(DT, t, ctx));
    w.step();
    t += DT;
    o.each?.(t, hits);
  }
  return t;
}

const quat = (p: Piece) => { const r = p.body.rotation(); return new Quaternion(r.x, r.y, r.z, r.w); };
/** The torso's creature-frame turn now (rest pose → now). */
const bodyTurn = (f: Fighter) => quat(f.ragdoll.torso).multiply(f.ragdoll.torso.restQ.clone().invert());
/** How far (rad) the torso leans from upright. */
const lean = (f: Fighter) => UP.clone().applyQuaternion(bodyTurn(f)).angleTo(UP);
/** The arms' guard: hanging, turned 35° forward-up (about the creature's sideways axis). */
const GUARD = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -(35 * Math.PI) / 180);
/** How far (rad) arm piece `p` is from its guard pose carried by the torso. */
const offGuard = (f: Fighter, p: Piece) => quat(p).angleTo(bodyTurn(f).multiply(GUARD.clone().multiply(p.restQ)));

/** The power of a normal hit that gives `f` (fresh) a launch of about `L` m/s. */
function powerFor(f: Fighter, L: number, tune: Tune = TUNE): number {
  let lo = 0.01, hi = 20;
  for (let i = 0; i < 60; i++) {
    const p = (lo + hi) / 2, l = launchFor(p, f.wobble + p, f.ragdoll.mass, tune);
    if (Math.hypot(l.out, l.up) < L) lo = p; else hi = p;
  }
  return (lo + hi) / 2;
}

describe('brace', () => {
  /** A body held up and upright by its muscles (no brain, no attacks), braced with `stiff`; the arms' worst guard error over the last second. */
  function holdArms(stiff: number): { off: number; armY: number } {
    const tune = { ...TUNE, stiff };
    const w = ring(tune);
    const f = fighter(w, 'fists', new Vector3(0, 0, 0), 0, tune);
    const m = new Muscles(f.ragdoll, f.layout);
    const arms = f.ragdoll.pieces.filter((p) => p.seg.kind === 'arm');
    let off = 0, armY = -Infinity;
    for (let i = 0; i < 180; i++) {
      m.hover(DT, 1, new Vector3(), tune.gravity);
      m.stand(DT, 1, new Vector3(0, 0, 1), tune.gravity);
      m.brace(DT, 1, null, tune);
      w.step();
      if (i >= 120) {
        for (const a of arms) {
          off = Math.max(off, offGuard(f, a));
          armY = Math.max(armY, new Vector3(0, 1, 0).applyQuaternion(quat(a)).y);
        }
      }
    }
    return { off, armY };
  }

  test('holds the arms near their guard pose under gravity', () => {
    const { off } = holdArms(TUNE.stiff);
    expect(off).toBeLessThan(0.25);
  });

  test('with stiff = 0 the arms hang', () => {
    const { off, armY } = holdArms(0);
    expect(off).toBeGreaterThan(0.45);
    expect(armY, 'the arm points down').toBeLessThan(-0.8);
  });

  test('braced limbs settle: no jitter while standing', () => {
    const w = ring();
    const f = fighter(w, 'fists', new Vector3(0, 0, 0));
    const m = new Muscles(f.ragdoll, f.layout);
    let spin = 0;
    for (let i = 0; i < 180; i++) {
      m.hover(DT, 1, new Vector3(), TUNE.gravity);
      m.stand(DT, 1, new Vector3(0, 0, 1), TUNE.gravity);
      m.brace(DT, 1, null, TUNE);
      w.step();
      if (i >= 120) for (const p of f.ragdoll.pieces) { const a = p.body.angvel(); spin = Math.max(spin, Math.hypot(a.x, a.y, a.z)); }
    }
    expect(spin).toBeLessThan(1);
  });
});

describe('graded hit reactions', () => {
  /** A fresh fighter standing still at the middle (1 s to settle), hit from its −x side with `power` (default: a launch of about `L` m/s). */
  function struck(L: number, kind = 'fists', power?: number) {
    const w = ring();
    const f = fighter(w, kind, new Vector3(0, 0, 0), Math.PI / 2);
    const H = f.layout.standHeight;
    const t = run(w, [f], 1);
    for (const p of f.ragdoll.pieces) p.body.setLinvel({ x: 0, y: 0, z: 0 }, true); // (a lone fighter struts about)
    const p = f.ragdoll.pos();
    f.knock(p.clone().add(new Vector3(-1, 0, 0)), power ?? powerFor(f, L));
    return { w, f, H, t, from: p };
  }

  test('a light hit staggers: pushed away on its feet, not flying, no stun', () => {
    const { w, f, H, t, from } = struck(3.5);
    expect(f.reaction).toBe('stagger');
    expect(f.flying).toBe(false);
    expect(f.stun).toBe(0);
    let low = Infinity, flew = false, away = 0;
    run(w, [f], 1.5, {
      from: t,
      each: (now) => {
        low = Math.min(low, f.ragdoll.pos().y);
        if (f.flying) flew = true;
        if (now - t < 0.5) away = Math.max(away, f.ragdoll.pos().x - from.x);
      },
    });
    expect(low).toBeGreaterThan(0.8 * H);
    expect(flew).toBe(false);
    expect(away, 'pushed away from the blow').toBeGreaterThan(0.3);
    expect(f.reaction).toBe('none');
  });

  test('a medium hit pops: limp for at most tumbleS, then lands on its feet', () => {
    const { w, f, H, t } = struck(6);
    expect(f.reaction).toBe('pop');
    expect(f.flying).toBe(true);
    expect(f.stun).toBeLessThanOrEqual(TUNE.tumbleS + 1e-9);
    let limpUntil = 0, landed = -1, upright = Infinity, low = Infinity;
    run(w, [f], 2, {
      from: t,
      each: (now) => {
        if (f.stun > 0) limpUntil = now - t;
        if (landed < 0 && !f.flying) landed = now;
        if (landed >= 0 && now - landed > 0.15 && now - landed < 0.6) {
          upright = Math.min(upright, Math.cos(lean(f)));
          low = Math.min(low, f.ragdoll.pos().y);
        }
      },
    });
    expect(limpUntil).toBeLessThanOrEqual(TUNE.tumbleS + 2 * DT);
    expect(landed, 'it came down').toBeGreaterThan(0);
    expect(upright, 'landed on its feet').toBeGreaterThan(0.8);
    expect(low).toBeGreaterThan(0.6 * H);
  });

  test('a light blow on a fighter already flying is reported as a stagger; its flight carries on', () => {
    const { f } = struck(6);
    expect(f.reaction).toBe('pop');
    const took = f.knock(f.ragdoll.pos().add(new Vector3(-1, 0, 0)), powerFor(f, 3.5));
    expect(took?.reaction).toBe('stagger');
    expect(f.reaction).toBe('pop');
    expect(f.flying).toBe(true);
  });

  test('a big hit rag-dolls: limp all the way down', () => {
    const { w, f, t } = struck(TUNE.bigLaunch + 2);
    expect(f.reaction).toBe('big');
    expect(f.flying).toBe(true);
    let limp = true, landed = -1;
    run(w, [f], 3, { from: t, each: (now) => { if (f.flying && f.stun <= 0) limp = false; if (landed < 0 && !f.flying) landed = now; } });
    expect(limp).toBe(true);
    expect(landed).toBeGreaterThan(0);
  });

  test('a launch on a fresh fighter (wobble 0) knocks it outward at least 1 m', () => {
    for (const kind of ['fists', 'horns', 'wings']) {
      const { w, f, t, from } = struck(6, kind);
      expect(f.reaction, kind).toBe('pop');
      // how far it was carried before it was steady again (after that a lone fighter walks off on its strut)
      let far = 0, steady = false;
      run(w, [f], 2, { from: t, each: () => { if (!steady) far = Math.max(far, f.ragdoll.pos().x - from.x); if (f.reaction === 'none') steady = true; } });
      expect(steady, kind).toBe(true);
      expect(far, kind).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('kip-up', () => {
  test('a fighter floored when its stun ends hops to its feet within 0.6 s', () => {
    const w = ring();
    const f = fighter(w, 'legs', new Vector3(1, 0, 2), 0.7);
    const H = f.layout.standHeight;
    // lying on its back, creature up → +x, its torso resting on the floor
    const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(0, 1, 0)));
    const torso = f.ragdoll.torso, at = new Vector3(1, torso.seg.radius, 2);
    for (const p of f.ragdoll.pieces) {
      const pos = p.restP.clone().sub(torso.restP).applyQuaternion(q).add(at);
      const rq = q.clone().multiply(p.restQ);
      p.body.setTranslation(pos, true);
      p.body.setRotation({ x: rq.x, y: rq.y, z: rq.z, w: rq.w }, true);
    }
    f.stun = 0.5;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let ended = -1, up = -1;
    run(w, [f], 2.5, {
      each: (t) => {
        if (ended < 0 && f.stun <= 0) ended = t;
        if (ended >= 0 && up < 0 && f.ragdoll.pos().y > 0.8 * H) up = t;
      },
    });
    expect(ended).toBeGreaterThan(0);
    expect(up, 'up on its feet').toBeGreaterThan(0);
    expect(up - ended).toBeLessThanOrEqual(0.6);
    expect(f.standUps, 'the limp guard left the kip-up alone').toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('stability', () => {
  test.each(KINDS.map((k, i) => [k, i] as const))('nothing goes NaN in 60 s of a four-way bout with %s', (kind, i) => {
    const w = ring();
    const cast = [kind, KINDS[(i + 2) % 7], KINDS[(i + 4) % 7], KINDS[(i + 5) % 7]];
    const fs = cast.map((k, j) => {
      const a = (j / 4) * Math.PI * 2;
      return fighter(w, k, new Vector3(Math.cos(a) * 3, 0, Math.sin(a) * 3), Math.atan2(-Math.cos(a), -Math.sin(a)), TUNE, j + 1);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let bad = '';
    run(w, fs, 60, {
      each: (t, hits) => {
        if (bad) return;
        for (const h of hits) if (!Number.isFinite(h.launch)) bad = `launch at ${t}`;
        for (const f of fs) {
          if (!f.ragdoll.pieces.length) continue;
          for (const p of f.ragdoll.pieces) {
            const r = p.body.translation(), v = p.body.linvel();
            if (!Number.isFinite(r.x + r.y + r.z + v.x + v.y + v.z)) bad = `${f.id} at ${t.toFixed(2)}`;
          }
        }
      },
    });
    warn.mockRestore();
    expect(bad).toBe('');
  }, 60_000);
});
