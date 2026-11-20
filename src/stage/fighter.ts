import type { SpecialName } from '../fight/special';
import { attackSet, type Attack, type AttackDir } from './attacks';
import type { BodyStats } from './body';
import { knockback, STAGE_TUNE, type StageTune } from './damage';
import { GRAB_ACTIVE, GRAB_MISS, GRAB_WINDUP, HOLD_MAX, LIFT_STEPS, THROW_STEPS, type GrabCue } from './grab';
import {
  GROW, GROW_EASE, grownStats, NOODLE, noodleSet, PIE, pieThrow, SHIELD_HITS, TIMED_ITEMS, ZOOM, zoomStats, type ItemCue,
  type ItemName,
} from './items';
import { KID_POWER, kidMoves, kidShare } from './kid-power';
import { solidAt, type Level, type Platform } from './level';
import { makeMover, stepMover, type MoveEvent, type MoveInput, type MoveStats, type Mover } from './move';
import {
  METER_LAND, METER_PER_S, METER_TAKEN, specialAfterMove, specialKit, specialMove, SpecialRun, specialStrike,
  type SpecialKit, type StageSpecialCue,
} from './specials';
import { DT, NO_INTENT, type Intent, type V2 } from './types';

/**
 * What a fighter is doing. Free to act: idle, run, air (jumping or falling) and land (a short squash; anything may
 * start during it). Busy: attack, hitstun (a short stagger), tumble (a clean spin after a big launch), dodge, special
 * (its body's big move), grab (reaching out, then holding someone overhead), throw, held (carried by a holder: it
 * cannot act). Out: past the level's bounds. Frozen: held still by the sim's entrance freeze (`setFrozen`).
 */
export type Action = 'idle' | 'run' | 'air' | 'land' | 'attack' | 'hitstun' | 'tumble' | 'dodge' | 'special' | 'grab'
  | 'held' | 'throw' | 'frozen' | 'out';

/** A hit that landed, for the show: who hit whom where, how hard, how fast the launch, whether it tumbles. */
export type StageHit = { attacker: string; target: string; at: V2; power: number; launch: number; tumble: boolean;
  special?: SpecialName };

/**
 * A hit circle live this step and the blow it lands: an attack's or a special's (`special` names it). An `around` blow
 * pushes away from its fighter's body; a `ground` one only hits fighters standing on something (a slam's shockwave).
 */
export type Strike = {
  x: number; y: number; r: number; power: number; damage: number; angle: number; around: boolean; ground: boolean;
  special: SpecialName | null;
};

/** Stick share (−1…1) past which the fighter runs and turns. */
const STICK_MOVE = 0.2;
/** Stick share past which up or down counts (attack direction, drop through, fast fall). */
const STICK_TILT = 0.5;
const DEG = Math.PI / 180;
/** What the crowning stops (`calm`): everything busy but a launch or a stagger, which run their course. */
const CALMED: ReadonlySet<Action> = new Set<Action>(['attack', 'special', 'grab', 'throw', 'held', 'dodge']);

/**
 * One creature on the stage: a moving box (`mover`) plus what it is doing. `act` turns this step's wanting into
 * movement and actions; the sim (Task 4) asks `attackArea()` who is hit and calls `takeHit` on them, and sets the
 * attacker's `freeze` too. Damage is hidden; the more there is, the further a hit launches. `actionT` counts the steps
 * since the action began, `actionLen` its length in steps for a timed action (0 for idle, run and air). Hit freeze:
 * while `freeze` > 0 a step only counts it down — no timers, no movement.
 */
