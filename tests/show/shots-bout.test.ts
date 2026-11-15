import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, test } from 'vitest';
import { RingLoop } from '../../src/app/loop';
import { addArenaColliders } from '../../src/arena/colliders';
import { RingFeatures } from '../../src/arena/features';
import { postAngles } from '../../src/arena/geometry';
import { buildSkeleton } from '../../src/builder/skeleton';
import { Fighter } from '../../src/fight/fighter';
import { planFor } from '../../src/fight/moves';
import { TUNE } from '../../src/fight/tune';
import { Match } from '../../src/match/match';
import { ragdollLayout } from '../../src/physics/layout';
import { createWorld, initPhysics } from '../../src/physics/world';
import { CameraDirector } from '../../src/show/camera';
import { MAX_HOLD, MIN_HOLD, shotCues, type ShotCue } from '../../src/show/shot-picker';
import { propSpheres, SHOT_NAMES, STANDS_IN, STANDS_TOP, type ShotName, type Sphere } from '../../src/show/shots';
import { SlowMo } from '../../src/show/slowmo';
import { mulberry32 } from '../../src/util/rng';
import { loadFixture } from '../fixtures/fighters';

/**
 * The shot director over real (headless) bouts: every frame of every shot keeps its fighters in view, never puts the
 * camera inside a fighter, the bumper, a post or the stands, and sees the fighters' feet over the bumper.
 */

beforeAll(initPhysics);

const DT = 1 / 60;
const R = TUNE.ringRadius;
const TV = 16 / 9;

type Bout = { loop: RingLoop; features: RingFeatures; director: CameraDirector; cam: PerspectiveCamera };

function bout(kinds: string[], seed: number): Bout {
  const world = createWorld(TUNE.gravity);
  const { floor } = addArenaColliders(world, TUNE);
  const features = new RingFeatures(world, TUNE, { rng: mulberry32(seed), floor });
  const ids = kinds.map((k, i) => `${k}-${i}`);
  const match = new Match();
  match.arrive(ids);
  match.tick(30);
  const loop = new RingLoop({ world, match, slowmo: new SlowMo(), tune: TUNE, features, rng: mulberry32(seed + 1) });
  kinds.forEach((kind, i) => {
    const recipe = loadFixture(kind);
    const sk = buildSkeleton(recipe);
    const plan = planFor(recipe, sk);
    const f = new Fighter(ids[i], world, ragdollLayout(sk, plan), plan, { tune: TUNE, rng: mulberry32(seed * 31 + i) });
    const a = (i / kinds.length) * Math.PI * 2 + 0.3;
    f.ragdoll.pose(new Vector3(Math.cos(a) * R * 0.4, 0, Math.sin(a) * R * 0.4), Math.atan2(-Math.cos(a), -Math.sin(a)));
    f.state = 'fighting';
    loop.add(f);
  });
  const props: Sphere[] = [];
  const director = new CameraDirector({ ringRadius: R, bumper: TUNE.bumper, fov: 50 }, {
    props: () => propSpheres(features, props), event: () => features.event !== null, rng: mulberry32(seed + 7),
  });
  director.cut();
  const cam = new PerspectiveCamera(50, TV, 0.1, 300);
  return { loop, features, director, cam };
}

/** Inside the frame (normalised device coordinates), with a little slack, and in front of the camera. */
function inFrame(p: Vector3, c: PerspectiveCamera, slack = 1): boolean {
  const q = p.clone().project(c);
  return Math.abs(q.x) <= slack && Math.abs(q.y) <= slack && q.z < 1 && q.z > -1;
}

/** The lowest height over the bumper's band of the straight line from `a` to `b`. */
function overBumper(a: Vector3, b: Vector3): number {
  let low = Infinity;
  for (let i = 0; i <= 200; i++) {
    const p = a.clone().lerp(b, i / 200);
    if (Math.abs(Math.hypot(p.x, p.z) - (R + 0.15)) <= 0.28) low = Math.min(low, p.y);
  }
  return low;
}

