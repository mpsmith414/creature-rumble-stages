import { Color, Scene, Vector3 } from 'three/webgpu';
import { describe, expect, test, vi } from 'vitest';
import { ENTRY_ANGLE, angleDiff, postAngles } from '../../src/arena/geometry';
import { BURST, CONFETTI_S, ConfettiCannons, nearestPosts } from '../../src/show/confetti-cannons';
import {
  BOB_H, CROWD_COLOURS, CROWD_GAP, CrowdMotion, CrowdStands, crowdSeats, JUMP_H, JUMP_S, JUMP_SPREAD, WAVE_FIRST_MAX, WAVE_FIRST_MIN, WAVE_H, WAVE_S,
} from '../../src/show/crowd-stands';
import { EventLook, EventLooks, LOOK_FADE_S, lookFor, trailsOn } from '../../src/show/event-look';
import { RIM_BAND, RIM_CHASE, RIM_COUNT, RIM_DIM, RIM_FAST, RIM_FLASH_S, RIM_FLASH_SPAN, RIM_GOLD, RimLights, rimSpot, RimState } from '../../src/show/rim-lights';
import { RingLooks, type LooksView } from '../../src/show/ring-looks';
import { SPOT_COUNT, SPOT_FAST, SPOT_REACH, SPOT_SPEED, SpotClock, spotAt } from '../../src/show/spotlights';
import { mulberry32 } from '../../src/util/rng';

const R = 6.5, DT = 1 / 60;
const run = (n: number, fn: () => void) => { for (let i = 0; i < n; i++) fn(); };

describe('rim lights', () => {
  test('the chase moves RIM_CHASE lights a second, RIM_FAST × that in an event, and wraps round the ring', () => {
    const s = new RimState();
    s.update(1, false);
    expect(s.phase).toBeCloseTo(RIM_CHASE);
    s.phase = 0;
    s.update(1, true);
    expect(s.phase).toBeCloseTo(RIM_CHASE * RIM_FAST);
    s.update(100, false);
    expect(s.phase).toBeGreaterThanOrEqual(0);
    expect(s.phase).toBeLessThan(RIM_COUNT);
  });

  test('a band of lit lights every RIM_BAND lights; the rest glow dim; the band moves with the phase', () => {
    const s = new RimState();
    const levels = Array.from({ length: RIM_COUNT }, (_, i) => s.level(i));
    expect(Math.max(...levels)).toBeGreaterThan(0.9);
    expect(Math.min(...levels)).toBeCloseTo(RIM_DIM);
    expect(levels.filter((l) => l > 0.9)).toHaveLength(RIM_COUNT / RIM_BAND); // one peak per band
    const lit = levels.findIndex((l) => l > 0.9);
    s.phase = 2;
    expect(s.level(lit + 2)).toBeCloseTo(levels[lit]);
  });

  test('a big hit flashes the whole rim white, fading over RIM_FLASH_S; a plain hit only its side of the ring', () => {
    const s = new RimState(), c = new Color();
    s.hit();
    s.colour(5, c);
    expect([c.r, c.g, c.b].every((v) => v > 0.99)).toBe(true);
    expect(s.white(RIM_COUNT / 2)).toBe(1);
    s.update(RIM_FLASH_S / 2, false);
    expect(s.white(0)).toBeGreaterThan(0);
    expect(s.white(0)).toBeLessThan(1);
    s.update(RIM_FLASH_S, false);
    expect(s.white(0)).toBe(0);
    s.hit(0); // a hit at angle 0: light 0's side
    expect(s.white(0)).toBe(1);
    expect(s.white(2)).toBeGreaterThan(0);
    expect(s.white(2)).toBeLessThan(1);
    expect(s.white(RIM_COUNT / 2)).toBe(0); // the far side keeps chasing
    expect(s.white(Math.round((RIM_FLASH_SPAN / (Math.PI * 2)) * RIM_COUNT) + 1)).toBe(0);
    s.update(RIM_FLASH_S, false);
    s.hit();
    s.hit(0); // a plain hit straight after a big one leaves the whole-rim flash be
    expect(s.flashAt).toBeNull();
    s.update(RIM_FLASH_S, false);
    s.crown();
    const gold = new Color(RIM_GOLD);
    for (let i = 0; i < RIM_COUNT; i++) {
      s.colour(i, c);
      const k = s.level(i);
      expect(c.r).toBeCloseTo(gold.r * k);
      expect(c.b).toBeCloseTo(gold.b * k);
    }
    s.reset();
    expect(s.gold).toBe(false);
    s.colour(1, c);
    expect(c.b).toBeGreaterThan(c.r); // light 1 is sky blue again
  });

  test('the blobs sit on the bumper’s upper outer face, follow its height, and hide with no bumper', () => {
    const p = rimSpot(0, R, 0.65);
    expect(Math.hypot(p.x, p.z)).toBeGreaterThan(R + 0.15);
    expect(p.y).toBeGreaterThan(0.65 / 2);
    expect(p.y).toBeLessThan(0.65 + 0.1);
    const rim = new RimLights(new Scene(), R);
    rim.update(DT, false, 0.65);
    expect(rim.mesh.count).toBe(RIM_COUNT);
    expect(rim.mesh.visible).toBe(true);
    rim.update(DT, false, 0);
    expect(rim.mesh.visible).toBe(false);
  });
});