export class StageFighter {
  readonly id: string;
  /**
   * How its body fights and moves now: `body`, or a power-up's version of it (Grow Juice, Zoom Sneakers), a different
   * object swapped in and back, never one changed in place (the brains' route graphs are cached by its `moves`: R27).
   */
  stats: BodyStats;
  /** Its own body, as built. */
  readonly body: BodyStats;
  readonly mover: Mover;
  readonly tune: StageTune;
  damage = 0;
  facing: 1 | -1 = 1;
  action: Action = 'air';
  actionT = 0;
  actionLen = 0;
  /** The special meter, 0…1: fills from hits landed and taken and from time; full, `special` lets the special go. */
  meter = 0;
  /**
   * Kid power (`KID_POWER`): a child is steering it with a controller (and the pad is not resting). Set by the app
   * before every step, like the controller's wanting; off unless the app says so, so the computer's own bouts never
   * see it.
   */
  kid = false;
  freeze = 0;
  /** While `frozen`, the action it was in (it carries on with it when the freeze ends; poses can hold it). */
  frozenFrom: Action = 'air';
  /** The attack under way and its direction (null when not attacking). */
  attack: Attack | null = null;
  attackDir: AttackDir | null = null;
  /** Who the attack under way has already hit (the sim adds to it; a new attack starts it empty), so it hits each once. */
  readonly attackHits = new Set<string>();
  /** What the movement did this step (jump, air jump, recovery leap, land, drop). */
  readonly events: MoveEvent[] = [];
  /** This body's special, worked out once. */
  readonly kit: SpecialKit;
  /** Who it holds overhead (grab, throw), and who holds it (held); the sim links them and carries the held one. */
  holding: StageFighter | null = null;
  heldBy: StageFighter | null = null;
  /** The way the throw under way goes: forward (its facing, which it turned to) or up. */
  throwDir: 'forward' | 'up' = 'forward';
  /**
   * Its special and grab moments not yet passed on (the sim takes them at the end of each step; a moment between steps,
   * such as a let-go when someone leaves the stage, goes with the next step).
   */
  readonly specialCues: StageSpecialCue[] = [];
  readonly grabCues: GrabCue[] = [];
  readonly itemCues: ItemCue[] = [];
  /**
   * Its power-up (one at a time; null: none), when a timed one runs out (level time, s), and what is left of one that
   * counts (the noodle's swings, the shield's hits). `grown`: Grow Juice has grown its box (it waits for room overhead).
   * `pieThrown`: a custard pie left its hand this step (the sim sends it flying).
   */
  item: ItemName | null = null;
  itemUntil = 0;
  itemUses = 0;
  grown = false;
  pieThrown = false;

  /** Its movement with no steering and no friction: a launch or a roll keeps its own speed. */
  private coast: MoveStats;
  /** The look's size easing from `sizeFrom` to `sizeTo` over GROW_EASE steps, `sizeT` steps in (display). */
  private sizeFrom = 1;
  private sizeTo = 1;
  private sizeT = GROW_EASE;
  /** Last step's wanting, so held buttons count as one press. */
  private readonly last: Intent = { ...NO_INTENT };
  /** Whether the attack under way started in the air (it ends on landing). */
  private attackInAir = false;
  /** Roll direction of the dodge under way (0 = in place). */
  private dodgeDir: -1 | 0 | 1 = 0;
  /** Steps until the next dodge may start. */
  private dodgeWait = 0;
  private readonly input: MoveInput = { mx: 0, jump: false, down: false, recover: false };
  private readonly area = { x: 0, y: 0, r: 0 };
  private readonly strikeOut: Strike = { x: 0, y: 0, r: 0, power: 0, damage: 0, angle: 0, around: false, ground: false, special: null };
  /** The special under way (reused; live only while the action is `special`). */
  private readonly run = new SpecialRun();

  /** A fighter whose box stands on `at` (bottom centre); it starts in the air, with its air jumps. */
  constructor(id: string, stats: BodyStats, at: V2, tune: StageTune = STAGE_TUNE) {
    this.id = id;
    this.stats = this.body = stats;
    this.tune = tune;
    this.mover = makeMover(at, stats.w, stats.h);
    this.mover.airJumpsLeft = stats.moves.airJumps;
    this.coast = { ...stats.moves, accel: 0, airAccel: 0 };
    this.kit = specialKit(stats);
  }

  /**
   * The entrance freeze: on, the fighter holds exactly as it is (action `frozen`; nothing moves, no timer runs, it
   * cannot be hit); off, it carries on with what it was doing as if no time had passed. An out fighter stays out.
   */
  setFrozen(on: boolean): void {
    if (on) {
      if (this.action === 'frozen' || this.action === 'out') return;
      this.frozenFrom = this.action;
      this.action = 'frozen';
    } else if (this.action === 'frozen') this.action = this.frozenFrom;
  }

