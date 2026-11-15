import type RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three/webgpu';
import type { RagdollLayout } from '../physics/layout';
import { Ragdoll, type Piece } from '../physics/ragdoll';
import { Brain, PAD_DUEL, type AttackPhase } from './brain';
import { danger } from './danger';
import { Muscles, push } from './muscles';
import { MOVE_POWER, MOVE_TIMING, launchFor, type Tune } from './tune';
import { SPECIAL_FOR, type SpecialCue, type SpecialName, type SpecialState } from './special';
import {
  ARMOR_POWER, ENGAGE, ENGAGE_WAIT_S, METER_LAND, METER_PER_S, METER_TAKEN, SPECIAL_LIFT, nearest, specialFor, type Blow, type SpecialBody,
  type SpecialRun,
} from './specials';
import {
  CHASES_PER_FLIGHT, JUMP_ATTACK, PadJump, THROW_MAX, THROW_OUT, THROW_UP, THROW_WOBBLE, comVel, setComVel, stuntFor, type StuntBody,
  type StuntCue, type StuntName, type StuntOrder, type StuntRun, type StuntTickCtx,
} from './stunts';
import type { FightPlan, Move } from './types';

export type FighterState = 'entering' | 'fighting' | 'out' | 'gone';

/**
 * What one fighter's tick sees: the others in the ring, whether it is strutting alone (or as champion), the tuning, and
 * the ring's spring pads (wild ring §5.1: the brain steers onto an armed one now and then).
 */
export type FightCtx = {
  others: readonly Fighter[]; boast: boolean; tune: Tune; rng: () => number; pads?: readonly { at: Vector3; armed: boolean }[];
  /** × the world's gravity (Moon Jump's 0.4; 1 when absent): the fighters' own jumps fly under it (`Fighter`). */
  gravityScale?: number;
  /** `tune` with its gravity × `gravityScale`: what a jump under it reads. */
  airTune?: Tune;
};

/**
 * How a fighter took its latest hit (design 2026-11-14 §2), by the launch speed it would give: `stagger` (a light hit:
 * pushed back on its feet), `pop` (knocked across the ring, a short tumble, lands on its feet), `big` (a full rag-doll
 * flight; every special's blow). `none` once it is steady again (or a blow its special's armour shrugged off).
 */
export type Reaction = 'none' | 'stagger' | 'pop' | 'big';

/**
 * A landed hit (already applied to the target). `launch` is the knockback velocity it was given (m/s); `reaction` is
 * how the target took it; `special` is set when the hit came from a special attack.
 */
export type Hit = { attacker: Fighter; target: Fighter; at: Vector3; power: number; launch: number; reaction: Reaction; special?: SpecialName };

/** A ball that hurts: a weapon point and its radius. */
type Weapon = { at: Vector3; r: number };

/** Extra slack (m) when testing a weapon against a body (0.15 before big fights: fliers land out of reach more). */
const HIT_SLACK = 0.3;
/** A body lying over the bumper this long (s) is popped off it, outward and up (m/s). */
const BUMPER_WAIT = 3, BUMPER_OUT = 4, BUMPER_UP = 2;
/**
 * A launched fighter stays limp until it is down again: torso back under this x its stand height and not rising, at
 * least `AIR_MIN` s after the launch, at most `AIR_MAX` s.
 */
const AIR_LOW = 1.3, AIR_MIN = 0.2, AIR_MAX = 3;
/**
 * A flier whose torso has hardly moved up or down (under `REST_V` m/s) for `REST_S` s is down too, wherever it came to
 * rest (lying on the bumper's top, on another fighter): it was left "flying" there until `AIR_MAX`, and its foe, who
 * never swings at a flier, stood waiting.
 */
const REST_V = 0.3, REST_S = 0.2;
/** A limp flier falls with this much extra gravity (× `tune.gravity`) once past the top: a floaty rise, a quicker drop. */
const FALL = 0.8;
const DOWN = new Vector3(0, -1, 0);
/** A flier's level speed may be its launch's outward part plus this (m/s). */
const AIR_SLACK = 1;
/** The fastest (m/s) a torso may climb: in a special, hopping (a divebomb) and otherwise (not launched). */
const SPECIAL_UP_MAX = 12, HOP_UP_MAX = 10, STUMBLE_UP_MAX = 5;
/** Tumble on launch: about the torso's spin (rad/s), head over heels, for a 6 m/s pop. */
const TUMBLE = 7;
/** A swing reaches this much lower (m, × size scale) at a foe that is down. */
const DOWN_REACH = 0.5;
/** A normal blow on a fighter in the middle of a special (super armour) pushes this x as hard and does not stun. */
const ARMORED = 0.3;
/** A special starts only from a steady stance: at least this far back to full strength. */
const STEADY = 0.9;
/**
 * The limp guard: a steady fighter (not stunned) whose torso stays under this × its stand height for `LIMP_S` s is
 * stuck lying down; it is stood up where it is, `LIMP_LIFT` m off the floor.
 */
const LIMP_LOW = 0.45, LIMP_S = 2, LIMP_LIFT = 0.05;
/**
 * Graded hit reactions: a launch slower than `STAGGER_L` (m/s) is a stagger: pushed away level at least `STAGGER_MIN`
 * m/s, then `STAGGER_S` s of hit-stun with its muscles at `STAGGER_STR` (it cannot attack), on its feet throughout.
 */
const STAGGER_L = 4.5, STAGGER_MIN = 3, STAGGER_S = 0.25, STAGGER_STR = 0.5;
/** A pop tumbles this × a big hit's spin (it must come round to its feet before it lands). */
const POP_TUMBLE = 0.5;
/** A pop's landing: a squash of this long (s) at this strength. */
const LAND_S = 0.12, LAND_STR = 0.6;
/**
 * The kip-up: a stun ending with the torso under `KIP_LOW` × its stand height hops it up at `KIP_UP` m/s with full
 * muscles; for `KIP_S` s it counts as getting up (the limp guard leaves it be).
 */
const KIP_LOW = 0.6, KIP_UP = 3.5, KIP_S = 0.6;
/**
 * The air chase (design §3): after landing a hit that pops or launches its foe, this chance to leap after the flier
 * (the strike's job is done: it ends there); the chase must start within `CHASE_WAIT` s of the hit.
 */
const CHASE_CHANCE = 0.4, CHASE_WAIT = 0.5;
/** …only after a flier this far (m) farther in than the edge margin (struck again near the edge, it goes out). */
const CHASE_CLEAR = 1;
/**
 * Grab and throw (design §4): a fighter grabs again no sooner than `GRAB_COOL_MIN`–`GRAB_COOL_MAX` s after its last
 * grab ended; a fighter dropped by its thrower (the thrower was hit) falls with a `DROP_STUN` s stun; one let go (thrown
 * or dropped) passes through its thrower's body for `CLEAR_S` s (it starts inside its arms).
 */
const GRAB_COOL_MIN = 10, GRAB_COOL_MAX = 16, DROP_STUN = 0.5, CLEAR_S = 0.3;
/**
 * A ring-out this soon (s) after a throw, with no other blow taken since, came straight from the throw (its flight
 * over the bumper and the fall to where it is ruled out; it is "down" from its flight, by `land`, before that).
 */
const THROWN_OUT_S = 3;
/**
 * The brain sees the spring pads (and walks onto one now and then) only while its fighter's `danger` is under this:
 * the pads lie in the edge zone, and a wobbly fighter walking out there was knocked out. (Tiny, the lightest, won
 * 0.03–0.07 of its bouts with pads seen by every brain, 0.10–0.13 with the pads only firing under whoever walks over
 * them: 70 bouts each, seeds 70 and 72, no events.)
 */
const PAD_SAFE = 0.5;
/** The stunts that are jumps: in Moon Jump they fly under its low gravity (`airTune`). */
const AIR_STUNTS: ReadonlySet<StuntName> = new Set<StuntName>(['leap', 'dodge', 'ropeSpring', 'airChase', 'padJump']);

/**
 * One fighter in the ring: its ragdoll, muscles and brain, how stunned and wobbly it is and how many hits it landed.
 * The fight loop calls `think` for every fighter once per physics step, then steps the world.
 */
