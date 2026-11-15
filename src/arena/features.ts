import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three/webgpu';
import type { Fighter } from '../fight/fighter';
import type { Tune } from '../fight/tune';
import { ENTRY_ANGLE } from './geometry';

/**
 * The wild ring (design 2026-11-14 §5.1): spring pads, and the ring events (Bounce Party, Moon Jump, Beach Ball,
 * Pinball). Physics and rules only: the loop and the headless sim both run it, the show turns its cues into words and
 * sounds, and their looks are drawn elsewhere. All randomness comes from the injected `rng`.
 */

export type RingEventName = 'bounceParty' | 'moonJump' | 'beachBall' | 'pinball';
export const RING_EVENTS: readonly RingEventName[] = ['bounceParty', 'moonJump', 'beachBall', 'pinball'];

/** What happened this step, for the show (and the camera, later). */
export type FeatureCue =
  /** A spring pad fired its fighter into a pad jump. */
  | { type: 'pad'; pad: number; id: string; at: Vector3 }
  /** A risen pinball post kicked a fighter away. */
  | { type: 'bump'; post: number; id: string; at: Vector3 }
  /** The beach ball bonked a fighter. */
  | { type: 'ball'; id: string; at: Vector3 }
  | { type: 'event'; event: RingEventName; phase: 'start' | 'end' };

/** A spring pad: where it lies (on the floor), whether it is armed, and how charged (0 … 1 until it is armed again). */
export type Pad = { at: Vector3; armed: boolean; charge: number };
/** A pinball post: where it stands (on the floor) and how far risen (0 down … 1 up). */
export type Post = { at: Vector3; up: number };

/** Spring pads: `PAD_COUNT` of them, `PAD_RING` m out, 90° apart, the first `PAD_FIRST` rad round from the entry; `PAD_RADIUS` m round. */
export const PAD_COUNT = 4, PAD_RING = 4.3, PAD_FIRST = Math.PI / 4, PAD_RADIUS = 0.85;
/**
 * An armed pad fires a fighting fighter whose torso is within `PAD_REACH` m of its middle (level) and lower than
 * `PAD_LOW` × its stand height (it is standing or walking there, not flying over); it is armed again `PAD_REARM_S` s on.
 */
export const PAD_REACH = 0.8, PAD_LOW = 1.4, PAD_REARM_S = 4;
/**
 * Ring events: the first starts `FIRST_MIN`–`FIRST_MAX` s into a round and the next `GAP_MIN`–`GAP_MAX` s after the
 * last one ended (the clock runs only while 2+ fight and nobody is entering; never while a special is under way).
 */
export const FIRST_MIN = 25, FIRST_MAX = 35, GAP_MIN = 30, GAP_MAX = 45;
/** How long (s) each event lasts (the beach ball's is its longest: it ends sooner once the ball leaves the ring). */
export const EVENT_S: Record<RingEventName, number> = { bounceParty: 9, moonJump: 9, beachBall: 14, pinball: 11 };
/** Bounce Party: the ring's top this bouncy, and every grounded, steady fighter hops up `HOP_UP` m/s every `HOP_EVERY` s. */
export const PARTY_BOUNCE = 0.92, HOP_UP = 4, HOP_EVERY = 0.8;
/** Moon Jump: gravity × this. */
export const MOON = 0.4;
/**
 * Beach Ball: a ball `BALL_R` m round, `BALL_MASS` kg, restitution `BALL_BOUNCE`, dropped from `BALL_DROP` m over the
 * middle. Touching a fighting fighter at a closing speed of `BALL_CLOSE` m/s or more it bonks it (a hit of `BALL_POWER`
 * × knock, away from the ball; once per fighter per `BALL_EVERY` s) and is kicked on at `BALL_ON` m/s at least.
 */
export const BALL_R = 1.25, BALL_MASS = 6, BALL_BOUNCE = 0.9, BALL_DROP = 9, BALL_CLOSE = 2, BALL_POWER = 1.6, BALL_EVERY = 1.2, BALL_ON = 5;
/**
 * The ball is dropped drifting `BALL_DRIFT` m/s a random way, and one that has come to rest (under `BALL_REST` m/s for
 * `BALL_REST_S` s) is bounced on again at the nearest fighter at `BALL_ON` m/s, up `BALL_HOP` m/s. (Dropped straight
 * down it bounced on the spot in the middle, where nobody stands, and once it rolled to the bumper it leaned there:
 * 0–2 bonks in a 14 s event on seeds 70–72.)
 */