  /** Whether the fighter may start something new (move, jump, attack, dodge). */
  isFree(): boolean {
    const a = this.action;
    return a === 'idle' || a === 'run' || a === 'air' || a === 'land';
  }

  /** Whether a hit would land: not out or frozen, and not in a dodge's no-hit window. */
  canBeHit(): boolean {
    if (this.action === 'out' || this.action === 'frozen') return false;
    return !(this.action === 'dodge' && this.actionT >= this.tune.dodgeSafeFrom && this.actionT < this.tune.dodgeSafeTo);
  }

  /**
   * One step of wanting at level time `t`: timed actions run on, a free fighter turns, attacks or dodges on a fresh
   * press, then the box moves (a launched or staggered fighter is not steered; its launch fades by light air drag),
   * and landing or crossing the bounds changes the action. Jump, attack and dodge count on the step they are pressed;
   * a fresh press of down drops through a thin platform, held down fast-falls in the air.
   */
  act(intent: Intent, level: Level, t: number): void {
    this.events.length = 0;
    if (this.action === 'out' || this.action === 'frozen') return;
    if (this.sizeT < GROW_EASE) this.sizeT++;
    if (this.freeze > 0) {
      this.freeze--;
      return;
    }
    const tune = this.tune, m = this.mover, last = this.last;
    const jumpPressed = intent.jump && !last.jump;
    const attackPressed = intent.attack && !last.attack;
    const dodgePressed = intent.dodge && !last.dodge;
    const specialPressed = intent.special && !last.special;
    const grabPressed = intent.grab && !last.grab;
    const itemPressed = intent.item && !last.item;
    const downHeld = intent.my < -STICK_TILT;
    const downPressed = downHeld && !(last.my < -STICK_TILT);
    Object.assign(last, intent);
    if (this.dodgeWait > 0) this.dodgeWait--;

    if (this.action === 'held') {
      // Carried: nothing it wants counts and its box does not move (the sim carries it). A held one whose holder no
      // longer holds it (never expected) drops.
      if (this.heldBy?.holding === this) {
        if (this.outside(level)) this.begin('out', 0);
        return;
      }
      this.drop();
    }

    this.actionT++;
    if (this.action === 'grab' && this.holding && this.actionT >= this.actionLen) this.startThrow('forward', this.facing);
    else if (this.actionLen > 0 && this.actionT >= this.actionLen) this.becomeFree();
    if (this.action !== 'special') this.meter = Math.min(1, this.meter + METER_PER_S * DT * this.meterShare());
    // the custard pie leaves the hand at the top of the throw
    if (this.action === 'attack' && this.item === 'custardPie' && this.attack === pieThrow(this.stats) && this.actionT === PIE.windup) {
      this.item = null;
      this.pieThrown = true;
    }

    const grounded = m.ground !== null;
    if (this.isFree()) {
      if (Math.abs(intent.mx) > STICK_MOVE) this.facing = intent.mx > 0 ? 1 : -1;
      if (dodgePressed && this.dodgeWait === 0) this.startDodge(intent.mx, grounded);
      else if (specialPressed && this.meter >= 1) this.startSpecial();
      else if (grabPressed && grounded) this.startGrab();
      else if (itemPressed && this.item === 'custardPie') this.startPieThrow(grounded);
      else if (attackPressed || (itemPressed && this.item === 'poolNoodle')) this.startAttack(intent.my, grounded);
    } else if (this.action === 'grab' && this.holding && this.actionT >= LIFT_STEPS && (attackPressed || grabPressed)) {
      const side = Math.abs(intent.mx) > STICK_MOVE ? (intent.mx > 0 ? 1 : -1) : this.facing;
      this.startThrow(intent.my > STICK_TILT ? 'up' : 'forward', side);
    } else if (this.action === 'special' && this.actionT === this.kit.charge) this.specialCue('release');

    const inp = this.input;
    inp.mx = 0;
    inp.jump = inp.down = inp.recover = false;
    // (a kid's recovery leap is stronger: its own MoveStats object, never this body's changed)
    let stats = this.kid ? kidMoves(this.stats.moves) : this.stats.moves;
    switch (this.action) {
      case 'idle': case 'run': case 'air': case 'land':
        inp.mx = intent.mx;
        if (jumpPressed) {
          // With the air jumps spent, jump is the recovery leap.
          if (grounded || m.airJumpsLeft > 0) inp.jump = true;
          else inp.recover = true;
        }
        inp.down = grounded ? downPressed : downHeld;
        break;
      case 'attack':
        // On the ground an attack plants the feet; in the air the fighter drifts and may fast-fall.
        if (!grounded) {
          inp.mx = intent.mx;
          inp.down = downHeld;
        }
        break;
      case 'hitstun': case 'tumble':
        if (!grounded) {
          stats = this.coast;
          m.vel.x *= 1 - tune.airDrag * DT;
        }
        break;
      case 'dodge':
        if (grounded && this.dodgeDir !== 0 && this.actionT < tune.dodgeSafeTo) {
          stats = this.coast;
          m.vel.x = this.dodgeDir * tune.dodgeRoll;
        }
        break;
      case 'special':
        if (specialMove(this, this.kit, this.run, level, t)) stats = this.coast;
        break;
      default:
        // a grab and a throw plant the feet
        break;
    }

    stepMover(m, inp, stats, level, t, DT, this.events);

    const onGround = m.ground !== null;
    switch (this.action) {
      case 'idle': case 'run': {
        const now = !onGround ? 'air' : Math.abs(intent.mx) > STICK_MOVE ? 'run' : 'idle';
        if (now !== this.action) this.begin(now, 0);
        break;
      }
      case 'air':
        if (onGround) this.begin('land', Math.max(1, tune.landSteps));
        break;
      case 'land':
        if (!onGround) this.begin('air', 0);
        break;
      case 'attack':
        if (onGround && this.attackInAir) this.begin('land', Math.max(1, tune.landSteps));
        break;
      case 'tumble':
        if (onGround) {
          // A thud, not a long slide.
          m.vel.x *= tune.tumbleLandKeep;
          this.begin('land', Math.max(1, tune.landSteps));
        }
        break;
      case 'special':
        if (specialAfterMove(this, this.kit, this.run)) this.specialImpact(m.pos);
        break;
      default:
        break;
    }

    if (this.outside(level)) this.begin('out', 0);
  }