export class Fighter {
  readonly ragdoll: Ragdoll;
  private _state: FighterState = 'entering';
  /** Seconds of full ragdoll left. */
  stun = 0;
  /** Hit power taken, healing slowly: knockback grows with it. */
  wobble = 0;
  /** Hits this fighter landed. */
  hits = 0;
  /** Its special attack: the meter filling toward it, and which special is under way (null when none). */
  readonly special: SpecialState = { meter: 0, active: null };
  /** Times the limp guard stood it up (it lay flat, steady, for 2 s). */
  standUps = 0;
  /**
   * Where its latest entrance landed it (ground point) and when (sim s) that entrance handed it back: the fight loop's
   * entrance grace puts it back there once if it falls out untouched just after. Null when there is no grace to give.
   */
  landing: Vector3 | null = null;
  enteredAt = -Infinity;
  /** 0–1: back to full strength after a stun (1 = steady). */
  private recover = 1;
  private readonly muscles: Muscles;
  private readonly brain: Brain<Fighter>;
  private tune: Tune;
  private rng: () => number;
  private started = false;
  private onBumper = 0;
  /** How long (s) it has lain low while steady (the limp guard). */
  private lowFor = 0;
  private readonly reachM: number;
  /** Launched (a pop or a big hit) and not yet down. */
  private airborne = false;
  private airT = 0;
  /** How long (s) a flier's torso has been still up and down (`REST_S`). */
  private restT = 0;
  /** While launched, its flight's level speed is held under this (m/s): the launch's own outward part, plus a little. */
  private airCap = 0;
  /** Its latest launch's pop (m/s). */
  private airUp = 0;
  /** This flight is a pop: once its tumble is over, its muscles come back in the air and it lands on its feet. */
  private popped = false;
  /** Which way it turns in the air after a pop: toward whoever hit it (horizontal unit). */
  private readonly faceTo = new Vector3(0, 0, 1);
  /** How it took its latest hit (`reaction`). */
  private _reaction: Reaction = 'none';
  /** Seconds of a stagger's hit-stun, a pop's landing squash and a kip-up left. */
  private staggerT = 0;
  private squashT = 0;
  private kipT = 0;
  /** Stunned last tick (a stun's end is when it may kip up). */
  private stunned = false;
  /** The pieces its brace lets swing this tick (the attacking limb), reused. */
  private readonly swing = new Set<Piece>();
  /** The special under way. */
  private run: SpecialRun | null = null;
  /** How long (s) the meter has been full. */
  private fullFor = 0;
  /** Special cues not yet collected (`takeCues`). */
  private cues: SpecialCue[] = [];
  /** The stunt under way (`stunt`), its cues not yet collected (`takeStuntCues`), and the stunts' view of this body. */
  private stuntRun: StuntRun | null = null;
  private stuntCues: StuntCue[] = [];
  private readonly stuntRig: StuntBody;
  /** What a stunt's tick sees (reused every tick: `stuntCtx`). */
  private readonly sctx: StuntTickCtx;
  /** An air chase it means to start (it landed a launching hit), on whom and until when (sim s). */
  private chase: { foe: Fighter; until: number } | null = null;
  /** Times an air chase went after it in its current flight (at most `CHASES_PER_FLIGHT`). */
  private chased = 0;
  /** The latest `think`'s time (s). */
  private clock = 0;
  /** Its latest `think` was a strut (alone, or the champion): a pad jump then goes for the middle. */
  private boasting = false;
  /**
   * Moon Jump (design 2026-11-14 §5.1; the ring's `gravityScale`, 0.4): the world pulls at 0.4 g, and this body's own
   * jumps (leap, dodge, rope spring, air chase, pad jump: `AIR_STUNTS`) fly under it, reading `airTune` (its gravity ×
   * 0.4), as high as in full gravity but `1 / carry` (√ 2.5 ≈ 1.6) × as slow; the rest of the time (on its feet, or
   * launched by a blow) its pieces are pulled × 1 / 0.4 = full gravity. Measured on 70 bouts (seed 70) with only Moon
   * Jumps for events, against 13 of 70 bouts with a 3 s stretch without a blow and hit travel 1.21 m with no events:
   * - everything at 0.4 g, launches as they are: three of four fighters out within 0.5 s of a Moon Jump starting;
   * - blows' outward part × 0.4: fliers 2.5 × as high and long, and nobody swings at a flier (12 of 25 stretches of 3 s
   *   without a blow in 40 bouts were in Moon Jumps, up to 7.1 s);
   * - blows × √0.4, or up × 0.4: 20–23 of 70 bouts with such a stretch, travel 1.09–1.10 m: every kick-up, strike
   *   burst and bump floated, the fighters drifted apart (1.77 m from the nearest foe, 1.47 m outside Moon Jumps) and
   *   landed 26% fewer blows;
   * - only the jumps floating (this): 10 of 70, travel 1.16 m. (Only pad jumps and rope springs floating was no
   *   better: 26 against 25 such bouts in 210 with every event, seeds 70–72.)
   */
  private airTune: Tune;
  private moon = 1;
  private carry = 1;
  /** The gravity scale its pieces have now (× the world's). */
  private feels = 1;
  /** Who holds it over their head (grab and throw), or null. */
  private _heldBy: Fighter | null = null;
  /** No grab before this (sim s): its grab's cool-down. */
  private grabAt = 0;
  /** Let go by a thrower: it passes through that thrower's body until `clearUntil` (sim s). */
  private clearOf: Fighter | null = null;
  private clearUntil = 0;
  /** When (sim s) it was last thrown; -Infinity once another blow lands on it. */
  private thrownAt = -Infinity;
  /** Where it was when let go (for a special's `end` cue after its body is gone). */
  private readonly lastPos = new Vector3();
  private readonly rig: SpecialBody;
  /** How far (m) any part of this body can reach from its torso's centre: a cheap first cull for hit checks. */
  private readonly extent: number;
  /** This swing's weapon points, reused every tick (`weaponPoints` fills the first few). */
  private readonly wps: Weapon[];

  /**
   * Builds its own ragdoll from `layout` in `world`, standing at the origin (place it with `ragdoll.pose`). `tune` and
   * `rng` serve `knock` until the first `think`, which takes them from its context from then on.
   */
  constructor(readonly id: string, world: RAPIER.World, readonly layout: RagdollLayout, readonly plan: FightPlan,
    opts: { tune: Tune; rng: () => number }) {
    this.tune = opts.tune;
    this.airTune = opts.tune;
    this.rng = opts.rng;
    this.ragdoll = new Ragdoll(world, layout, { bounce: opts.tune.bounce });
    this.muscles = new Muscles(this.ragdoll, layout);
    this.brain = new Brain<Fighter>(id, this.muscles.weapons.length);
    this.reachM = reachFor(plan.move, this.muscles);
    this.extent = extentOf(this.ragdoll);
    this.wps = Array.from({ length: this.muscles.weapons.length + 1 }, () => ({ at: new Vector3(), r: 0 }));
    const self = this;
    this.rig = {
      id, ragdoll: this.ragdoll, muscles: this.muscles, layout, move: plan.move,
      get tune() { return self.tune; },
      get reach() { return self.reachM; },
      blow: (o, at, power, how) => this.blow(o, at, power, how),
    };
    this.stuntRig = {
      id, ragdoll: this.ragdoll, muscles: this.muscles, layout, move: plan.move,
      // (a jump under way flies under Moon Jump's gravity)
      get tune() { return self.stuntRun && AIR_STUNTS.has(self.stuntRun.name) ? self.airTune : self.tune; },
      get reach() { return self.reachM; },
      hit: (o, at, power, how) => this.stuntHit(o, at, power, how),
      touches: (o, weapons, scale) => this.bodyTouches(o, weapons, scale),
      self: this,
      throwHit: (o, dir, power, maxOut) => this.throwHit(o, dir, power, maxOut),
      get carry() { return self.carry; },
    };
    this.sctx = {
      dt: 0, me: this.stuntRig, foes: [], hits: [],
      cue: (phase, at, other) => {
        if (!this.stuntRun) return;
        const c: StuntCue = { id: this.id, stunt: this.stuntRun.name, phase, at: at.clone() };
        if (other) c.other = other.id;
        this.stuntCues.push(c);
      },
    };
  }