describe('sweeping spotlights', () => {
  test('four pools, always on the floor within SPOT_REACH of the middle, spread round the ring', () => {
    const p = { x: 0, z: 0 };
    for (let t = 0; t < 200; t += 0.37) {
      for (let i = 0; i < SPOT_COUNT; i++) {
        spotAt(i, t, R, p);
        expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(R * SPOT_REACH + 1e-9);
      }
    }
    const angles = Array.from({ length: SPOT_COUNT }, (_, i) => { spotAt(i, 0, R, p); return Math.atan2(p.z, p.x); });
    for (let i = 1; i < SPOT_COUNT; i++) expect(Math.abs(angleDiff(angles[i], angles[0]))).toBeGreaterThan(1);
  });

  test('they glide at SPOT_SPEED, SPOT_FAST × faster in an event, without a jump', () => {
    const c = new SpotClock();
    c.update(1, false);
    expect(c.phase).toBeCloseTo(SPOT_SPEED);
    const before = c.phase;
    c.update(DT, true);
    expect(c.phase - before).toBeCloseTo(DT * SPOT_SPEED * SPOT_FAST);
  });
});

describe('the crowd', () => {
  test('~240 blobs in six colours round the pit, none on the entry’s line', () => {
    const seats = crowdSeats();
    expect(seats.length).toBeGreaterThanOrEqual(220);
    expect(seats.length).toBeLessThanOrEqual(260);
    expect(new Set(seats.map((s) => s.colour)).size).toBe(CROWD_COLOURS.length);
    for (const s of seats) {
      expect(Math.abs(angleDiff(s.angle, ENTRY_ANGLE))).toBeGreaterThanOrEqual(CROWD_GAP);
      expect(Math.hypot(s.x, s.z)).toBeGreaterThan(R + 6);
    }
  });

  test('they bob gently, never higher than BOB_H, and not all together', () => {
    const m = new CrowdMotion(mulberry32(1)), seats = crowdSeats();
    m.nextWave = Infinity;
    const lifts = new Set<number>();
    run(120, () => {
      m.update(DT);
      for (const s of seats.slice(0, 20)) {
        const up = m.lift(s);
        expect(up).toBeGreaterThanOrEqual(0);
        expect(up).toBeLessThanOrEqual(BOB_H + 1e-9);
      }
      lifts.add(Math.round(m.lift(seats[0]) * 1e4) - Math.round(m.lift(seats[1]) * 1e4));
    });
    expect(lifts.size).toBeGreaterThan(5);
  });

  test('a roar: everyone jumps JUMP_H, each a little late, and is back down within JUMP_S + JUMP_SPREAD', () => {
    const m = new CrowdMotion(mulberry32(2)), seats = crowdSeats();
    m.nextWave = Infinity;
    m.cheer();
    const top = new Map<number, number>();
    for (let t = 0; t < JUMP_S + JUMP_SPREAD + 0.05; t += DT) {
      m.update(DT);
      seats.forEach((s, i) => top.set(i, Math.max(top.get(i) ?? 0, m.lift(s))));
    }
    for (const h of top.values()) expect(h).toBeGreaterThan(JUMP_H * 0.95);
    m.update(DT);
    for (const s of seats) expect(m.lift(s)).toBeLessThanOrEqual(BOB_H + 1e-9);
    // a reset cancels a jump under way
    m.cheer();
    m.update(JUMP_SPREAD + JUMP_S / 2);
    m.reset();
    for (const s of seats) expect(m.lift(s)).toBeLessThanOrEqual(BOB_H + 1e-9);
  });

  test('a wave now and then: the first WAVE_FIRST_MIN–MAX s in, round the ring once, seats lifted in turn', () => {
    const m = new CrowdMotion(mulberry32(3));
    expect(m.nextWave).toBeGreaterThanOrEqual(WAVE_FIRST_MIN);
    expect(m.nextWave).toBeLessThanOrEqual(WAVE_FIRST_MAX);
    while (!m.waving) m.update(DT);
    const from = m.waveFrom;
    const seat = (off: number) => ({ angle: from + off, delay: 0, bob: 0 });
    // when is a seat a quarter and a half way round lifted highest?
    const peak = (off: number) => {
      const c = Object.assign(new CrowdMotion(mulberry32(3)), { t: m.t, waveAt: m.waveAt, waveFrom: from, nextWave: Infinity });
      let best = 0, at = 0;
      for (let t = 0; t < WAVE_S; t += DT) {
        c.update(DT);
        const up = c.lift(seat(off));
        if (up > best) { best = up; at = t; }
      }
      return { best, at };
    };
    const q = peak(Math.PI / 2), h = peak(Math.PI);
    expect(q.best).toBeGreaterThan(WAVE_H * 0.9);
    expect(h.at).toBeGreaterThan(q.at + 0.3);
    const next = m.nextWave;
    run(Math.ceil(WAVE_S / DT) + 1, () => m.update(DT));
    expect(m.waving).toBe(false);
    expect(next).toBeGreaterThan(m.waveAt + WAVE_S);
  });

  test('a frame of the crowd costs well under 1 ms (CPU: the motion and 240 matrices)', () => {
    const c = new CrowdStands(new Scene(), { rng: mulberry32(4) });
    run(200, () => c.update(DT)); // warm the code up
    c.cheer();
    const N = 2000, t0 = performance.now();
    run(N, () => c.update(DT));
    const ms = (performance.now() - t0) / N;
    expect(ms).toBeLessThan(1);
    expect(c.eyes.instanceMatrix).toBe(c.bodies.instanceMatrix); // the eyes ride their blobs: one buffer
  });
});