  /**
   * The hit circle live this step and its blow, the attack's or the special's, else null (the same object every call;
   * copy to keep). The sim takes everyone's before any hit lands.
   */
  strike(): Strike | null {
    if (this.action === 'special') {
      const k = specialStrike(this, this.kit, this.run, this.strikeOut);
      if (k) k.power *= this.powerShare();
      return k;
    }
    const area = this.attackArea(), a = this.attack;
    if (!area || !a) return null;
    const s = this.strikeOut;
    s.x = area.x;
    s.y = area.y;
    s.r = area.r;
    s.power = a.power * this.powerShare();
    s.damage = a.damage;
    s.angle = a.angle;
    s.around = a.around;
    s.ground = false;
    s.special = null;
    return s;
  }

  /**
   * Called by the sim when this fighter's strike (or throw) landed at `at`: an attack or a throw fills the meter; a
   * special's first blow sends its `impact`.
   */
  landed(special: SpecialName | null, at: V2): void {
    if (special) this.specialImpact(at);
    else this.meter = Math.min(1, this.meter + METER_LAND * this.meterShare());
  }

  /** The attack's hit circle in the world while it is active, else null (the same object every call; copy to keep). */
  attackArea(): { x: number; y: number; r: number } | null {
    const a = this.attack;
    if (this.action !== 'attack' || !a || this.actionT < a.windup || this.actionT >= a.windup + a.active) return null;
    const p = this.mover.pos;
    this.area.x = p.x + this.facing * a.area.dx;
    this.area.y = p.y + a.area.dy;
    this.area.r = a.area.r;
    return this.area;
  }

  /**
   * Which way the attack under way pushes a target whose box is centred at `x`: along the facing, or away from the
   * body for an attack all around it. The sim passes it to `takeHit` as `from`.
   */
  pushToward(x: number): 1 | -1 {
    if (!this.attack?.around || x === this.mover.pos.x) return this.facing;
    return x > this.mover.pos.x ? 1 : -1;
  }