  /**
   * In the ring and fighting, entering, out (fell) or gone (let go). Leaving `fighting` ends a special or a stunt under
   * way; coming in from its entrance, its first act is a leap at the nearest foe.
   */
  get state(): FighterState { return this._state; }
  set state(s: FighterState) {
    const was = this._state;
    this._state = s;
    if (s !== 'fighting') { this.endSpecial(); this.endStunt(); this.chase = null; this.letGoOf(); }
    if (was === 'entering' && s === 'fighting') this.brain.fresh = true;
  }

  /**
   * Its special is called off and its meter emptied (the crowning, "Again!"): a special under way ends (its `end` cue
   * goes as usual), the meter is 0 and the wait for a foe in range starts again.
   */
  resetSpecial(): void {
    this.endSpecial();
    this.special.meter = 0;
    this.fullFor = 0;
  }

  /** Launched by a blow (a pop or a big hit) and not down yet. A stagger is not flying. */
  get flying(): boolean { return this.airborne; }

  /** How it took its latest hit, until it is steady again (`none`). */
  get reaction(): Reaction { return this._reaction; }

  /** The stunt under way (design §3), or null. */
  get stunt(): StuntName | null { return this.stuntRun?.name ?? null; }

  /** Times an air chase has gone after it in its current flight. */
  get airChased(): number { return this.chased; }

  /**
   * Who holds it over their head (grab and throw, design §4), or null. A held fighter does not think, cannot be hit and
   * is not ruled out (the fight loop and the sim skip it); its thrower places its body every step.
   */
  get heldBy(): Fighter | null { return this._heldBy; }
  /** Held over someone's head (`heldBy`): for the brains, which leave it be. */
  get held(): boolean { return this._heldBy !== null; }
  /** Holding someone (grabbing, carrying or throwing them). */
  get holding(): boolean { return this.stuntRun?.name === 'grab'; }
  /** Thrown just now (within `THROWN_OUT_S`, nothing else landed on it since): a ring-out now came straight from a throw. */
  get thrown(): boolean { return this.clock - this.thrownAt <= THROWN_OUT_S; }

  /**
   * Whether it can be grabbed now: fighting, on its feet (not flying, stunned or lying about), not in a special, not
   * held or holding anyone.
   */
  get grabbable(): boolean {
    if (this._state !== 'fighting' || !this.ragdoll.pieces.length || this._heldBy || this.holding || this.stuntRun?.name === 'throw') return false;
    if (this.airborne || this.stun > 0 || this.run) return false;
    return this.muscles.grounded(this.tune.ringRadius) && this.ragdoll.pos().y > this.layout.standHeight * KIP_LOW;
  }

  /**
   * Taken hold of by `by` (its grab starts): whatever it was doing is over — special, stunt, attack, a chase it meant —
   * and its body no longer collides with anything (it is placed over the thrower's head every step).
   */
  takeHold(by: Fighter): void {
    this.endSpecial();
    this.endStunt();
    this.chase = null;
    if (this.brain.atk.phase !== 'none') this.brain.interrupt();
    this._heldBy = by;
    this.clearOf = null;
    this.ragdoll.collide('none');
  }

  /** Dropped by its thrower (the thrower was hit): it falls from where it is, a short stun. */
  dropped(): void {
    const by = this._heldBy;
    if (!by) return;
    this.release(by);
    this.stun = Math.max(this.stun, DROP_STUN);
    this.recover = 0;
  }

  /**
   * Any hold it is in ends (the crowning, "Again!"): a held fighter is dropped, a thrower drops whoever it holds. (A
   * throw already under way flies on.)
   */
  endHold(): void {
    if (this._heldBy) this._heldBy.endHold();
    if (this.holding) this.endStunt();
  }

  /** Let go by its thrower `by`: it collides again, except with `by` for a moment. */
  private release(by: Fighter): void {
    this._heldBy = null;
    if (!this.ragdoll.pieces.length) return;
    this.clearOf = by;
    this.clearUntil = by.clock + CLEAR_S;
    this.clock = by.clock;
    this.ragdoll.collide(by.ragdoll.pieces.length ? 'notWith' : 'all', by.ragdoll);
  }

  /** It leaves the fight while held: the hold is over (its thrower's grab sees it and ends), and it collides again. */
  private letGoOf(): void {
    if (!this._heldBy) return;
    this._heldBy = null;
    this.clearOf = null;
    if (this.ragdoll.pieces.length) this.ragdoll.collide('all');
  }

  /** The stunt cues since the last call (the loop collects them every step, as it does the special cues). */
  takeStuntCues(): StuntCue[] {
    if (!this.stuntCues.length) return [];
    const out = this.stuntCues;
    this.stuntCues = [];
    return out;
  }

  /**
   * Whether a stunt may start now: fighting with a body, up on its feet and steady (not stunned, flying, staggered,
   * squashed by a landing or kipping up), no special and no other stunt under way (holding someone is one), not winding
   * up or striking, not held.
   */
  mayStunt(): boolean {
    if (this._state !== 'fighting' || !this.ragdoll.pieces.length || this._heldBy) return false;
    // steady: its latest hit's stun, stagger, landing squash and kip-up all over, back at full strength
    if (this.stuntRun || this.run || !this.steady()) return false;
    const ph = this.brain.atk.phase;
    if (ph === 'windup' || ph === 'strike') return false;
    // on its feet: not lying about (a fighter floored kips up first)
    return this.muscles.grounded(this.tune.ringRadius) && this.ragdoll.pos().y > this.layout.standHeight * KIP_LOW;
  }

  /** Starts a stunt now when it may (`mayStunt`); true when it started. The brain's orders come through here too. */
  tryStunt(o: StuntOrder): boolean {
    if (!this.mayStunt()) return false;
    if (o.name === 'airChase' || o.name === 'ropeSpring' || o.name === 'dodge' || o.name === 'grab') {
      const foe = o.name === 'dodge' ? o.from : o.foe;
      if (foe === this || foe.state !== 'fighting' || !foe.ragdoll.pieces.length || foe.held) return false;
      if (o.name === 'airChase' && (!foe.flying || foe.chased >= CHASES_PER_FLIGHT)) return false;
      if (o.name === 'grab' && (!foe.grabbable || this.clock < this.grabAt)) return false;
    }
    const run = stuntFor(o, this.ragdoll.pos(), this.tune.ringRadius - this.tune.edgeMargin);
    this.stuntRun = run;
    if (o.name === 'airChase') o.foe.chased++;
    if (o.name === 'grab') o.foe.takeHold(this);
    this.chase = null;
    this.feel();
    run.begin(this.stuntCtx(0, [], []));
    return true;
  }

  /**
   * A spring pad fires under it (wild ring §5.1): a pad jump at its target (else the ring's middle), whatever stunt or
   * that was. Not while held, holding or throwing someone, in a special, launched or stunned, already pad jumping,
   * winding up or striking (a blow under way is not thrown away: the pad waits), nor in a duel: its target within
   * `PAD_DUEL` × the longer reach of the two (either can hit the other: it fights on the pad). True when it jumped.
   * Measured with pads and no events (70 bouts): firing mid-blow, 13 bouts (seed 70) with a 3 s stretch without a blow,
   * 8 with no pads; firing mid-duel too, 18–19 pad jumps a bout and hit travel 1.14 m (seed 72; 1.20 with no pads);
   * waiting in a duel, 8.3–8.5 a bout, travel 1.18 m (seed 72) and 1.28 m (seed 70). The longer reach of the two (Task
   * 8): by its own reach alone, tiny's 0.63 m (× 1.3) almost never held the pad, which fired it out of its fights; it
   * won 0.10 of its bouts with pads, 0.16 with none and 0.16 with pads that never fired under tiny (140 bouts each,
   * seeds 101–102), 0.18–0.19 with this rule (PAD_DUEL 1.3 → 1, which kept pad jumps at 6.2–6.7 a bout: 3.4 at 1.3).
   */
  padJump(): boolean {
    if (this._state !== 'fighting' || !this.ragdoll.pieces.length || this._heldBy || this.run || this.airborne || this.stun > 0) return false;
    const now = this.stuntRun?.name, ph = this.brain.atk.phase;
    if (now === 'grab' || now === 'throw' || now === 'padJump' || ph === 'windup' || ph === 'strike') return false;
    const tg = this.boasting ? null : this.brain.target;
    const foe = tg && tg !== this && tg.state === 'fighting' && !tg.held && tg.ragdoll.pieces.length ? tg : null;
    // in a duel (its target in reach) the pad waits: it fights on it
    if (foe && level2(foe.ragdoll.pos(), this.ragdoll.pos()) < Math.max(this.reachM, foe.reachM) * PAD_DUEL) return false;
    this.endStunt();
    this.chase = null;
    const run = new PadJump(foe);
    this.stuntRun = run;
    this.feel();
    run.begin(this.stuntCtx(0, [], []));
    return true;
  }