export const BALL_DRIFT = 1.5, BALL_REST = 1, BALL_REST_S = 1, BALL_HOP = 5;
/**
 * Pinball: `POST_COUNT` posts `POST_RADIUS` m round and `POST_H` m tall, `POST_RING` m out, 120° apart (the first
 * `POST_FIRST` rad round from the entry, so none stands on the walk-in line), rising in `POST_RISE_S` s. A fighter
 * touching a risen post is kicked away at `POST_KICK` m/s (a stagger), once per `POST_EVERY` s.
 */
export const POST_COUNT = 3, POST_RADIUS = 0.45, POST_H = 1.1, POST_RING = 2.3, POST_FIRST = Math.PI / 3, POST_RISE_S = 0.5;
export const POST_KICK = 7.5, POST_EVERY = 0.6;
/** Extra reach (m) when testing a touch on the ball or a post. */
const TOUCH_SLACK = 0.08;
/** A sunk post's top is this far (m) under the ring's top. */
const POST_SUNK = 0.05;
/** The ball has left the ring once its middle is this far (m) past the ring's edge, or this low. */
const BALL_GONE_OUT = BALL_R, BALL_GONE_Y = -2;

type Rng = () => number;
const _a = new Vector3(), _b = new Vector3(), _n = new Vector3();

/**
 * The ring's pads and events. `update` runs once a physics step, before the world steps (pads fire, posts move, the
 * ball bonks, the event clock runs); the loop does not call it while the fight is frozen, so a frozen fight's event
 * waits. `fightTune` is the tuning the fighters read (Moon Jump's gravity), `gravityScale` the world's.
 */
export class RingFeatures {
  readonly pads: readonly Pad[];
  readonly posts: readonly Post[];
  private _ball: { body: RAPIER.RigidBody; radius: number } | null = null;
  private _event: { name: RingEventName; left: number } | null = null;
  /** Seconds of event clock (2+ fighting) until the next event starts. */
  private wait = 0;
  /** The events still to run before any repeats (drawn from the end). */
  private readonly bag: RingEventName[] = [];
  private hopT = 0;
  /** The event started last (a new turn of the bag does not open with it). */
  private last: RingEventName | null = null;
  /** How long (s) the ball has been (nearly) at rest. */
  private restT = 0;
  /** The features' own clock (s of updates), for the once-per-fighter waits. */
  private clock = 0;
  private readonly bonkedAt = new WeakMap<Fighter, number>();
  private readonly kickedAt = new WeakMap<Fighter, number>();
  private readonly postBodies: RAPIER.RigidBody[] = [];
  private readonly moonTune = {} as Tune;
  private readonly world: RAPIER.World;
  private readonly tune: Tune;
  private readonly rng: Rng;
  private readonly floor: RAPIER.Collider | null;