  /**
   * Takes a hit pushing toward `from` (the attacker's push direction) at `angle` degrees from it: the damage adds,
   * then the launch speed is worked out from the total and set on the box. A slow launch staggers, a fast one tumbles;
   * either way the fighter turns to face the attacker, freezes for the hit freeze, and gets its air jumps and recovery
   * leap back (a launch starts a fresh trip through the air). A fighter standing on the ground hit flat or downward pops
   * up instead. In a special, a blow slower than the tune's `specialArmour` only rocks it (the damage adds, it freezes,
   * the special goes on). A held (or thrown) one always tumbles, however slow the launch. A hit fills the meter (not in
   * a special) and lets go of a hold either way round. In a dodge's no-hit window, or out, nothing happens and it
   * returns 0; a Bubble Shield stops the hit (no damage, no launch) and it returns 0 too; else it returns the launch
   * speed. Kid power (`byKid`: the blow came from a kid-powered creature; mischief and the computer leave it off)
   * scales the blow's power and damage (`kidShare`).
   */
  takeHit(h: { power: number; damage: number; angle: number; from: 1 | -1; byKid?: boolean }): number {
    if (!this.canBeHit() || this.shieldBlocks()) return 0;
    const tune = this.tune, m = this.mover, k = kidShare(h.byKid ?? false, this.kid);
    this.damage += h.damage * k.damage;
    const launch = knockback(h.power * k.power, this.damage, this.stats.weight, tune);
    if (this.action === 'special') {
      if (launch < tune.specialArmour) {
        this.freeze = tune.hitFreeze;
        return launch;
      }
    } else this.meter = Math.min(1, this.meter + METER_TAKEN * this.meterShare());
    let vx = Math.cos(h.angle * DEG), vy = Math.sin(h.angle * DEG);
    if (m.ground !== null) {
      const lift = Math.sin(tune.groundLift * DEG);
      if (vy < lift) {
        vy = Math.max(Math.abs(vy), lift);
        vx = (vx >= 0 ? 1 : -1) * Math.sqrt(1 - vy * vy);
      }
    }
    m.vel.x = h.from * vx * launch;
    m.vel.y = vy * launch;
    if (m.vel.y > 0) m.ground = null;
    m.airJumpsLeft = this.stats.moves.airJumps;
    m.recoveryUsed = false;
    this.facing = h.from === 1 ? -1 : 1;
    // a held one hit or thrown always tumbles: lying flat overhead, it flies off as one clean spin, never snapping
    // upright into a stagger
    const tumble = launch >= tune.tumbleFrom || this.action === 'held';
    // (at least a step, so no tune can leave an untimed stagger)
    this.begin(tumble ? 'tumble' : 'hitstun', Math.max(1, Math.round(tumble
      ? tune.tumbleBase + tune.tumblePerSpeed * launch
      : tune.hitstunBase + tune.hitstunPerSpeed * launch)));
    this.freeze = tune.hitFreeze;
    return launch;
  }

  /** Whether the fighter is out: already marked out, or its box's bottom centre is past one of the level's bounds. */
  isOut(level: Level): boolean {
    return this.action === 'out' || this.outside(level);
  }

  private outside(level: Level): boolean {
    const b = level.bounds, p = this.mover.pos;
    return p.x < b.left || p.x > b.right || p.y < b.bottom || p.y > b.top;
  }

  /**
   * Starts `action` lasting `len` steps (0 = until something changes it); any attack under way stops, a special under
   * way ends, and a hold lets go unless the action carries it on (a holder's grab and throw, the held one's held).
   */
  private begin(action: Action, len: number): void {
    const was = this.action;
    this.action = action;
    this.actionT = 0;
    this.actionLen = len;
    this.attack = null;
    this.attackDir = null;
    this.tidy(was, action);
  }

  /** What leaving `was` for `now` ends: the special (its `end`), and a hold neither side can carry on. */
  private tidy(was: Action, now: Action): void {
    if (was === 'special' && now !== 'special') this.specialCue('end');
    if (this.holding && now !== 'grab' && now !== 'throw') this.letGo();
    if (this.heldBy && now !== 'held') this.heldBy.letGo();
  }

  /**
   * Taken off the stage: whatever it was doing ends cleanly (a special sends its `end`, a hold either way round lets
   * go), so nobody is left stuck. Its own cues stay for the sim to pass on.
   */
  leave(): void {
    this.tidy(this.action === 'frozen' ? this.frozenFrom : this.action, 'out');
    if (this.item) this.endItem();
    this.pieThrown = false;
  }