  /** Bounce Party (wild ring §5.1): a hop straight up at `up` m/s, when it is grounded and steady (`mayStunt`). True when it hopped. */
  hop(up: number): boolean {
    if (!this.mayStunt()) return false;
    const v = comVel(this.ragdoll, _hop);
    setComVel(this.ragdoll, v.x, Math.max(v.y, up), v.z);
    return true;
  }

  /**
   * Kicked away from the point `from` (a pinball post) at `speed` m/s, level: a stagger (no wobble, no meter, a moment's
   * hit-stun), any stunt but a hold or a throw over. Not while held, in a special or launched. True when kicked. (It is
   * no blow from a foe: its attack goes on, and the brain's clock of blows, which makes it eager to swing, is not
   * reset.)
   */
  bumped(from: { x: number; z: number }, speed: number): boolean {
    if (this._state !== 'fighting' || !this.ragdoll.pieces.length || this._heldBy || this.run || this.airborne) return false;
    const now = this.stuntRun?.name;
    if (now && now !== 'grab' && now !== 'throw') this.endStunt();
    const p = this.ragdoll.pos();
    const d = _hop.set(p.x - from.x, 0, p.z - from.z);
    if (d.lengthSq() < 1e-6) d.set(p.x, 0, p.z);
    if (d.lengthSq() < 1e-6) d.set(1, 0, 0);
    d.normalize();
    setComVel(this.ragdoll, d.x * speed, null, d.z * speed);
    this.thrownAt = -Infinity;
    this._reaction = 'stagger';
    this.staggerT = STAGGER_S;
    return true;
  }

  /** The special cues since the last call (the loop collects them every step). */
  takeCues(): SpecialCue[] {
    if (!this.cues.length) return [];
    const out = this.cues;
    this.cues = [];
    return out;
  }

  get move(): Move { return this.plan.move; }
  /** Where the current attack is: wind-up, strike window, cool-down or none. */
  get attack(): AttackPhase { return this.brain.atk.phase; }

  /** How close (m, torso to torso) it gets before starting its move: the spike's reach, scaled to its size. */
  get reach(): number { return this.reachM; }

  /** Start the signature move where it stands, with no hit checks: an entrance showing what it can do. */
  showOff(): void {
    this.brain.face.copy(this.muscles.facing());
    this.brain.startAttack(this.brain.face, this.rng, true);
  }

  /** One physics tick of brain and muscles. Returns the hits it landed (each already knocked into its target). */
  think(dt: number, t: number, ctx: FightCtx): Hit[] {
    this.tune = ctx.tune;
    this.rng = ctx.rng;
    if (this.state === 'entering') {
      if (this.brain.atk.phase !== 'none') this.showTick(dt);
      return [];
    }
    if (this.state !== 'fighting') return [];
    if (!this.started) { this.started = true; this.brain.breath(t); } // a breath before the first strut
    this.clock = t;
    this.boasting = ctx.boast;
    this.airTune = ctx.airTune ?? ctx.tune;
    this.moon = ctx.gravityScale ?? 1;
    this.carry = Math.sqrt(this.moon);
    this.feel();
    // held over a thrower's head: it does nothing at all (its thrower places it)
    if (this._heldBy) return [];
    if (this.clearOf && t >= this.clearUntil) {
      this.clearOf = null;
      if (this.ragdoll.pieces.length) this.ragdoll.collide('all');
    }

    const tune = ctx.tune, R = tune.ringRadius, m = this.muscles;
    this.wobble = Math.max(0, this.wobble - dt * tune.heal);
    // a stunned fighter does no stunt (the crowning holds the losers limp, mid-leap or not)
    if (this.stuntRun && this.stun > 0) this.endStunt();
    const str = this.strength(dt);
    this.limpGuard(dt);

    this.noCatapult();
    // (a held fighter is nobody's foe: it cannot be hit)
    const live = ctx.others.filter((o) => o !== this && o.state === 'fighting' && !o._heldBy);
    const foes = ctx.boast ? [] : live;
    // a stunned fighter (a big blow, or held limp for the crowning) has no special: it ends, and none starts (`ready`)
    if (this.run && this.stun > 0) this.endSpecial();
    if (this.run) {
      const hits = this.specialTick(dt, foes);
      this.bumperRule(dt, R);
      return hits;
    }
    if (foes.length) this.fill(dt * METER_PER_S);
    if (this.ready(dt, str, foes, ctx.others, R)) {
      this.beginSpecial();
      return [];
    }
    if (this.stuntRun) return this.stuntTick(dt, foes, R);
    if (this.stunts(t, live, foes, ctx)) return [];
    if (this.airborne) {
      // launched: limp (a big flight, a pop's tumble), then after a pop braced and upright in the air, turned to face
      // whoever hit it, so it lands on its feet. No steering, no flapping; the attack clock runs on.
      m.offFeet();
      if (str > 0) {
        m.stand(dt, str, this.faceTo, tune.gravity);
        m.brace(dt, str, null, tune);
      }
      this.brain.tick(dt, str, MOVE_TIMING[this.move]);
      this.bumperRule(dt, R);
      return [];
    }
    const { want, face } = this.brain.steer(this.ragdoll.pos(), t, live, ctx.boast, this.reach, R, tune.edgeMargin, ctx.rng,
      ctx.pads && danger(this.wobble, this.ragdoll.mass, tune) < PAD_SAFE ? ctx.pads : undefined);
    const grounded = m.grounded(R);
    // a pop's landing skids on (no steering through the squash)
    if (grounded && str > 0) m.hover(dt, str, this.squashT > 0 ? null : want, tune.gravity);
    m.stand(dt, str, face, tune.gravity);
    m.waddle(dt, str, this.brain.face, grounded);
    m.flapSave(dt, R, ctx.rng, tune.gravity);
    m.brace(dt, str, this.swinging(), tune);

    const hits = this.attackTick(dt, str, foes);
    this.fill(METER_LAND * hits.length);
    this.bumperRule(dt, R);
    return hits;
  }

  /**
   * Whether its special starts now: meter full, nobody else's special under way (one at a time in the ring, however long
   * it has waited), steady on its feet, between attacks or winding one up (a full meter beats a normal blow: with
   * quick landings a fighter is often back in a wind-up the moment it is steady), a foe in range (or waited long enough).
   */
  private ready(dt: number, str: number, foes: readonly Fighter[], ring: readonly Fighter[], R: number): boolean {
    if (this.special.meter < 1) { this.fullFor = 0; return false; }
    this.fullFor += dt;
    if (ring.some((o) => o !== this && o.special.active !== null)) return false;
    if (!foes.length || this.stun > 0 || this.airborne || this.stuntRun || str < STEADY * STEADY) return false;
    const phase = this.brain.atk.phase;
    if (phase !== 'none' && (phase !== 'windup' || this.brain.atk.harmless)) return false;
    if (!this.muscles.grounded(R)) return false;
    const range = ENGAGE[SPECIAL_FOR[this.move]];
    if (range === null || this.fullFor >= ENGAGE_WAIT_S) return true;
    const o = nearest(this.ragdoll.pos(), foes);
    return !!o && !o.flying && o.ragdoll.pos().distanceTo(this.ragdoll.pos()) < range * this.muscles.k + this.reach * 0.3;
  }