  /** `floor` is the ring top's collider (Bounce Party makes it bouncier); without it Bounce Party only hops. */
  constructor(world: RAPIER.World, tune: Tune, o: { rng: Rng; floor?: RAPIER.Collider | null }) {
    this.world = world;
    this.tune = tune;
    this.rng = o.rng;
    this.floor = o.floor ?? null;
    this.pads = Array.from({ length: PAD_COUNT }, (_, i) => {
      const a = ENTRY_ANGLE + PAD_FIRST + (i * Math.PI * 2) / PAD_COUNT;
      return { at: new Vector3(Math.cos(a) * PAD_RING, 0, Math.sin(a) * PAD_RING), armed: true, charge: 1 };
    });
    this.posts = Array.from({ length: POST_COUNT }, (_, i) => {
      const a = ENTRY_ANGLE + POST_FIRST + (i * Math.PI * 2) / POST_COUNT;
      const at = new Vector3(Math.cos(a) * POST_RING, 0, Math.sin(a) * POST_RING);
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, postY(0), at.z));
      world.createCollider(RAPIER.ColliderDesc.cylinder(POST_H / 2, POST_RADIUS).setFriction(0.3), body);
      this.postBodies.push(body);
      return { at, up: 0 };
    });
    this.wait = this.between(FIRST_MIN, FIRST_MAX);
  }

  /** The beach ball while it is in play. */
  get ball(): { body: RAPIER.RigidBody; radius: number } | null { return this._ball; }
  /** The event under way and its seconds left, or null. */
  get event(): { name: RingEventName; left: number } | null { return this._event; }
  /** × the world's gravity: `MOON` in Moon Jump, else 1. */
  get gravityScale(): number { return this._event?.name === 'moonJump' ? MOON : 1; }

  /** The tuning the fighters' jumps read this step: `base`, or in Moon Jump a copy of it with its gravity × `MOON`. */
  fightTune(base: Tune): Tune {
    const k = this.gravityScale;
    if (k === 1) return base;
    Object.assign(this.moonTune, base);
    this.moonTune.gravity = base.gravity * k;
    return this.moonTune;
  }

  /**
   * While the fight is frozen (an entrance) the ball hangs where it is, and the world pulls in full (the walkers walk
   * in under it, and the fighters are told no Moon Jump: `RingLoop`); unfrozen, Moon Jump's gravity is back.
   */
  hold(frozen: boolean): void {
    const b = this._ball?.body;
    if (b && b.isEnabled() === frozen) b.setEnabled(!frozen);
    const gy = -this.tune.gravity * (frozen ? 1 : this.gravityScale);
    if (this.world.gravity.y !== gy) this.world.gravity = { x: 0, y: gy, z: 0 };
  }

  /**
   * One physics step (before the world steps): pads, posts, ball and the event clock. `fighters` are those fighting
   * (held ones are left be); `canStartEvent` is whether an event may start now (2+ fight, nobody entering).
   */
  update(dt: number, fighters: readonly Fighter[], canStartEvent: boolean): FeatureCue[] {
    const cues: FeatureCue[] = [];
    this.clock += dt;
    if (this.pending.length) cues.push(...this.pending.splice(0));
    this.padsStep(dt, fighters, cues);
    const ev = this._event;
    if (ev) {
      ev.left -= dt;
      if (ev.name === 'bounceParty') this.party(dt, fighters);
      if (ev.name === 'beachBall') this.ballStep(dt, fighters, cues);
      if (ev.left <= 0 || (ev.name === 'beachBall' && !this._ball)) this.end(cues);
    } else if (canStartEvent) {
      this.wait -= dt;
      // never over a special: it waits for the special to be over
      if (this.wait <= 0 && !fighters.some((f) => f.special.active !== null)) this.start(this.draw(), cues);
    }
    this.postsStep(dt, fighters, cues);
    const gy = -this.tune.gravity * this.gravityScale;
    if (this.world.gravity.y !== gy) this.world.gravity = { x: 0, y: gy, z: 0 };
    return cues;
  }

  /** Dev and tests: `name` starts now (any event under way ends first). Its cues go out with the next `update`. */
  startEvent(name: RingEventName): void {
    if (this._event) this.end(this.pending);
    const i = this.bag.indexOf(name);
    if (i >= 0) this.bag.splice(i, 1);
    this.last = name;
    this.start(name, this.pending);
  }

  /** Clear the ring, the crowning, Again!: no event (the next comes 25–35 s into the round), no ball, every pad armed. */
  reset(): void {
    if (this._event) this.undo(this._event.name);
    this._event = null;
    this.pending.length = 0;
    for (const p of this.pads) { p.armed = true; p.charge = 1; }
    this.posts.forEach((p, i) => {
      p.up = 0;
      const b = this.postBodies[i];
      b.setTranslation({ x: p.at.x, y: postY(0), z: p.at.z }, false);
      b.setNextKinematicTranslation({ x: p.at.x, y: postY(0), z: p.at.z });
    });
    this.hopT = 0;
    this.wait = this.between(FIRST_MIN, FIRST_MAX);
    this.world.gravity = { x: 0, y: -this.tune.gravity, z: 0 };
  }

  /** Cues made outside `update` (a dev start), handed out with the next one. */
  private readonly pending: FeatureCue[] = [];

  private between(lo: number, hi: number): number {
    return lo + this.rng() * (hi - lo);
  }

  /** The next event: all four in a shuffled turn, none again until each has run. */
  private draw(): RingEventName {
    if (!this.bag.length) {
      this.bag.push(...RING_EVENTS);
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
      // the new turn never opens with the event that closed the last one
      const n = this.bag.length - 1;
      if (this.bag[n] === this.last) [this.bag[0], this.bag[n]] = [this.bag[n], this.bag[0]];
    }
    return (this.last = this.bag.pop()!);
  }

  private start(name: RingEventName, cues: FeatureCue[]): void {
    this._event = { name, left: EVENT_S[name] };
    if (name === 'bounceParty') {
      this.floor?.setRestitution(PARTY_BOUNCE);
      this.hopT = 0;
    } else if (name === 'beachBall') this.dropBall();
    cues.push({ type: 'event', event: name, phase: 'start' });
  }

  private end(cues: FeatureCue[]): void {
    const ev = this._event;
    if (!ev) return;
    this.undo(ev.name);
    this._event = null;
    this.wait = this.between(GAP_MIN, GAP_MAX);
    cues.push({ type: 'event', event: ev.name, phase: 'end' });
  }

  /** What an event changed goes back (the posts sink on their own, over `POST_RISE_S`). */
  private undo(name: RingEventName): void {
    if (name === 'bounceParty') this.floor?.setRestitution(this.tune.floorBounce);
    if (name === 'beachBall') this.removeBall();
    if (name === 'moonJump') this.world.gravity = { x: 0, y: -this.tune.gravity, z: 0 };
  }

  /** Pads charge back up, and an armed pad under a fighter fires it into a pad jump. */
  private padsStep(dt: number, fighters: readonly Fighter[], cues: FeatureCue[]): void {
    this.pads.forEach((pad, i) => {
      if (!pad.armed) {
        pad.charge = Math.min(1, pad.charge + dt / PAD_REARM_S);
        if (pad.charge >= 1) pad.armed = true;
        return;
      }
      for (const f of fighters) {
        if (f.held || !f.ragdoll.pieces.length) continue;
        const t = f.ragdoll.torso.body.translation();
        if (Math.hypot(t.x - pad.at.x, t.z - pad.at.z) > PAD_REACH || t.y >= f.layout.standHeight * PAD_LOW) continue;
        if (!f.padJump()) continue;
        pad.armed = false;
        pad.charge = 0;
        cues.push({ type: 'pad', pad: i, id: f.id, at: pad.at.clone() });
        break;
      }
    });
  }

  /** Bounce Party's beat: every `HOP_EVERY` s every grounded, steady fighter hops. */
  private party(dt: number, fighters: readonly Fighter[]): void {
    this.hopT += dt;
    if (this.hopT < HOP_EVERY) return;
    this.hopT -= HOP_EVERY;
    for (const f of fighters) f.hop(HOP_UP);
  }

  /** The posts rise in Pinball (and sink after), and a risen post kicks away whoever touches it. */
  private postsStep(dt: number, fighters: readonly Fighter[], cues: FeatureCue[]): void {
    const want = this._event?.name === 'pinball' ? 1 : 0;
    this.posts.forEach((post, i) => {
      if (post.up !== want) {
        post.up = want > post.up ? Math.min(1, post.up + dt / POST_RISE_S) : Math.max(0, post.up - dt / POST_RISE_S);
        this.postBodies[i].setNextKinematicTranslation({ x: post.at.x, y: postY(post.up), z: post.at.z });
      }
      if (post.up < 1) return;
      for (const f of fighters) {
        if (f.held || !f.ragdoll.pieces.length || this.clock - (this.kickedAt.get(f) ?? -Infinity) < POST_EVERY) continue;
        if (!touchesPost(f, post.at)) continue;
        if (!f.bumped(post.at, POST_KICK)) continue;
        this.kickedAt.set(f, this.clock);
        const t = f.ragdoll.torso.body.translation();
        cues.push({ type: 'bump', post: i, id: f.id, at: new Vector3(t.x, t.y, t.z) });
      }
    });
  }

  private dropBall(): void {
    this.removeBall();
    const a = this.rng() * Math.PI * 2;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, BALL_DROP, 0).setAngularDamping(0.3)
      .setLinvel(Math.cos(a) * BALL_DRIFT, 0, Math.sin(a) * BALL_DRIFT));
    this.restT = 0;
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(BALL_R).setMass(BALL_MASS).setRestitution(BALL_BOUNCE)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max).setFriction(0.4),
      body,
    );
    this._ball = { body, radius: BALL_R };
  }

  private removeBall(): void {
    if (!this._ball) return;
    this.world.removeRigidBody(this._ball.body);
    this._ball = null;
  }

  /** A ball at rest for `BALL_REST_S` s is bounced on at the nearest fighter. */
  private nudge(dt: number, body: RAPIER.RigidBody, ctr: Vector3, fighters: readonly Fighter[]): void {
    const v = body.linvel();
    this.restT = Math.hypot(v.x, v.y, v.z) < BALL_REST ? this.restT + dt : 0;
    if (this.restT < BALL_REST_S) return;
    this.restT = 0;
    let best: Fighter | null = null, bd = Infinity;
    for (const f of fighters) {
      if (f.held || !f.ragdoll.pieces.length) continue;
      const t = f.ragdoll.torso.body.translation(), d = Math.hypot(t.x - ctr.x, t.z - ctr.z);
      if (d < bd) { bd = d; best = f; }
    }
    const to = best ? _m.copy(best.ragdoll.pos()).sub(ctr).setY(0) : _m.set(-ctr.x, 0, -ctr.z);
    if (to.lengthSq() < 1e-6) to.set(1, 0, 0);
    to.setLength(BALL_ON);
    body.setLinvel({ x: to.x, y: BALL_HOP, z: to.z }, true);
  }

  /** The ball: gone once it leaves the ring; a fighter it runs into is bonked away and the ball kicked on. */
  private ballStep(dt: number, fighters: readonly Fighter[], cues: FeatureCue[]): void {
    const b = this._ball;
    if (!b) return;
    const c = b.body.translation();
    if (Math.hypot(c.x, c.z) > this.tune.ringRadius + BALL_GONE_OUT || c.y < BALL_GONE_Y) { this.removeBall(); return; }
    const ctr = _a.set(c.x, c.y, c.z);
    this.nudge(dt, b.body, ctr, fighters);
    for (const f of fighters) {
      if (f.held || !f.ragdoll.pieces.length || this.clock - (this.bonkedAt.get(f) ?? -Infinity) < BALL_EVERY) continue;
      if (!nearestOn(f, ctr, BALL_R + TOUCH_SLACK, _b)) continue;
      // closing: how fast the ball and the fighter come together along the line between them
      const n = _n.subVectors(_b, ctr);
      if (n.lengthSq() < 1e-9) n.set(0, 1, 0);
      n.normalize();
      const bv = b.body.linvel(), fv = f.ragdoll.torso.body.linvel();
      const closing = (bv.x - fv.x) * n.x + (bv.y - fv.y) * n.y + (bv.z - fv.z) * n.z;
      if (closing < BALL_CLOSE) continue;
      if (!f.knock(ctr, BALL_POWER * this.tune.knock)) continue;
      this.bonkedAt.set(f, this.clock);
      cues.push({ type: 'ball', id: f.id, at: _b.clone() });
      // kicked on: bounced off the fighter, and never slower than BALL_ON
      const along = bv.x * n.x + bv.y * n.y + bv.z * n.z;
      const v = new Vector3(bv.x, bv.y, bv.z);
      if (along > 0) v.addScaledVector(n, -2 * along);
      if (v.length() < BALL_ON) (v.lengthSq() > 1e-6 ? v : v.copy(n).negate()).setLength(BALL_ON);
      b.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    }
  }
}