type Tally = {
  frames: number; shots: Partial<Record<ShotName, number>>; cuts: number; outOfFrame: string[]; inside: string[]; blocked: string[];
  longest: number;
  /** Every shot's length (s) once it was cut away from, and the frames spent on rotation shots (rank 0). */
  holds: number[]; rotationFrames: number;
  /** The moments that must be seen (frame index, kind, who) and, every frame, the shot on screen and whom it is about. */
  moments: { at: number; kind: ShotCue['kind']; id?: string }[]; seen: { shot: ShotName; a?: string; b?: string; inView: string[] }[];
  /** The frame each bout ended on (a moment too near the end had no time to be shown). */
  boutEnds: number[];
};

/** One frame of the bout with the director checked against it. */
function frame(b: Bout, t: number, tally: Tally): void {
  const r = b.loop.step(DT, t);
  const before = b.director.shot, heldBefore = b.director.picker.held;
  const cues = shotCues(r, TUNE.bigLaunch);
  for (const c of cues) {
    if (c.kind === 'special' || c.kind === 'throw' || c.kind === 'ringOut' || c.kind === 'event') {
      tally.moments.push({ at: tally.frames, kind: c.kind, id: 'id' in c ? c.id : undefined });
    }
  }
  b.director.action(DT, b.loop.all(), cues);
  b.director.apply(b.cam);
  b.cam.updateMatrixWorld();
  const shot = b.director.shot;
  if (shot !== before || b.director.picker.held < heldBefore) {
    tally.cuts++;
    tally.holds.push(heldBefore + DT);
  }
  if (b.director.picker.pick.rank === 0) tally.rotationFrames++;
  tally.longest = Math.max(tally.longest, b.director.picker.held);
  tally.frames++;
  tally.shots[shot] = (tally.shots[shot] ?? 0) + 1;
  const pos = b.cam.position, at = `${shot} t=${t.toFixed(2)}`;
  const fs = b.loop.all().filter((f) => f.ragdoll.pieces.length && f.state !== 'gone');
  const inView = fs.filter((f) => { const p = f.ragdoll.torso.body.translation(); return inFrame(new Vector3(p.x, p.y, p.z), b.cam); });
  tally.seen.push({ shot, ...b.director.subjects, inView: inView.map((f) => f.id) });
  const { a, b: bb } = b.director.subjects;
  const subjects = a ? fs.filter((f) => f.id === a || f.id === bb) : fs.filter((f) => f.state === 'fighting');
  for (const f of subjects) {
    const p = f.ragdoll.torso.body.translation(), torso = new Vector3(p.x, p.y, p.z);
    if (!inFrame(torso, b.cam)) {
      const q = torso.clone().project(b.cam);
      tally.outOfFrame.push(`${at} ${f.id} at ${torso.toArray().map((v) => v.toFixed(1))} cam ${pos.toArray().map((v) => v.toFixed(1))} look ${b.director.look.toArray().map((v) => v.toFixed(1))} ndc ${q.x.toFixed(2)},${q.y.toFixed(2)} subj ${subjects.map((g) => g.id + ':' + g.state).join(',')}`);
    }
    // its feet seen over the bumper
    const feet = new Vector3(p.x, Math.max(0, p.y - 0.55 * f.layout.ringHeight), p.z);
    const onIt = Math.abs(Math.hypot(p.x, p.z) - (R + 0.15)) < 0.28 + 0.35; // up on the bumper: in sight over it
    if (f.state === 'fighting' && !onIt && overBumper(pos, feet) < TUNE.bumper) tally.blocked.push(`${at} ${f.id} cam ${pos.toArray().map((v) => v.toFixed(2))} feet ${feet.toArray().map((v) => v.toFixed(2))} over ${overBumper(pos, feet).toFixed(2)}`);
  }
  // the camera is inside nothing
  for (const f of fs) {
    for (const piece of f.ragdoll.pieces) {
      const q = piece.body.translation();
      if (pos.distanceTo(new Vector3(q.x, q.y, q.z)) < 0.4) tally.inside.push(`${at} in ${f.id}`);
    }
  }
  const rr = Math.hypot(pos.x, pos.z);
  if (Math.abs(rr - (R + 0.15)) < 0.28 + 0.05 && pos.y < TUNE.bumper + 0.1) tally.inside.push(`${at} in the bumper`);
  for (const ang of postAngles()) {
    const px = Math.cos(ang) * (R + 0.6), pz = Math.sin(ang) * (R + 0.6);
    if (Math.hypot(pos.x - px, pos.z - pz) < 0.45 && pos.y < 1.4) tally.inside.push(`${at} in a post`);
  }
  if (rr > STANDS_IN && pos.y < STANDS_TOP) tally.inside.push(`${at} in the stands`);
  if (b.features.ball) {
    const q = b.features.ball.body.translation();
    if (pos.distanceTo(new Vector3(q.x, q.y, q.z)) < b.features.ball.radius + 0.1) tally.inside.push(`${at} in the beach ball`);
  }
  for (const p of b.features.posts) {
    if (p.up > 0.5 && Math.hypot(pos.x - p.at.x, pos.z - p.at.z) < 0.7 && pos.y < 1.2) tally.inside.push(`${at} in a pinball post`);
  }
}