  private fill(by: number): void {
    if (!this.run && by > 0) this.special.meter = Math.min(1, this.special.meter + by);
  }

  /** The meter is spent: the wind-up starts. */
  private beginSpecial(): void {
    this.run = specialFor(this.move);
    if (this.brain.atk.phase !== 'none') this.brain.interrupt(); // a normal wind-up gives way
    this.special.meter = 0;
    this.special.active = this.run.name;
    this.fullFor = 0;
    this.cue('charge', this.ragdoll.pos());
  }

  /** One tick of the special under way; it ends (with its `end` cue) when its script is over. */
  private specialTick(dt: number, foes: readonly Fighter[]): Hit[] {
    const run = this.run!, hits: Hit[] = [];
    const over = run.tick({ dt, me: this.rig, foes, hits, cue: (phase, at, radius) => this.cue(phase, at, radius) });
    this.hits += hits.length;
    if (hits.length) this.brain.blow(this.clock);
    if (over) this.endSpecial();
    return hits;
  }

  /** Ends the special under way (if any): `end` is sent, the meter starts again from empty and the brain takes over. */
  private endSpecial(): void {
    if (!this.run) return;
    const name = this.run.name;
    this.run = null;
    this.special.active = null;
    this.special.meter = 0;
    this.fullFor = 0;
    const at = this.ragdoll.pieces.length ? this.ragdoll.pos() : this.lastPos.clone();
    this.cues.push({ id: this.cueId(), special: name, phase: 'end', at });
    if (this.brain.atk.phase !== 'none') this.brain.interrupt();
  }

  /** A cue names its fighter (the show finds the fighter by it). */
  private cueId(): string { return this.id; }

  private cue(phase: SpecialCue['phase'], at: Vector3, radius?: number): void {
    if (!this.run) return;
    const c: SpecialCue = { id: this.cueId(), special: this.run.name, phase, at: at.clone() };
    if (radius !== undefined) c.radius = radius;
    this.cues.push(c);
  }

  /**
   * Its stunts this tick: an air chase it is due (it just launched someone), else whatever its brain picks. True when
   * one started (the body was set moving: nothing else drives it this tick).
   */
  private stunts(t: number, live: readonly Fighter[], foes: readonly Fighter[], ctx: FightCtx): boolean {
    // a full meter is saved for its special (it starts as soon as it may): no stunt takes it out of range first
    const free = this.mayStunt() && this.special.meter < 1;
    const ch = this.chase;
    if (ch) {
      if (t > ch.until || !ch.foe.flying || ch.foe.state !== 'fighting' || ch.foe.chased >= CHASES_PER_FLIGHT) this.chase = null;
      else if (free && this.tryStunt({ name: 'airChase', foe: ch.foe })) return true;
    }
    const tune = ctx.tune;
    const pick = this.brain.pickStunt(this.ragdoll.pos(), t, live, ctx.boast || !foes.length,
      { reach: this.reach, ringHeight: this.layout.ringHeight, grab: t >= this.grabAt }, tune.ringRadius, tune.edgeMargin, ctx.rng, free);
    return !!pick && this.tryStunt(pick);
  }

  /** One tick of the stunt under way: it drives the body; the attack only cools down. It ends (with `end`) when over. */
  private stuntTick(dt: number, foes: readonly Fighter[], R: number): Hit[] {
    const run = this.stuntRun!, hits: Hit[] = [];
    this.brain.tick(dt, 1, MOVE_TIMING[this.move]);
    const over = run.tick(this.stuntCtx(dt, foes, hits));
    if (over && run.next) {
      // a grab runs straight on into its throw
      this.endStunt();
      if (this._state === 'fighting') {
        this.stuntRun = run.next;
        this.feel();
        run.next.begin(this.stuntCtx(dt, foes, hits));
      }
    } else if (over) {
      const foe = run.attackOn;
      this.endStunt();
      // a jump attack: landed in reach, it strikes at once, harder
      if (foe) {
        this.brain.target = foe;
        const d = foe.ragdoll.pos().sub(this.ragdoll.pos()).setY(0);
        this.brain.startAttack(d.lengthSq() > 1e-6 ? d : this.muscles.facing(), this.rng, false);
        this.brain.atk.power = JUMP_ATTACK;
      }
    }
    this.bumperRule(dt, R);
    return hits;
  }

  /** What a stunt's tick sees: its body, its foes, where its hits go, and its cues (named for this fighter). */
  private stuntCtx(dt: number, foes: readonly Fighter[], hits: Hit[]): StuntTickCtx {
    const c = this.sctx;
    c.dt = dt;
    c.foes = foes;
    c.hits = hits;
    return c;
  }

  /**
   * Ends the stunt under way (if any): `end` is sent and the brain takes over (the next stunt waits a moment). Cut short,
   * it lets go of whatever it holds (a grab drops its foe). A grab's end starts its cool-down.
   */
  private endStunt(): void {
    const run = this.stuntRun;
    if (!run) return;
    this.stuntRun = null;
    if (!run.done) run.cut(this.stuntRig);
    if (run.name === 'grab') this.grabAt = this.clock + GRAB_COOL_MIN + this.rng() * (GRAB_COOL_MAX - GRAB_COOL_MIN);
    const at = this.ragdoll.pieces.length ? this.ragdoll.pos() : this.lastPos.clone();
    const c: StuntCue = { id: this.id, stunt: run.name, phase: 'end', at };
    if (run.foe) c.other = run.foe.id;
    this.stuntCues.push(c);
    this.brain.stuntOver(this.clock);
    this.feel();
  }

  /**
   * How hard the world's gravity pulls its pieces: × 1 / `moon` (full gravity) in Moon Jump unless it is jumping (an
   * `AIR_STUNTS` stunt), else × 1.
   */
  private feel(): void {
    const jumping = !!this.stuntRun && AIR_STUNTS.has(this.stuntRun.name);
    const k = this.moon < 1 && !jumping ? 1 / this.moon : 1;
    if (k === this.feels || !this.ragdoll.pieces.length) return;
    this.feels = k;
    for (const p of this.ragdoll.pieces) p.body.setGravityScale(k, true);
  }

  /** A stunt's blow on `o` (a rope spring's body, an air chase): a normal hit, applied now, counted as this fighter's. */
  private stuntHit(o: Fighter, at: Vector3, power: number, how: { up?: number; out?: number }): Hit | null {
    if (o === this || o.state !== 'fighting' || !o.ragdoll.pieces.length) return null;
    const { launch, reaction } = o.takeHit(this.ragdoll.pos(), power, how);
    this.hits++;
    this.brain.blow(this.clock);
    this.fill(METER_LAND);
    const h: Hit = { attacker: this, target: o, at: at.clone(), power, launch, reaction };
    this.launched(h);
    return h;
  }

  /**
   * Its throw of `o` (held by it) along `dir`: `o` flies, a hit of `power` counted as this fighter's (its meter fills,
   * `o`'s wobble grows).
   */
  private throwHit(o: Fighter, dir: Vector3, power: number, maxOut = Infinity): Hit | null {
    if (o._heldBy !== this || !o.ragdoll.pieces.length) return null;
    const { launch, reaction } = o.thrownBy(this, dir, power, maxOut);
    this.hits++;
    this.brain.blow(this.clock);
    this.fill(METER_LAND);
    return { attacker: this, target: o, at: o.ragdoll.pos(), power, launch, reaction };
  }