  /**
   * The crowning (Task 15): it stops what it was doing, cleanly. An attack, a special (its `end`), a grab or a throw,
   * being held (both let go) or a dodge ends, standing or in the air as it is; its power-up ends. A launch (tumble) or
   * a stagger runs its course: it lands by itself. In the entrance freeze it stays frozen, calm when the freeze ends.
   */
  calm(): void {
    const frozen = this.action === 'frozen';
    if (frozen) this.setFrozen(false);
    if (CALMED.has(this.action)) this.begin(this.mover.ground !== null ? 'idle' : 'air', 0);
    if (this.item) this.endItem();
    this.pieThrown = false;
    if (frozen) this.setFrozen(true);
  }

  // ---- power-ups ----

  /**
   * Gives it power-up `name` at level time `t` (opening a present at `at`; default its middle), with an `open` cue: an
   * Ice Pop cools it at once (damage 0; it keeps any power-up it has), anything else ends the power-up it has first.
   * Zoom Sneakers swap in their movement (and an extra air jump now); Grow Juice grows once there is room (`tryGrow`).
   */
  giveItem(name: ItemName, t: number, at: V2 = this.middle()): void {
    const open: ItemCue = { phase: 'open', item: name, id: this.id, at: { x: at.x, y: at.y } };
    if (name === 'icePop') {
      this.damage = 0;
      this.itemCues.push(open, { phase: 'use', item: name, id: this.id, at: this.middle() }, { phase: 'end', item: name, id: this.id, at: this.middle() });
      return;
    }
    if (this.item) this.endItem();
    this.itemCues.push(open);
    this.item = name;
    this.itemUntil = TIMED_ITEMS.has(name) ? t + (name === 'growJuice' ? GROW.seconds : ZOOM.seconds) : 0;
    this.itemUses = name === 'poolNoodle' ? NOODLE.swings : name === 'bubbleShield' ? SHIELD_HITS : 0;
    if (name === 'zoomSneakers') {
      this.useStats(zoomStats(this.body));
      this.mover.airJumpsLeft += ZOOM.airJumps;
    }
  }

  /**
   * Its power-up ends (an `end` cue): it moves and stands as its own body again (shrinking is always safe: the smaller
   * box sits inside the bigger one, on the same bottom centre), and a held item is gone.
   */
  endItem(): void {
    const name = this.item;
    if (!name) return;
    this.item = null;
    this.itemUses = 0;
    this.itemCues.push({ phase: 'end', item: name, id: this.id, at: this.middle() });
    if (this.stats !== this.body) this.useStats(this.body);
    this.mover.airJumpsLeft = Math.min(this.mover.airJumpsLeft, this.body.moves.airJumps);
    if (this.grown) {
      this.grown = false;
      this.mover.w = this.body.w;
      this.mover.h = this.body.h;
      this.resize(1);
    }
  }

  /**
   * Grow Juice: grows the box (and the look) from its bottom centre if the bigger box would be clear of every solid
   * platform in `plats` (ruling R7: else it waits; held, it waits to be let go). Returns whether it grew.
   */
  tryGrow(plats: readonly Platform[]): boolean {
    if (this.item !== 'growJuice' || this.grown || this.action === 'held' || this.heldBy) return false;
    const g = grownStats(this.body), m = this.mover;
    if (solidAt(plats, m.pos.x, m.pos.y, g.w, g.h)) return false;
    this.useStats(g);
    m.w = g.w;
    m.h = g.h;
    this.grown = true;
    this.resize(GROW.size);
    this.itemCues.push({ phase: 'use', item: 'growJuice', id: this.id, at: this.middle() });
    return true;
  }

  /**
   * Hit by a custard pie: `splat`, stunned (a stagger of PIE.stun s, standing still) with a dab of damage; `blocked`,
   * its Bubble Shield stopped the pie (no stun, no custard); `missed`, it could not be hit or is held (the pie flies on).
   * Kid power (`byKid`: a kid-powered creature threw it) scales the damage and the stun (`kidShare`).
   */
  splat(byKid = false): 'splat' | 'blocked' | 'missed' {
    if (!this.canBeHit() || this.action === 'held') return 'missed';
    if (this.shieldBlocks()) return 'blocked';
    const k = kidShare(byKid, this.kid);
    this.damage += PIE.damage * k.damage;
    this.meter = Math.min(1, this.meter + METER_TAKEN * this.meterShare());
    this.begin('hitstun', Math.round((PIE.stun * k.stun) / DT));
    this.mover.vel.x = 0;
    if (this.mover.vel.y > 0) this.mover.vel.y = 0;
    return 'splat';
  }