const tallyOf = (): Tally => ({ frames: 0, shots: {}, cuts: 0, outOfFrame: [], inside: [], blocked: [], longest: 0, holds: [], rotationFrames: 0, moments: [], seen: [], boutEnds: [] });
/** The shot each moment must be shown in, and how long (s) after it happened it may come (it is held until it can cut in). */
const SHOWN_IN: Partial<Record<ShotCue['kind'], ShotName>> = { special: 'hero', throw: 'duel', ringOut: 'ringOut', event: 'crane' };
const SHOWN_WITHIN: Partial<Record<ShotCue['kind'], number>> = { special: 2, throw: 2, ringOut: 2, event: 7 };
/** How many of each kind of moment happened, and how many were shown (its shot, on its fighter, soon after). */
function shown(t: Tally): Record<string, { happened: number; shown: number }> {
  const out: Record<string, { happened: number; shown: number }> = {};
  for (const m of t.moments) {
    const end = m.at + Math.round(SHOWN_WITHIN[m.kind]! / DT);
    if (t.boutEnds.some((e) => m.at < e && end > e)) continue; // its bout ended before it could be shown
    const o = (out[m.kind] ??= { happened: 0, shown: 0 });
    o.happened++;
    for (let i = m.at; i < end; i++) {
      const s = t.seen[i];
      // its shot on its fighter (a special is seen just as well in a duel or hero shot already on its attacker, or in
      // whatever shot on screen has its attacker in the frame: owner 2026-11-15, not every special needs a close-up)
      const close = m.kind === 'special' && (((s.shot === 'hero' || s.shot === 'duel') && (s.a === m.id || s.b === m.id)) || s.inView.includes(m.id!));
      if (close || (s.shot === SHOWN_IN[m.kind] && (m.id === undefined || s.a === m.id))) { o.shown++; break; }
    }
  }
  return out;
}
/** The middle value of `xs`. */
const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
/** The camera's rhythm over a bout: cuts a minute, the median hold, the rotation's share and each shot's share. */
function cadence(t: Tally) {
  const shares: Record<string, number> = {};
  for (const [k, v] of Object.entries(t.shots)) shares[k] = Math.round((1000 * v) / t.frames) / 1000;
  return {
    cutsPerMin: Math.round((t.cuts / (t.frames * DT / 60)) * 10) / 10, medianHold: Math.round(median(t.holds) * 100) / 100,
    rotation: Math.round((1000 * t.rotationFrames) / t.frames) / 1000, longest: Math.round(t.longest * 100) / 100, shares,
  };
}
/** At most this share of frames may have a fighter a little outside the frame (the eased camera catching up after a hit). */
const OUT_SHARE = 0.01;
/** At least this share of a bout's frames are the rotation's shots (the moments' shots do not crowd it out). */
const ROTATION_SHARE = 0.4;
/** ...and the camera cuts no more than this often (a minute). */
const MAX_CUTS_PER_MIN = 24;
/**
 * Each of the two bouts runs this long (s): long enough for a ring-out or two (the first comes a median ~47 s into a
 * four-way bout since the wild ring's final balance; at 45 s, and at 60 s, these two bouts had none).
 */