  /**
   * Thrown by `by` along `dir` (design §4): a big reaction, out `THROW_OUT` + `THROW_WOBBLE` × its wobble m/s (at most
   * `THROW_MAX`), up `THROW_UP`, tumbling; the throw counts as a hit of `power` (its wobble grows, its meter fills).
   */
  private thrownBy(by: Fighter, dir: Vector3, power: number, maxOut: number): { launch: number; reaction: Reaction } {
    const out = Math.min(THROW_MAX, maxOut, THROW_OUT + THROW_WOBBLE * this.wobble), up = THROW_UP;
    this.release(by);
    this.brain.blow(this.clock);
    this.wobble += power;
    this.fill(METER_TAKEN);
    for (const p of this.ragdoll.pieces) p.body.setLinvel({ x: dir.x * out, y: up, z: dir.z * out }, true);
    this.tumble(dir, out, up, 1);
    this.stun = Math.max(this.stun, this.tune.flop * (0.45 + power * 0.18));
    this.recover = 0;
    this.popped = false;
    this._reaction = 'big';
    this.staggerT = 0;
    this.squashT = 0;
    this.kipT = 0;
    this.faceTo.copy(dir).negate();
    this.airborne = true;
    this.airT = 0;
    this.restT = 0;
    this.chased = 0;
    this.airCap = out + AIR_SLACK;
    this.airUp = up;
    this.thrownAt = this.clock;
    return { launch: Math.hypot(out, up), reaction: 'big' };
  }

  /**
   * After a hit it landed: when it popped or launched its foe (still clear of the edge), a chance to chase it into the
   * air (`CHASE_CHANCE`, at most `CHASES_PER_FLIGHT` chases per flight). True when it will.
   */
  private launched(h: Hit): boolean {
    const o = h.target;
    if ((h.reaction !== 'pop' && h.reaction !== 'big') || this.chase || o.chased >= CHASES_PER_FLIGHT) return false;
    // a flier already near the edge is let go: chased and struck again there it would only be knocked out
    const q = o.ragdoll.pos();
    if (Math.hypot(q.x, q.z) > this.tune.ringRadius - this.tune.edgeMargin - CHASE_CLEAR) return false;
    if (this.rng() >= CHASE_CHANCE) return false;
    this.chase = { foe: o, until: this.clock + CHASE_WAIT };
    return true;
  }

  /** Whether this body touches `o`: torso and head (and with `weapons` its weapons' points), each radius × `scale`. */
  private bodyTouches(o: Fighter, weapons: boolean, scale: number): boolean {
    let n = 0;
    const t = this.ragdoll.torso, h = this.ragdoll.head;
    this.setWp(n++, t, false, t.seg.radius * scale);
    if (h) this.setWp(n++, h, false, h.seg.radius * scale);
    if (weapons) for (const w of this.muscles.weapons) if (w !== t && w !== h && n < this.wps.length) this.setWp(n++, w, true, w.seg.radius * scale);
    for (let i = 0; i < n; i++) if (touches(o, this.wps[i], 0)) return true;
    return false;
  }

  /** A special's blow on `o`: applied now, counted as this fighter's hit. */
  private blow(o: Fighter, at: Vector3, power: number, how: Blow): Hit | null {
    if (o === this || o.state !== 'fighting' || !o.ragdoll.pieces.length || !this.run) return null;
    const name = this.run.name;
    const { launch, reaction } = o.takeHit(how.from, power, { out: how.out, up: how.up * SPECIAL_LIFT, special: true });
    return { attacker: this, target: o, at: at.clone(), power, launch, reaction, special: name };
  }

  /**
   * Knocked by a normal hit from `from` (the attacker's torso): wobblier, and staggered, popped or sent flying. Returns
   * the launch speed and what the blow did (null with no body).
   */
  knock(from: Vector3, power: number): { launch: number; reaction: Reaction } | null {
    if (!this.ragdoll.pieces.length) return null;
    return this.takeHit(from, power, {});
  }

  dispose(): void {
    if (this.ragdoll.pieces.length) this.lastPos.copy(this.ragdoll.pos());
    this.endSpecial();
    this.endStunt();
    this.ragdoll.dispose();
    this.state = 'gone';
  }

  /**
   * Muscle strength this tick: 0 while stunned (full ragdoll) or on a big flight (limp until down), then a quadratic
   * scramble back over `recoverS`, or at once when the stun ends in a pop's flight (air recovery) or on the floor (a
   * kip-up). Held at `STAGGER_STR` through a stagger and `LAND_STR` through a pop's landing squash.
   */
  private strength(dt: number): number {
    if (this.airborne) {
      this.airT += dt;
      const p = this.ragdoll.pos(), vy = this.ragdoll.vel().y;
      this.restT = Math.abs(vy) < REST_V ? this.restT + dt : 0;
      const down = this.airT >= AIR_MIN && ((p.y < this.layout.standHeight * AIR_LOW && vy < 1) || this.restT >= REST_S);
      if (down || this.airT >= AIR_MAX) this.land();
      else {
        if (!this.popped) this.stun = Math.max(this.stun, dt * 1.01);
        this.capFlight();
        // cartoon fall: a floaty rise, a quicker drop (limp fliers only: a pop back in control drifts down onto its
        // feet, which gives it the time to come upright and carries it across the ring)
        if (vy < 0 && this.stun > 0) push(this.ragdoll.torso, DOWN, this.ragdoll.mass * this.tune.gravity * FALL * dt);
      }
    }
    if (this.stun > 0) {
      this.stun -= dt;
      this.recover = 0;
      this.stunned = true;
    } else {
      if (this.stunned) this.stunOver();
      this.recover = Math.min(1, this.recover + dt / this.tune.recoverS);
    }
    let s = this.stun > 0 ? 0 : this.recover * this.recover;
    if (this.staggerT > 0) { this.staggerT -= dt; s = Math.min(s, STAGGER_STR); }
    if (this.squashT > 0) { this.squashT -= dt; s = Math.min(s, LAND_STR); }
    if (this.kipT > 0) this.kipT -= dt;
    if (this._reaction !== 'none' && this.steady()) this._reaction = 'none';
    return s;
  }

  /** Back on its feet and at full strength: nothing left of its latest hit. */
  private steady(): boolean {
    return !this.airborne && this.stun <= 0 && this.staggerT <= 0 && this.squashT <= 0 && this.kipT <= 0 && this.recover >= 1;
  }

  /** Down from a flight: a pop lands on its feet with a squash. */
  private land(): void {
    this.airborne = false;
    this.chased = 0;
    if (!this.popped) return;
    this.popped = false;
    if (this.stun <= 0) this.squashT = LAND_S;
  }

  /**
   * A stun is over: in a pop's flight its muscles come back at once (air recovery); lying on the floor it kips up, a
   * quick hop to its feet with full muscles; otherwise it scrambles up over `recoverS`.
   */
  private stunOver(): void {
    this.stunned = false;
    if (this.airborne) { this.recover = 1; return; }
    if (!this.ragdoll.pieces.length || this.ragdoll.pos().y >= this.layout.standHeight * KIP_LOW) return;
    if (!this.muscles.grounded(this.tune.ringRadius)) return;
    this.recover = 1;
    this.kipT = KIP_S;
    for (const p of this.ragdoll.pieces) {
      const v = p.body.linvel();
      p.body.setLinvel({ x: v.x, y: Math.max(v.y, KIP_UP), z: v.z }, true);
    }
  }

  /** The pieces its brace lets swing this tick: the limb (or for a kick or spin every weapon's limb) of an attack under way. */
  private swinging(): ReadonlySet<Piece> | null {
    const a = this.brain.atk;
    if (a.phase !== 'windup' && a.phase !== 'strike') return null;
    const s = this.swing, limbs = this.muscles.weaponLimbs;
    s.clear();
    if (this.move === 'kick' || this.move === 'spin') for (const l of limbs) for (const p of l) s.add(p);
    else for (const p of limbs[a.side % limbs.length]) s.add(p);
    return s;
  }