describe('confetti cannons', () => {
  test('the two posts nearest a ring-out are picked, nearest first', () => {
    const posts = postAngles();
    for (const a of [0, 1, 2.5, -2, Math.PI]) {
      const at = { x: Math.cos(a) * 9, z: Math.sin(a) * 9 };
      const [p, q] = nearestPosts(at, posts);
      const d = posts.map((x) => Math.abs(angleDiff(x, a))).sort((x, y) => x - y);
      expect(Math.abs(angleDiff(posts[p], a))).toBeCloseTo(d[0]);
      expect(Math.abs(angleDiff(posts[q], a))).toBeCloseTo(d[1]);
    }
  });

  test('a ring-out fires a burst from each of the two, up over the ring; spent pieces vanish; clear takes them all', () => {
    const posts = postAngles(), c = new ConfettiCannons(new Scene(), posts, R + 0.6, { rng: mulberry32(5) });
    const fired = c.ringOut({ x: 10, z: 0.5 });
    expect(fired).toEqual(nearestPosts({ x: 10, z: 0.5 }, posts));
    expect(c.count).toBe(2 * BURST);
    expect(c.mesh.visible).toBe(true);
    run(20, () => c.update(DT));
    const m = c.mesh.instanceMatrix.array;
    expect(m[13]).toBeGreaterThan(1.35); // the first piece flew up
    run(Math.ceil(CONFETTI_S / DT) + 2, () => c.update(DT));
    expect(c.count).toBe(0);
    expect(c.mesh.visible).toBe(false);
    c.ringOut({ x: -10, z: 0 });
    c.clear();
    expect(c.count).toBe(0);
  });
});