  /**
   * Called by the sim when the throw it has just let go of launched nobody (a Bubble Shield stopped it): the `throw`
   * cue becomes a `release`, the one it threw drops free from where it was carried, and it is free itself (ruling R36:
   * no empty throw, nobody left held without a holder).
   */
  throwStopped(b: StageFighter): void {
    const c = this.grabCues[this.grabCues.length - 1];
    if (c && c.phase === 'throw' && c.other === b.id) {
      c.phase = 'release';
      delete c.dir;
    }
    if (b.action === 'held' && !b.heldBy) b.drop();
    if (this.action === 'throw' && !this.holding) this.becomeFree();
  }

  /** Its four attacks now: its body's (or grown body's), or Pool Noodle swings while the noodle has swings left. */
  attackSet(): Record<AttackDir, Attack> {
    return this.item === 'poolNoodle' && this.itemUses > 0 ? noodleSet(this.stats) : attackSet(this.stats);
  }

  /** How much faster its special meter fills than a body's: KID_POWER.meter × with kid power, else 1. */
  meterShare(): number {
    return this.kid ? KID_POWER.meter : 1;
  }

  /** How much harder than its body it hits now (Grow Juice, once grown: GROW.power). */
  powerShare(): number {
    return this.grown ? GROW.power : 1;
  }

  /** The look's size now (1, or GROW.size grown), easing over GROW_EASE steps (display only). */
  lookScale(): number {
    const k = this.sizeT / GROW_EASE, e = k >= 1 ? 1 : k * k * (3 - 2 * k);
    return this.sizeFrom + (this.sizeTo - this.sizeFrom) * e;
  }

  /** A Bubble Shield stops this hit: one used (a `use` cue), popping after the last (`end`). */
  private shieldBlocks(): boolean {
    if (this.item !== 'bubbleShield') return false;
    this.itemUses--;
    this.itemCues.push({ phase: 'use', item: 'bubbleShield', id: this.id, at: this.middle() });
    if (this.itemUses <= 0) this.endItem();
    return true;
  }

  /** Moves and fights as `s` from now on (its coasting movement too). */
  private useStats(s: BodyStats): void {
    this.stats = s;
    this.coast = { ...s.moves, accel: 0, airAccel: 0 };
  }

  /** The look starts easing to size `to`. */
  private resize(to: number): void {
    this.sizeFrom = this.lookScale();
    this.sizeTo = to;
    this.sizeT = 0;
  }

  /** The middle of its box. */
  private middle(): V2 {
    return { x: this.mover.pos.x, y: this.mover.pos.y + this.mover.h / 2 };
  }

  /**
   * Lets go of the one it holds (a `release`): the held one drops where it is, free (unless something else already took
   * it, such as a hit or going out); a holder still in its grab or its throw's wind-up is free again.
   */
  letGo(): void {
    const b = this.holding;
    if (!b) return;
    this.holding = null;
    b.heldBy = null;
    this.grabCues.push({ id: this.id, other: b.id, phase: 'release' });
    if (b.action === 'held') b.drop();
    else if (b.action === 'frozen' && b.frozenFrom === 'held') b.frozenFrom = 'air';
    // a holder still grabbing, or winding up a throw of the one just let go, is free again at once (no empty throw)
    if (this.action === 'grab' || this.action === 'throw') this.becomeFree();
    else if (this.action === 'frozen' && (this.frozenFrom === 'grab' || this.frozenFrom === 'throw')) this.frozenFrom = 'air';
  }

  /** Dropped from a hold: falling from where it was carried, free to act. */
  private drop(): void {
    this.heldBy = null;
    this.mover.vel.x = this.mover.vel.y = 0;
    this.mover.ground = null;
    this.begin('air', 0);
  }