  /**
   * Nobody is left lying limp: a fighter that is not stunned yet whose torso has stayed under `LIMP_LOW` × its stand
   * height for `LIMP_S` s (its muscles could not get it up) is stood up where it is, facing the way it last meant to,
   * `LIMP_LIFT` m off the floor. Logged and counted (`standUps`).
   */
  private limpGuard(dt: number): void {
    const p = this.ragdoll.pos();
    // a fighter kipping up is getting up on its own; one in a stunt is leaping, landing or dashing on purpose; a held
    // fighter lies flat over its thrower's head on purpose (it does not think either: this is a second guard)
    if (this.stun > 0 || this.kipT > 0 || this.stuntRun || this._heldBy || p.y >= this.layout.standHeight * LIMP_LOW) { this.lowFor = 0; return; }
    this.lowFor += dt;
    if (this.lowFor < LIMP_S - 1e-9) return;
    this.lowFor = 0;
    const y = p.y;
    const face = this.brain.face.x ** 2 + this.brain.face.z ** 2 > 1e-6 ? this.brain.face : this.muscles.facing();
    this.ragdoll.pose(p.setY(0), Math.atan2(face.x, face.z), LIMP_LIFT);
    this.standUps++;
    console.warn('stand up', { id: this.id, y, standUps: this.standUps });
  }

  /**
   * A heavy body landing hard on its light feet can be flung back up by the physics (the solver pushing the feet out
   * of the floor): faster than anything sent it. Its climb is trimmed to what it may have: a launch's pop, its own
   * hop or special, else a stumble.
   */
  private noCatapult(): void {
    const vy = this.ragdoll.vel().y;
    const cap = this.run || this.stuntRun ? SPECIAL_UP_MAX : this.airborne ? this.airUp + 1
      : this.move === 'divebomb' && this.brain.atk.phase === 'strike' ? HOP_UP_MAX : STUMBLE_UP_MAX;
    if (vy <= cap) return;
    const dv = vy - cap;
    for (const p of this.ragdoll.pieces) {
      const v = p.body.linvel();
      p.body.setLinvel({ x: v.x, y: v.y - dv, z: v.z }, true);
    }
  }

  /**
   * A flier goes as far as its launch sends it, not as far as a body slam or a tangle of limbs flings it: its level
   * speed (the whole body's) is trimmed to `airCap`, so how far it flies still grows with wobble.
   */
  private capFlight(): void {
    let mx = 0, mz = 0, m = 0;
    for (const p of this.ragdoll.pieces) {
      const v = p.body.linvel();
      mx += v.x * p.mass; mz += v.z * p.mass; m += p.mass;
    }
    const vx = mx / m, vz = mz / m, sp = Math.hypot(vx, vz);
    if (sp <= this.airCap) return;
    const k = 1 - this.airCap / sp, dx = -vx * k, dz = -vz * k;
    for (const p of this.ragdoll.pieces) {
      const v = p.body.linvel();
      p.body.setLinvel({ x: v.x + dx, y: v.y, z: v.z + dz }, true);
    }
  }

  /** Entering, showing off: stand in place and play the move. */
  private showTick(dt: number): void {
    const m = this.muscles;
    if (m.grounded(this.tune.ringRadius)) m.hover(dt, 1, new Vector3(), this.tune.gravity);
    m.stand(dt, 1, this.brain.face, this.tune.gravity);
    m.brace(dt, 1, this.swinging(), this.tune);
    this.attackTick(dt, 1, []);
  }

  /** The attack's wind-up, strike burst and hit checks against `targets`. */
  private attackTick(dt: number, str: number, targets: readonly Fighter[]): Hit[] {
    const a = this.brain.atk, m = this.muscles, move = this.move;
    const w = m.weapons[a.side % m.weapons.length];
    const step = this.brain.tick(dt, str, MOVE_TIMING[move]);
    if (step.windup) m.windup(dt, move, a.dir, w);
    if (step.burst) m.strike(move, a.dir, w, this.tune.gravity);
    const hits: Hit[] = [];
    if (!step.strike) return hits;
    if (move === 'spin') m.spin(dt);
    if (a.harmless) return hits;
    const n = this.weaponPoints(w);
    // a jump attack hits harder (`atk.power`). (src/fight/danger.ts, the dizzy stars, measures danger by a normal
    // punch's power: a jump attack's extra is not counted there.)
    const power = MOVE_POWER[move] * this.tune.knock * a.power;
    for (const o of targets) {
      if (a.hit.has(o)) continue;
      // a foe that is down (knocked flat, scrambling up) is hit by a swing passing just over it: whacked off the floor
      const down = o.stun > 0 || o.recover < 1 ? DOWN_REACH * m.k : 0;
      const t = o.ragdoll.torso.body.translation();
      for (let i = 0; i < n; i++) {
        const wp = this.wps[i];
        // cheap cull: out of reach of any part of it
        const cull = o.extent + wp.r + HIT_SLACK + down;
        if ((wp.at.x - t.x) ** 2 + (wp.at.y - t.y) ** 2 + (wp.at.z - t.z) ** 2 > cull * cull) continue;
        if (!touches(o, wp, down)) continue;
        a.hit.add(o);
        // (the jump attack's extra does not break a special's super armour: its move's own power is weighed)
        const { launch, reaction } = o.takeHit(this.ragdoll.pos(), power, { armour: power / a.power });
        this.hits++;
        this.brain.blow(this.clock);
        const h: Hit = { attacker: this, target: o, at: wp.at.clone(), power, launch, reaction };
        hits.push(h);
        // off after the flier: the strike's job is done
        if (this.launched(h)) { this.brain.interrupt(); return hits; }
        break;
      }
    }
    return hits;
  }

  /**
   * Where the move hurts (the spike's weapons, taken from the plan's weapon pieces), into `wps`; returns how many. `w` is
   * this swing's weapon.
   */
  private weaponPoints(w: Piece): number {
    const ws = this.muscles.weapons, torso = this.ragdoll.torso, k = this.muscles.k;
    switch (this.move) {
      case 'punch': case 'jab': this.setWp(0, w, true, w.seg.radius); return 1;
      case 'kick': for (let i = 0; i < ws.length; i++) this.setWp(i, ws[i], true, ws[i].seg.radius * 1.6); return ws.length;
      case 'bump':
        for (let i = 0; i < ws.length; i++) {
          this.setWp(i, ws[i], false, ws[i].seg.radius * 0.75);
          this.wps[i].at.addScaledVector(this.brain.atk.dir, ws[i].seg.radius * 0.6);
        }
        return ws.length;
      case 'headbutt': for (let i = 0; i < ws.length; i++) this.setWp(i, ws[i], false, ws[i].seg.radius * 1.1); return ws.length;
      case 'divebomb':
        for (let i = 0; i < ws.length; i++) this.setWp(i, ws[i], false, ws[i].seg.radius * 1.1);
        this.setWp(ws.length, torso, false, torso.seg.radius);
        return ws.length + 1;
      case 'spin': for (let i = 0; i < ws.length; i++) this.setWp(i, ws[i], true, 0.3 * k); return ws.length;
    }
  }

  /** Weapon point `i`: piece `p`'s tip (or centre), `r` m round. */
  private setWp(i: number, p: Piece, tip: boolean, r: number): void {
    const wp = this.wps[i];
    if (tip) tipInto(p, wp.at);
    else centreInto(p, wp.at);
    wp.r = r;
  }