describe('event looks', () => {
  test('each event turns on its own look: Bounce Party the floor pulse, Moon Jump the night (and trails), Pinball the arrows', () => {
    expect(lookFor('bounceParty')).toEqual({ pulse: 1, night: 0, arrows: 0 });
    expect(lookFor('moonJump')).toEqual({ pulse: 0, night: 1, arrows: 0 });
    expect(lookFor('pinball')).toEqual({ pulse: 0, night: 0, arrows: 1 });
    expect(lookFor('beachBall')).toEqual({ pulse: 0, night: 0, arrows: 0 });
    expect(lookFor(null)).toEqual({ pulse: 0, night: 0, arrows: 0 });
    expect(trailsOn('moonJump')).toBe(true);
    expect(trailsOn('pinball')).toBe(false);
    expect(trailsOn(null)).toBe(false);
  });

  test('a look fades in over LOOK_FADE_S, switches to the next event’s, and reset snaps back to the normal look', () => {
    const l = new EventLook();
    l.update(LOOK_FADE_S / 2, 'moonJump');
    expect(l.level.night).toBeCloseTo(0.5);
    l.update(LOOK_FADE_S, 'moonJump');
    expect(l.level.night).toBe(1);
    l.update(LOOK_FADE_S / 2, 'pinball');
    expect(l.level.night).toBeCloseTo(0.5);
    expect(l.level.arrows).toBeCloseTo(0.5);
    l.reset();
    expect(l.level).toEqual({ pulse: 0, night: 0, arrows: 0 });
  });

  test('drawn: the night reaches the arena’s backdrop; overlays show only while their level is up', () => {
    const night = vi.fn<(k: number) => void>();
    const e = new EventLooks(new Scene(), R, ENTRY_ANGLE + Math.PI / 3, night);
    expect(e.pulse.visible || e.arrows.visible).toBe(false);
    e.update(1, 'moonJump');
    expect(night).toHaveBeenLastCalledWith(1);
    e.update(1, 'bounceParty');
    expect(night).toHaveBeenLastCalledWith(0);
    expect(e.pulse.visible).toBe(true);
    e.update(1, 'pinball');
    expect(e.arrows.visible).toBe(true);
    e.reset();
    expect(night).toHaveBeenLastCalledWith(0);
    expect(e.pulse.visible || e.arrows.visible).toBe(false);
  });
});

/** The features as the looks read them: plain objects (the props and events, no physics). */
function view(): LooksView & { event: { name: 'bounceParty' | 'moonJump' | 'beachBall' | 'pinball' } | null } {
  return {
    pads: [0, 1, 2, 3].map((i) => ({ at: new Vector3(Math.cos(i) * 4.3, 0, Math.sin(i) * 4.3), armed: true, charge: 1 })),
    posts: [0, 1, 2].map((i) => ({ at: new Vector3(Math.cos(i * 2) * 2.3, 0, Math.sin(i * 2) * 2.3), up: 0 })),
    ball: null,
    event: null,
  };
}