  /** Called by the sim: this fighter's grab caught `b`, which it now holds (lifting it overhead); `b` is held. */
  seize(b: StageFighter): void {
    this.begin('grab', HOLD_MAX);
    this.holding = b;
    b.heldBy = this;
    b.begin('held', 0);
    // it faces its holder (a throw then launches it without a turn)
    b.facing = this.facing === 1 ? -1 : 1;
    b.mover.vel.x = b.mover.vel.y = 0;
    b.mover.ground = null;
    this.grabCues.push({ id: this.id, other: b.id, phase: 'grab' });
  }

  /**
   * Called by the sim at the throw's release: the held one leaves the hands (a `throw` cue) for the sim to launch the
   * way of the throw. Returns it (null if it holds nobody).
   */
  release(): StageFighter | null {
    const b = this.holding;
    if (!b) return null;
    this.holding = null;
    b.heldBy = null;
    this.grabCues.push({ id: this.id, other: b.id, phase: 'throw', dir: this.throwDir });
    return b;
  }

  /** Lets its special go: the meter empties and the wind-up starts (a `charge` cue). */
  private startSpecial(): void {
    const kit = this.kit;
    this.meter = 0;
    this.begin('special', kit.charge + kit.release);
    this.attack = kit.attack;
    this.attackHits.clear();
    this.run.reset();
    this.specialCue('charge');
  }

  /** Reaches out to grab (on the ground). */
  private startGrab(): void {
    this.begin('grab', GRAB_WINDUP + GRAB_ACTIVE + GRAB_MISS);
  }

  /** Throws the one it holds `dir`: forward, turned to `side`, or up. */
  private startThrow(dir: 'forward' | 'up', side: 1 | -1): void {
    this.facing = side;
    this.throwDir = dir;
    if (this.holding) this.holding.facing = side === 1 ? -1 : 1;
    this.begin('throw', THROW_STEPS);
  }

  private specialCue(phase: StageSpecialCue['phase'], at: V2 = this.mover.pos): void {
    this.specialCues.push({ id: this.id, special: this.kit.name, phase, at: { x: at.x, y: at.y } });
  }

  /** The special's `impact`, once per special. */
  private specialImpact(at: V2): void {
    if (this.action !== 'special' || this.run.impacted) return;
    this.run.impacted = true;
    this.specialCue('impact', at);
  }

  /** Back in control: standing (idle or running) or in the air. */
  private becomeFree(): void {
    const ground = this.mover.ground !== null;
    this.begin(!ground ? 'air' : Math.abs(this.last.mx) > STICK_MOVE ? 'run' : 'idle', 0);
  }

  /** An attack in the stick's direction: up, down or forward on the ground; up or the air attack in the air. */
  private startAttack(my: number, grounded: boolean): void {
    const up = my > STICK_TILT, down = my < -STICK_TILT;
    const dir: AttackDir = grounded ? (up ? 'up' : down ? 'down' : 'forward') : up ? 'up' : 'air';
    const a = this.attackSet()[dir];
    if (this.item === 'poolNoodle' && this.itemUses > 0) {
      this.itemUses--;
      this.itemCues.push({ phase: 'use', item: 'poolNoodle', id: this.id, at: this.middle() });
    }
    this.begin('attack', a.windup + a.active + a.cool);
    this.attack = a;
    this.attackDir = dir;
    this.attackInAir = !grounded;
    this.attackHits.clear();
  }

  /** Throws the custard pie it holds: a forward swing that lets the pie go at its top (PIE.windup). */
  private startPieThrow(grounded: boolean): void {
    const a = pieThrow(this.stats);
    this.begin('attack', a.windup + a.cool);
    this.attack = a;
    this.attackDir = 'forward';
    this.attackInAir = !grounded;
    this.attackHits.clear();
  }

  /**
   * A dodge: on the ground a roll the way the stick points, or a sidestep in place; in the air always in place (so it
   * never bursts sideways when it touches down).
   */
  private startDodge(mx: number, grounded: boolean): void {
    this.dodgeDir = grounded && Math.abs(mx) > STICK_MOVE ? (mx > 0 ? 1 : -1) : 0;
    this.begin('dodge', this.tune.dodgeSteps);
    this.dodgeWait = this.tune.dodgeSteps + this.tune.dodgeRest;
  }
}