  /**
   * Knocked by a blow from `from`: wobblier, and launched away by `launchFor` (its outward part growing with wobble).
   * How it takes the blow goes by the launch's speed L (`reaction`): under `STAGGER_L` it staggers (pushed away level,
   * a moment's hit-stun, on its feet); under `tune.bigLaunch` it pops (launched, limp for `tune.tumbleS`, then braced in
   * the air and down on its feet); faster, or any special's blow, is big (tumbling, stunned and limp until it is down
   * again). Returns the launch speed (m/s) given and what this blow did (a light blow on a fighter already flying is a
   * `stagger`, while its `reaction` stays its flight's). In the middle of its own special a fighter shrugs off a weak
   * normal blow (pushed a little, not stunned: `none`); a strong one (`how.armour`, the power weighed against the armour:
   * a jump attack's extra does not count) or a special cancels it.
   */
  private takeHit(from: Vector3, power: number, how: { out?: number; up?: number; special?: boolean; armour?: number }): { launch: number; reaction: Reaction } {
    this.brain.blow(this.clock);
    this.thrownAt = -Infinity;
    const rng = this.rng, M = this.ragdoll.mass;
    const d = this.ragdoll.pos().sub(from).setY(0);
    if (d.lengthSq() < 1e-4) d.set(rng() - 0.5, 0, rng() - 0.5);
    d.normalize();
    this.wobble += power;
    const armored = !!this.run && !how.special && (how.armour ?? power) < ARMOR_POWER * this.tune.knock;
    if (!armored) this.endSpecial();
    this.fill(METER_TAKEN);
    const { out, up } = launchFor(power, this.wobble, M, this.tune, how);
    const L = Math.hypot(out, up);
    if (armored) {
      const lift = Math.max(0, up * ARMORED - Math.max(0, this.ragdoll.vel().y));
      push(this.ragdoll.torso, d.clone().multiplyScalar(out * ARMORED).add(new Vector3(0, lift, 0)), M);
      return { launch: L * ARMORED, reaction: 'none' };
    }
    this.brain.interrupt();
    if (!how.special && L < STAGGER_L) {
      // a stagger: pushed back on its feet (the whole body slides, nothing tips it over)
      const sp = Math.max(out, STAGGER_MIN);
      for (const p of this.ragdoll.pieces) push(p, d, p.mass * sp);
      if (!this.airborne) { this._reaction = 'stagger'; this.staggerT = STAGGER_S; }
      return { launch: sp, reaction: 'stagger' };
    }
    const pop = !how.special && L < this.tune.bigLaunch;
    // launched: a stunt under way is over, and so is any chase it meant to start
    this.endStunt();
    this.chase = null;
    if (!this.airborne) this.chased = 0;
    // the pop lifts it to `up` m/s, not on top of a flight already under way (no juggling to the rafters)
    const lift = Math.max(0, up - Math.max(0, this.ragdoll.vel().y));
    const kick = d.clone().multiplyScalar(out).setY(lift);
    // a pop throws the whole body as one (it flies true and can right itself); a big blow hits the torso and the
    // limbs trail and flail
    if (pop) for (const p of this.ragdoll.pieces) push(p, kick, p.mass);
    else push(this.ragdoll.torso, kick, M);
    this.tumble(d, out, up, pop ? POP_TUMBLE : 1);
    // never shorter than a stun it already has (a crowning holds the losers limp for good)
    this.stun = Math.max(this.stun, pop ? this.tune.tumbleS : this.tune.flop * (0.45 + power * 0.18));
    this.recover = 0;
    // a pop in the middle of a big flight does not cut the flight short: it stays big
    this.popped = pop && (!this.airborne || this.popped);
    this._reaction = this.popped ? 'pop' : 'big';
    this.staggerT = 0;
    this.squashT = 0;
    this.kipT = 0;
    this.faceTo.copy(d).negate();
    if (!this.airborne) this.airCap = 0;
    this.airborne = true;
    this.airT = 0;
    this.restT = 0;
    this.airCap = Math.max(this.airCap, out + AIR_SLACK);
    this.airUp = Math.max(up, this.ragdoll.vel().y);
    return { launch: L, reaction: this._reaction };
  }

  /** A launch's spin: a random tumble and a roll head over heels away from the blow (`d`, level unit), × `tumble`. */
  private tumble(d: Vector3, out: number, up: number, tumble: number): void {
    const rng = this.rng, M = this.ragdoll.mass;
    const spin = M * 0.4 * (out / 0.85) * this.tune.spin * tumble;
    this.ragdoll.torso.body.applyTorqueImpulse({ x: (rng() - 0.5) * spin, y: (rng() - 0.5) * spin, z: (rng() - 0.5) * spin }, true);
    const torso = this.ragdoll.torso, r = torso.seg.radius;
    const flip = new Vector3(d.z, 0, -d.x).multiplyScalar(TUMBLE * (up / 6) * 0.8 * M * r * r * tumble);
    torso.body.applyTorqueImpulse({ x: flip.x, y: 0, z: flip.z }, true);
  }

  /** Nobody rests on the bumper: a torso over it (past the ring's edge, not yet falling) for 3 s is popped off. */
  private bumperRule(dt: number, R: number): void {
    const p = this.ragdoll.pos(), flat = new Vector3(p.x, 0, p.z);
    this.onBumper = flat.length() > R && p.y > -0.5 ? this.onBumper + dt : 0;
    if (this.onBumper <= BUMPER_WAIT) return;
    this.onBumper = 0;
    push(this.ragdoll.torso, flat.normalize().multiplyScalar(BUMPER_OUT).add(new Vector3(0, BUMPER_UP, 0)), this.ragdoll.mass);
  }
}

/** The spike's reach per move, from the body's own size: torso radius, limb length and ringHeight / 1.4. */
function reachFor(move: Move, m: Muscles): number {
  const k = m.k, torsoR = m.body.torso.seg.radius;
  const limb = Math.max(...m.weapons.map((w) => m.limbLength(w)));
  switch (move) {
    case 'punch': return torsoR + limb + 0.9 * k;
    case 'jab': return 1.1 * k;
    case 'kick': return limb + torsoR + 0.6 * k;
    case 'bump': return Math.max(...m.weapons.map((w) => w.seg.radius)) + 1.6 * k;
    case 'headbutt': return 3.2 * k;
    case 'spin': return 1.9 * k;
    case 'divebomb': return 2.6 * k;
  }
}

/** Scratch for the hit checks (they allocate nothing of their own per tick). */
const _q = new Quaternion(), _ax = new Vector3(), _d = new Vector3(), _low = new Vector3(), _hop = new Vector3();

const level2 = (a: Vector3, b: Vector3) => Math.hypot(a.x - b.x, a.z - b.z);
/** Half a piece's capsule length (m). */
const halfLength = (p: Piece) => Math.hypot(p.seg.b.x - p.seg.a.x, p.seg.b.y - p.seg.a.y, p.seg.b.z - p.seg.a.z) / 2;

/** A piece's centre, into `out`. */
function centreInto(p: Piece, out: Vector3): Vector3 {
  const t = p.body.translation();
  return out.set(t.x, t.y, t.z);
}

/** A piece's capsule axis (unit, its local +y) in the world, into `out`. */
function axisInto(p: Piece, out: Vector3): Vector3 {
  const r = p.body.rotation();
  return out.set(0, 1, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
}

/** The far end (`b`) of a piece's capsule, into `out`. */
function tipInto(p: Piece, out: Vector3): Vector3 {
  const h = halfLength(p);
  axisInto(p, _ax);
  return centreInto(p, out).addScaledVector(_ax, h);
}

/** Distance from `x` to a piece's capsule axis (its segment from end to end). */
function distToPiece(x: Vector3, p: Piece): number {
  const h = halfLength(p);
  axisInto(p, _ax);
  centreInto(p, _d);
  _d.subVectors(x, _d);
  const s = Math.max(-h, Math.min(h, _d.dot(_ax)));
  return _d.addScaledVector(_ax, -s).length();
}

/** Whether weapon `wp` touches any part of `o` (also `down` m lower, for a foe that is down). */
function touches(o: Fighter, wp: Weapon, down: number): boolean {
  if (down) _low.copy(wp.at).setY(wp.at.y - down);
  for (const p of o.ragdoll.pieces) {
    const r = p.seg.radius + wp.r + HIT_SLACK;
    if (distToPiece(wp.at, p) < r || (down && distToPiece(_low, p) < r)) return true;
  }
  return false;
}

/**
 * How far (m) any part of a ragdoll can be from its torso's centre, however its joints turn: each piece's farthest
 * point is at most its joint's farthest reach plus its own length and radius.
 */
function extentOf(rag: Ragdoll): number {
  const torso = rag.torso, joint: number[] = [];
  let most = halfLength(torso) + torso.seg.radius;
  for (const p of rag.pieces) {
    if (p === torso) continue;
    const parent = rag.pieces[p.seg.parent];
    const a = p.seg.anchor, c = torso.restP;
    const j = parent === torso ? Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z) : joint[p.seg.parent] + 2 * halfLength(parent);
    joint[p.seg.id] = j;
    most = Math.max(most, j + 2 * halfLength(p) + p.seg.radius);
  }
  return most + 0.05;
}