describe('RingLooks', () => {
  const make = () => {
    const v = view(), looks = new RingLooks(new Scene(), { ringRadius: R, bumper: () => 0.65, features: v });
    return { v, looks };
  };

  test('a hit flashes the rim on its side; only a big one flashes it all and makes the crowd jump; an event’s start is a roar', () => {
    const { looks } = make();
    looks.hit(false, { x: 0, z: 5 });
    expect(looks.rim.state.flash).toBe(RIM_FLASH_S);
    expect(looks.rim.state.flashAt).toBeCloseTo(Math.PI / 2);
    expect(looks.crowd.motion.jumpAt).toBe(-Infinity);
    looks.hit(true, { x: 0, z: 5 });
    expect(looks.rim.state.flashAt).toBeNull();
    expect(looks.crowd.motion.jumpAt).toBe(looks.crowd.motion.t);
    looks.reset();
    looks.cue({ type: 'event', event: 'pinball', phase: 'end' });
    expect(looks.crowd.motion.jumpAt).toBe(-Infinity);
    looks.cue({ type: 'event', event: 'pinball', phase: 'start' });
    expect(looks.crowd.motion.jumpAt).toBe(looks.crowd.motion.t);
  });

  test('an event makes the rim and the spotlights run fast and turns on its look; it fades once the event is over', () => {
    const { v, looks } = make();
    looks.update(1, v);
    const slow = looks.rim.state.phase, spots = looks.spots.clock.phase;
    v.event = { name: 'bounceParty' };
    looks.update(1, v);
    expect(looks.rim.state.phase - slow).toBeCloseTo((RIM_CHASE * RIM_FAST) % RIM_COUNT);
    expect(looks.spots.clock.phase - spots).toBeCloseTo(SPOT_SPEED * SPOT_FAST);
    expect(looks.events.look.level.pulse).toBe(1);
    v.event = null; // the features' reset (the crowning) ends an event with no cue: the look follows the state
    looks.update(1, v);
    expect(looks.events.look.level.pulse).toBe(0);
  });

  test('a ring-out fires the cannons nearest it and roars; the crowning turns the rim gold; reset brings the normal look back', () => {
    const { v, looks } = make();
    looks.ringOut({ x: 0, z: -9 });
    expect(looks.confetti.count).toBe(2 * BURST);
    expect(looks.crowd.motion.jumpAt).toBe(looks.crowd.motion.t);
    looks.crown();
    expect(looks.rim.state.gold).toBe(true);
    v.event = { name: 'moonJump' };
    looks.update(1, v);
    expect(looks.events.look.level.night).toBe(1);
    looks.reset();
    expect(looks.rim.state.gold).toBe(false);
    expect(looks.events.look.level.night).toBe(0);
    expect(looks.confetti.count).toBe(0);
    expect(looks.crowd.motion.jumpAt).toBe(-Infinity);
  });

  test('a ding flashes its post; prepare shows everything hidden for a compile and hides it again', () => {
    const { v, looks } = make();
    v.posts[1].up = 1;
    looks.update(DT, v);
    looks.cue({ type: 'bump', post: 1, id: 'a', at: new Vector3() });
    looks.update(DT, v);
    expect(looks.props!.group.children.filter((o) => o.visible).length).toBeGreaterThan(0);
    const hiddenBefore = looks.props!.group.children.filter((o) => !o.visible).length;
    expect(hiddenBefore).toBeGreaterThan(0);
    looks.prepare(true);
    expect(looks.props!.group.children.every((o) => o.visible)).toBe(true);
    expect(looks.events.arrows.visible && looks.confetti.mesh.visible).toBe(true);
    looks.prepare(false);
    expect(looks.props!.group.children.filter((o) => !o.visible).length).toBe(hiddenBefore);
    expect(looks.events.arrows.visible || looks.confetti.mesh.visible).toBe(false);
  });
});