/** Scratch for the ball's nudge. */
const _m = new Vector3();

/** A post's middle's height at rise `up` (sunk: its top just under the ring's top). */
const postY = (up: number) => -POST_H / 2 - POST_SUNK + up * (POST_H + POST_SUNK);

/** Whether any piece of `f` touches the risen post standing at `at`. */
function touchesPost(f: Fighter, at: Vector3): boolean {
  for (const p of f.ragdoll.pieces) {
    const t = p.body.translation(), r = p.seg.radius;
    if (t.y - r > POST_H) continue;
    if (Math.hypot(t.x - at.x, t.z - at.z) < POST_RADIUS + r + TOUCH_SLACK) return true;
  }
  return false;
}

/**
 * Whether some piece of `f` comes within `reach` m (plus its own radius) of the point `c`; if so its capsule's
 * nearest point to `c` goes into `out`.
 */
function nearestOn(f: Fighter, c: Vector3, reach: number, out: Vector3): boolean {
  let best = Infinity;
  for (const p of f.ragdoll.pieces) {
    const t = p.body.translation(), q = p.body.rotation();
    const half = Math.hypot(p.seg.b.x - p.seg.a.x, p.seg.b.y - p.seg.a.y, p.seg.b.z - p.seg.a.z) / 2;
    // the capsule's axis (its local +y), turned
    const ax = 2 * (q.x * q.y - q.w * q.z), ay = 1 - 2 * (q.x * q.x + q.z * q.z), az = 2 * (q.y * q.z + q.w * q.x);
    const s = Math.max(-half, Math.min(half, (c.x - t.x) * ax + (c.y - t.y) * ay + (c.z - t.z) * az));
    const px = t.x + ax * s, py = t.y + ay * s, pz = t.z + az * s;
    const gap = Math.hypot(c.x - px, c.y - py, c.z - pz) - p.seg.radius;
    if (gap < best) { best = gap; out.set(px, py, pz); }
  }
  return best < reach;
}