const BOUT_S = 80;
/** At least this share of specials and throws are shown (in their shot on their fighter, or a special's attacker in the frame, within 2 s). */
const SHOWN_SHARE = 0.9;

describe('the shot director over headless bouts', () => {
  test('a four-way bout with the ring’s events: the action stays in view and the camera inside nothing', () => {
    const tally = tallyOf();
    for (const [kinds, seed] of [[['fists', 'legs', 'blob', 'horns'], 11], [['tiny', 'wings', 'tail', 'fists'], 23]] as const) {
      const b = bout([...kinds], seed);
      // a ring event early, so the bout sees one under way
      let t = 0;
      for (let i = 0; i < 60 * BOUT_S; i++) {
        t += DT;
        if (i === 60 * 8) b.features.startEvent(seed === 11 ? 'beachBall' : 'pinball');
        frame(b, t, tally);
      }
      tally.boutEnds.push(tally.frames);
    }
    expect(tally.inside.slice(0, 10)).toEqual([]);
    expect(tally.blocked.slice(0, 10)).toEqual([]);
    expect(tally.outOfFrame.length / tally.frames, tally.outOfFrame.slice(0, 10).join('\n')).toBeLessThanOrEqual(OUT_SHARE);
    expect(tally.longest).toBeLessThanOrEqual(MAX_HOLD + 1e-6);
    expect(Object.keys(tally.shots).length).toBeGreaterThanOrEqual(4); // it changes angles
    // ...at a rhythm young children can follow: shots hold a few seconds, and the rotation gets its share
    const c = cadence(tally);
    const moments = shown(tally);
    if (process.env.SHOT_CADENCE) console.log(JSON.stringify(c), JSON.stringify(moments));
    // the moments that matter are seen: every ring-out, nearly every special and throw, a crane after an event's start
    const rate = (k: string) => (moments[k] ? moments[k].shown / moments[k].happened : 1);
    expect(moments.ringOut?.happened ?? 0).toBeGreaterThan(0);
    expect(rate('ringOut'), JSON.stringify(moments)).toBe(1);
    expect(rate('special'), JSON.stringify(moments)).toBeGreaterThanOrEqual(SHOWN_SHARE);
    expect(rate('throw'), JSON.stringify(moments)).toBeGreaterThanOrEqual(SHOWN_SHARE);
    expect(moments.event?.happened ?? 0).toBeGreaterThan(0);
    expect(rate('event'), JSON.stringify(moments)).toBe(1);
    expect(c.medianHold, JSON.stringify(c)).toBeGreaterThanOrEqual(MIN_HOLD);
    expect(c.rotation, JSON.stringify(c)).toBeGreaterThanOrEqual(ROTATION_SHARE);
    expect(c.cutsPerMin, JSON.stringify(c)).toBeLessThanOrEqual(MAX_CUTS_PER_MIN);
  }, 30_000);

  test('every shot, cut to in turn during a fight (held whatever happens), frames its subjects and keeps the camera clear', () => {
    const tally = tallyOf();
    const b = bout(['legs', 'blob', 'wings', 'horns', 'tiny'], 5);
    let t = 0;
    for (let i = 0; i < 60 * 3; i++) frame(b, (t += DT), tally); // the fight gets going
    for (let round = 0; round < 3; round++) {
      for (const name of SHOT_NAMES) {
        b.director.forceShot(name);
        for (let i = 0; i < 60 * 2.5; i++) {
          frame(b, (t += DT), tally);
        }
      }
    }
    expect(tally.inside.slice(0, 10)).toEqual([]);
    expect(tally.blocked.slice(0, 10)).toEqual([]);
    expect(tally.outOfFrame.length / tally.frames, tally.outOfFrame.slice(0, 10).join('\n')).toBeLessThanOrEqual(OUT_SHARE);
    for (const name of SHOT_NAMES) expect(tally.shots[name] ?? 0, name).toBeGreaterThan(0);
  }, 30_000);
});
