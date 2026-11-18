import type { Rng } from '../util/rng';
import type { Attack, AttackDir } from './attacks';
import type { BodyStats } from './body';
import type { StageFighter } from './fighter';
import { GRAB_AHEAD, GRAB_R, grabbable } from './grab';
import { PIE, PIE_HAND, PIE_HIGH, type ItemDrops } from './items';
import { platformsAt, type Level, type Platform } from './level';
import type { LevelMischief, TrainBox } from './mischief';
import type { MoveStats } from './move';
import { jumpReach, NAV_COST, navGraph, route, stepOff, type NavLink } from './nav';
import { specialAim, type SpecialAim } from './specials';
import { DT, type Intent } from './types';

/**
 * What a brain sees each step: itself, the others in play, the level as it is now (`sim.level`: low gravity swaps it),
 * the level time (s), the level's mischief (`sim.mischief`; none = no mischief) and the presents (`sim.items`; none =
 * no presents to go for). `others` is only valid during the call (the caller reuses the array), so a brain keeps ids,
 * never the list.
 */
export type SimView = {
  self: StageFighter; others: readonly StageFighter[]; level: Level; t: number; mischief?: LevelMischief; items?: ItemDrops;
};

/**
 * What a brain keeps between steps. The public part: who it is after (`target`, an id or null), its route to where it
 * is going (`plan`, the links from the platform it planned on), its `mood` (0 calm … 1 fired up; being hit fires it
 * up, then it settles back to its own temper), the level time before which it makes no new mistake (`mistakeT`), and
 * `showoff`: true while it is posing alone on the level (the show may play the show-off clip).
 * The rest is its own bookkeeping: its nature (rolled on the first think), who hit it last, where it is roaming, the
 * link under way in the air, the buttons it held last step (a fighter counts a held button once, so the brain lets go
 * between presses) and the intent it hands back (reused every step).
 */
export type BrainMemory = {
  target: string | null;
  plan: NavLink[];
  mood: number;
  mistakeT: number;
  showoff: boolean;
  /** How fiery its mood settles at (0…1), and how much it likes roaming the platforms (0…1); −1 until rolled. */
  temper: number;
  roamer: number;
  /** When it next picks a target (level time, s). */
  retargetT: number;
  /** Who hit it last, and until when it holds a grudge (s). */
  grudge: string | null;
  grudgeT: number;
  /** Its damage at the last think (more now means it was hit). */
  lastDamage: number;
  /** The platforms the plan was made from and to. */
  planFrom: string | null;
  planTo: string | null;
  /** The level (as it was: low gravity is another object) the plan was made on; a change of level means a new plan. */
  planLevel: Level | null;
  /** The movement it planned with (a power-up swaps in another object: ruling R27); a change means a new plan. */
  planMoves: MoveStats | null;
  /** The link it jumped or dropped to take (steered by while in the air), or null. */
  link: NavLink | null;
  /** A platform it is roaming (or strutting) to, a spot on it (m from its centre), and when it gives up (s). */
  goal: string | null;
  goalX: number;
  goalUntil: number;
  /** Alone: posing until this time (s), and whether a flourish (a jump with a swing at the top) is under way. */
  pauseUntil: number;
  flourish: boolean;
  /** How long it has stood still (s), and a little step it takes when it has stood too long. */
  stillT: number;
  fidgetUntil: number;
  fidgetDir: 1 | -1;
  /** Holding someone: when it throws them (level time, s; −1 when not holding). */
  throwT: number;
  /** The vine it is going for (−1: none), and when it gives up on it (s). */
  vine: number;
  vineUntil: number;
  /** The link it is waiting on a moving platform to take, since when, and the last time it waited (s). */
  waitLink: NavLink | null;
  waitSince: number;
  waitLast: number;
  held: { jump: boolean; attack: boolean; down: boolean; dodge: boolean; special: boolean; grab: boolean; item: boolean };
  intent: Intent;
};

/** A fresh memory: no target, no plan, its nature not yet rolled, no buttons held. */
export const newBrainMemory = (): BrainMemory => ({
  target: null, plan: [], mood: 0.5, mistakeT: 0, showoff: false, temper: -1, roamer: 0, retargetT: 0, grudge: null,
  grudgeT: 0, lastDamage: 0, planFrom: null, planTo: null, planLevel: null, planMoves: null, link: null, goal: null, goalX: 0,
  goalUntil: 0, pauseUntil: 0, flourish: false, stillT: 0, fidgetUntil: 0, fidgetDir: 1, throwT: -1, vine: -1, vineUntil: 0,
  waitLink: null, waitSince: 0, waitLast: -1,
  held: { jump: false, attack: false, down: false, dodge: false, special: false, grab: false, item: false },
  intent: { mx: 0, my: 0, jump: false, attack: false, special: false, grab: false, item: false, dodge: false },
});

// Fighting.
/** Chance per step of swinging at a foe in reach (× 0.75…1.25 by mood), so swings come at varied moments. */
const ATTACK_CHANCE = 0.3;
/**
 * It swings only when the strike would reach this far inside the foe's box (m), so a swing in reach lands: two foes just
 * out of reach step in rather than swing at air forever.
 */
const REACH_SURE = 0.05;
/** A foe whose feet are above this share of its own height gets the up attack. */
const UP_SHARE = 0.6;
/** A foe shorter than this share of its own height gets the low (down) attack when that reaches. */
const LOW_SHARE = 0.6;
/** Share of a foe's speed counted on when guessing where it will be at the strike. */
const FOE_LEAD = 0.5;
/** Chance per step of dodging a foe's wind-up aimed at it: base, plus more the calmer it is. */
const DODGE_BASE = 0.05, DODGE_CALM = 0.07;
/** A wind-up counts as aimed at it within the attack's reach plus this (m). */
const DODGE_RANGE = 0.6;
/** Chance per step of hopping in with an air attack at a foe on its floor this far away (m). */
const HOP_CHANCE = 0.015, HOP_MIN = 1.8, HOP_MAX = 3.5;

// Specials, grabs and throws.
/** Chance per step of letting a full meter go at a foe where its special reaches (× 0.75…1.25 by mood). */
const SPECIAL_CHANCE = 0.2;
/** Chance per step of grabbing a foe in the hands' reach (× 0.75…1.25 by mood), instead of swinging at it. */
const GRAB_CHANCE = 0.06;
/** It grabs only a foe whose feet are within this of its own (m), within this share of the hands' circle. */
const GRAB_LEVEL = 0.5, GRAB_SURE = 0.6;
/** Holding someone, it throws after this long plus up to the spread (s): long enough for the lift to read. */
const THROW_WAIT = 0.25, THROW_SPREAD = 0.4;
/** A held foe with at least this much damage is thrown up by this chance (the top is far, but it flies far). */
const UP_DAMAGE = 100, UP_CHANCE = 0.5;
/** Chance per step of dodging a foe's special wind-up aimed at it (the same calm bonus as a wind-up). */
const SPECIAL_DODGE = 0.04;

// Targets.
/** It picks a target again after this long, plus up to the spread (s). */
const RETARGET_MIN = 1.5, RETARGET_SPREAD = 2;
/** Height counts this many times over in distances: another floor is further than it looks. */
const HEIGHT_WEIGHT = 2;
/** Picking a target, height counts this many times over: a foe up on a platform is still worth going after. */
const TARGET_HEIGHT = 0.5;
/** A damaged foe looks this much nearer per point of damage (m): it goes for the weak ones. */
const DAMAGE_PULL = 0.03;
/** Whoever hit it looks this much nearer (m) for GRUDGE_TIME s; it turns on them at once by this chance. */
const GRUDGE_PULL = 4, GRUDGE_TIME = 6, GRUDGE_TURN = 0.6;
/** Each other fighter within CROWD_NEAR (m) of a foe makes it look this much further (m), so they spread out. */
const CROWD_NEAR = 2.5, CROWD_COST = 2.5;
/** A foe off the level looks this much further (m): it is coming back, there is no reaching it. */
const OFFSTAGE_COST = 10;
/** Up to this much (m) at random on each foe's distance, for variety. */
const TARGET_NOISE = 3;
/** The target it has looks this much nearer (m), so it does not flit between two. */
const LOYALTY = 1;
/** Chance (× 0.5…1.5 by nature) that, picking a target, it roams to a platform first for ROAM_TIME + spread s. */
const ROAM_CHANCE = 0.2, ROAM_TIME = 3, ROAM_SPREAD = 2;
/** A foe this close (m) ends a roam: it turns to fight. */
const ENGAGE_NEAR = 3;
/** Route choice: each metre to the first platform of a route costs this much (a link costs 1–3). */
const DIST_COST = 0.15;

// Mood and mistakes.
/** A hit fires the mood up by this; it settles back to its temper at this rate (per s). */
const MOOD_HIT = 0.2, MOOD_SETTLE = 0.3;
/** After a mistake, none for this long plus up to the spread (s). */
const MISTAKE_REST = 2, MISTAKE_SPREAD = 3;
/** Chance per step of jumping too early when lining up a jump within EARLY_NEAR (m) of the take-off spot. */
const EARLY_CHANCE = 0.02, EARLY_NEAR = 2;
/** Chance per step of swinging at air at a foe just out of reach (within this much past it, m). */
const WHIFF_CHANCE = 0.02, WHIFF_NEAR = 1;

// Getting around.
/** A foe whose feet are this far above (m) is on another floor (worth a jump). */
const FLOOR_GAP = 1;
/** Jumps at a foe in the air above once this close sideways (m), by this chance per step. */
const JUMP_NEAR = 2.5, JUMP_CHANCE = 0.25;
/** Air jumps when its rise has slowed below this (m/s), near the top of the jump. */
const AIR_JUMP_AT = 1;
/** Looks this far past its leading side for ground before walking on (m), so it never walks off the level. */
const EDGE_LOOK = 0.6;
/** A dodge roll goes about this far (m): it only rolls where there is ground. */
const ROLL_LOOK = 2.4;
/** Feet must rise this far over a top to land on it (m). */
const CLEAR = 0.3;
/** Lands at least this far in from a platform's edge (m, past its half width). */
const LAND_IN = 0.3;
/** A jump may still drift this far sideways (m) onto the platform it is for, so it may take off from that far out. */
const TAKEOFF_DRIFT = 1;
/** Jumps once within this of its take-off spot (m). */
const TAKEOFF_SLACK = 0.25;
/** Beside a solid platform it jumps from this far off its side (m). */
const SIDE_GAP = 0.3;
/** Where a moving platform will be is looked up this far ahead (s): about the rise of a jump, and of two. */
const LEAD_JUMP = 0.45, LEAD_AIR = 0.8;
/** In the air it looks this far ahead (s) for ground under where it is drifting. */
const AIR_LOOK = 0.35;
/** Close enough to a spot it walks to (m). */
const ARRIVE = 0.4;
/** The stick is held at least this far before it counts as a way to go (m to the goal). */
const GOAL_SLACK = 0.1;
/** Standing within this of a platform's top counts as on it (m). */
const ON_TOP = 0.05;

// Coming back.
/** Aims this far in from a ledge when coming back to the level (m). */
const LEDGE_IN = 1;
/**
 * Coming back it jumps once falling below the ledge's top + RECOVER_ABOVE, less this share of the rise it still has
 * (this jump's and the rest): it waits low enough to make the most of each jump (more time to drift in), high enough
 * to be safe.
 */
const RECOVER_ABOVE = 0.5, LATER_SHARE = 0.25;

// Mischief.
/** Chance per step, while the vines are out and no foe is close, of going for a vine (often: they are fun to ride). */
const VINE_CHANCE = 0.03;
/** Gives up going for a vine after this long (s). */
const VINE_TIME = 4;
/** Looks this far ahead (s) for where a vine's grip will be: about the time a jump takes to rise to it. */
const VINE_LEAD = 0.35;
/** Jumps for a grip once it will be this close sideways (m). */
const VINE_NEAR = 1.2;
/** On a vine it lets go when swinging toward where it is going at least this fast (m/s), by this chance per step. */
const LET_GO_SPEED = 2.5, LET_GO_CHANCE = 0.15;
/** Letting go, it looks this far ahead (s) along the swing for ground to land on. */
const LET_GO_LOOK = 0.5;
/** With nowhere to go, it lets go by this chance per step. */
const LET_GO_IDLE = 0.02;
/** Hops the toy train once its front will reach it within this (s), by this chance per step. */
const TRAIN_LEAD = 0.25, TRAIN_HOP = 0.3;
/** Feet this far (m) over the train's top count as clear of it. */
const TRAIN_CLEAR = 0.5;
/** Leans against a drift (the river's current, the airlock's pull) when its floor ends within this (m) downstream. */
const DRIFT_LOOK = 2;
/**
 * Waiting on a moving platform for its usual drop spot over the floor below, after this long (s) it drops wherever its
 * box is over any part of that floor, this far (m) in from the floor's ends (ruling R28: no endless wait).
 */
const DROP_WAIT = 2, DROP_EDGE = 0.25;

// Presents and power-ups.
/** It goes for a present (that it can get to) this near (m along, its height counting HEIGHT_WEIGHT times over). */
const PRESENT_REACH = 12;
/** Chance per step of throwing a custard pie whose arc will splat a foe (× 0.75…1.25 by mood). */
const PIE_CHANCE = 0.15;
/** Slack round a foe's box when working out whether a pie's arc reaches it (m). */
const PIE_SLACK = 0.1;

// Alone.
/** Poses this long plus up to the spread (s) on reaching each spot; a flourish by this chance. */
const PAUSE_MIN = 0.4, PAUSE_SPREAD = 0.6, FLOURISH_CHANCE = 0.4;
/** Gives up on a spot it cannot reach after this long (s). */
const STRUT_TIME = 8;
/** After standing still this long (s, under STILL_SPEED m/s) it takes a little step lasting FIDGET_TIME s. */
const STILL_FIDGET = 1, STILL_SPEED = 0.2, FIDGET_TIME = 0.35, FIDGET_STICK = 0.6;

/** Reused every call: the platforms now and a little ahead, the ledge aimed for, the buttons wanted this step. */
const plats: Platform[] = [], ahead: Platform[] = [];
const ledge = { x: 0, y: 0 };
const vineAt = { x: 0, y: 0 };
const trainAt: TrainBox = { x: 0, y: 0, w: 0, h: 0, dir: 1, speed: 0 };
const press = { jump: false, attack: false, down: false, dodge: false, special: false, grab: false, item: false };
/** Whether this step it steps off an edge on purpose (onto a lower floor a little way across): not walking off. */
let steppingOff = false;
/** Each body's special aim, worked out once per gravity. */
const aims = new WeakMap<BodyStats, { g: number; aim: SpecialAim }>();

/**
 * The brain: one step of wanting for `view.self`. It picks a target (near, weak, or whoever hit it, with some
 * variety and away from crowds), gets to it across the platforms by the level's graph (jumping, air jumping, dropping,
 * waiting for a moving platform), swings in the right direction when in reach (up at a foe above, the air attack in a
 * jump), dodges some wind-ups, comes back when knocked off (drifting to the nearest ledge, saving the air jump and the
 * recovery leap for the right moment, never jumping under the stage's lip), and alone it struts about and shows off.
 * With the level's mischief it rides the vines (jumping into a grip, letting go swinging its way), hops the toy train
 * and leans against the river's current and the airlock's pull at an edge. With no power-up it goes for a present
 * within reach; it throws a custard pie at a foe the pie's arc will splat, and swings a pool noodle from further off.
 * It sometimes roams to a platform, jumps early or swings at air: fun, not perfect. Random numbers only from `rng`.
 * The intent returned is the memory's own, valid until the next think with this memory.
 */
export function think(view: SimView, rng: Rng, memory: BrainMemory): Intent {
  const me = view.self, m = me.mover, p = m.pos, t = view.t;
  const ps = platformsAt(view.level, t, plats);
  const want = memory.intent;
  want.mx = want.my = 0;
  want.jump = want.attack = want.special = want.grab = want.item = want.dodge = false;
  press.jump = press.attack = press.down = press.dodge = press.special = press.grab = press.item = false;
  steppingOff = false;
  memory.showoff = false;
  if (memory.temper < 0) {
    memory.temper = rng();
    memory.roamer = rng();
    memory.mood = memory.temper;
    memory.mistakeT = t + rng() * MISTAKE_SPREAD;
  }
  const grounded = m.ground !== null;
  memory.stillT = grounded && me.isFree() && Math.abs(m.vel.x) < STILL_SPEED ? memory.stillT + DT : 0;
  // A link ends on landing; a hit, a swing or a dodge ends it too (knocked off a jump, it must not steer by it).
  if (grounded || !me.isFree()) memory.link = null;

  feel(view, rng, memory);
  const foe = pickTarget(view, rng, memory);
  const onStage = grounded || groundBelow(ps, p.x, p.y);
  const riding = view.mischief ? view.mischief.riding(me.id) : -1;

  if (me.action !== 'grab' || !me.holding) memory.throwT = -1;
  if (riding >= 0) {
    rideVine(view, rng, memory, foe);
  } else if (!me.isFree()) {
    // Busy (a swing, a stagger, a tumble, a dodge, a special): only an air swing steers, and off the level it steers
    // home. Holding someone, it throws them.
    if (me.action === 'grab' && me.holding) throwHeld(view, rng, memory);
    else if (!onStage) steer(me, want, nearestLedge(ps, p.x, p.y, m.w, m.h).x, false);
  } else if (!onStage) {
    // Over a gap on the way to a platform it can still make: keep going; else come back to the nearest ledge.
    if (makingIt(view, memory)) inAir(view, memory, foe, p.x);
    else {
      memory.link = null;
      recover(view, memory);
    }
  } else if (dodge(view, rng, memory)) {
    // dodging
  } else if (useSpecial(view, rng, memory, foe)) {
    // letting the special go (or turning to)
  } else if (grabFoe(view, rng, memory, foe)) {
    // reaching out to grab
  } else if (throwPie(view, rng, memory, foe)) {
    // a custard pie for a foe its arc reaches
  } else if (!climbing(view, memory) && strike(view, rng, memory, foe)) {
    // in reach: swinging, or about to
  } else if (seekPresent(view, rng, memory, foe)) {
    // going for a present
  } else if (seekVine(view, rng, memory, foe)) {
    // going for a vine
  } else if (foe) {
    if (memory.goal !== null && (t > memory.goalUntil || near(me, foe, ENGAGE_NEAR))) memory.goal = null;
    if (memory.goal !== null) {
      const g = find(ps, memory.goal);
      if (!g) memory.goal = null;
      // There, it holds that floor till the roam is up, pacing to another spot on it.
      else if (goTo(view, rng, memory, foe, g.id, g.x + memory.goalX)) memory.goalX = -memory.goalX * rng();
    } else chase(view, rng, memory, foe);
  } else strut(view, rng, memory);

  if (riding < 0 && me.isFree()) dodgeTrain(view, rng);
  if (grounded && me.isFree()) {
    fidget(view, rng, memory);
    // Lean against a current or a pull near the edge it sweeps toward.
    const drift = view.mischief?.driftOn(me) ?? 0;
    if (drift !== 0) {
      const s = Math.sign(drift);
      if (want.mx * s >= 0 && !groundBelow(ps, p.x + s * (m.w / 2 + DRIFT_LOOK), p.y)) want.mx = -s;
    }
    // Never walk (or roll) off the level (stepping off onto a floor below is no walking off).
    if (want.mx !== 0 && !steppingOff) {
      const look = press.dodge ? ROLL_LOOK : m.w / 2 + EDGE_LOOK;
      if (!groundBelow(ps, p.x + Math.sign(want.mx) * look, p.y)) want.mx = 0;
    }
  }

  // Let go between presses so each one counts.
  const held = memory.held;
  want.jump = press.jump && !held.jump;
  want.attack = press.attack && !held.attack;
  want.dodge = press.dodge && !held.dodge;
  want.special = press.special && !held.special;
  want.grab = press.grab && !held.grab;
  want.item = press.item && !held.item;
  if (press.down && !held.down) want.my = -1;
  held.jump = want.jump;
  held.attack = want.attack;
  held.dodge = want.dodge;
  held.special = want.special;
  held.grab = want.grab;
  held.item = want.item;
  held.down = want.my < 0;
  return want;
}

/** This body's special aim on this level's gravity (worked out once per body and gravity). */
function aimOf(stats: BodyStats, kit: StageFighter['kit'], gravity: number): SpecialAim {
  let a = aims.get(stats);
  if (!a || a.g !== gravity) {
    a = { g: gravity, aim: specialAim(kit, stats, gravity, { near: 0, far: 0, up: 0, down: 0, travel: 0 }) };
    aims.set(stats, a);
  }
  return a.aim;
}

/** Whether `o` stands where `me`'s special would reach it, on its `side` (1 right, −1 left). */
function inSpecialReach(me: StageFighter, aim: SpecialAim, o: StageFighter, side: 1 | -1): boolean {
  const p = me.mover.pos, q = o.mover.pos;
  const ahead = side * (q.x - p.x), dy = q.y - p.y;
  return ahead >= aim.near && ahead <= aim.far && dy <= aim.up && dy >= -aim.down;
}

/**
 * With a full meter, standing, and a foe (the target first, else anyone) where the special reaches: face it and, by
 * chance, let the special go. Only where its own platform runs on under the whole move (it never carries itself off
 * the level). Returns whether it is lining one up.
 */
function useSpecial(view: SimView, rng: Rng, memory: BrainMemory, foe: StageFighter | null): boolean {
  const me = view.self, m = me.mover, p = m.pos;
  if (me.meter < 1 || m.ground === null) return false;
  const aim = aimOf(me.stats, me.kit, view.level.gravity);
  let who: StageFighter | null = null;
  if (foe && foe.canBeHit() && inSpecialReach(me, aim, foe, foe.mover.pos.x >= p.x ? 1 : -1)) who = foe;
  if (!who) {
    for (const o of view.others) {
      if (o.action === 'out' || !o.canBeHit() || !inSpecialReach(me, aim, o, o.mover.pos.x >= p.x ? 1 : -1)) continue;
      who = o;
      break;
    }
  }
  if (!who) return false;
  // the whole move stays over the platform it stands on (a dive or a leap off a higher one would carry on down and out)
  const side = who.mover.pos.x >= p.x ? 1 : -1, g = find(plats, m.ground);
  if (!g || Math.abs(p.x + side * aim.travel - g.x) > g.w / 2 - m.w / 2) return false;
  if (me.facing !== side) {
    memory.intent.mx = side;
    return true;
  }
  if (rng() < SPECIAL_CHANCE * (0.75 + 0.5 * memory.mood)) press.special = true;
  return true;
}

/**
 * A foe (the target first, else anyone) right by it on its own level that can be caught: by chance it faces it and
 * reaches out to grab, instead of swinging. Returns whether it grabs.
 */
function grabFoe(view: SimView, rng: Rng, memory: BrainMemory, foe: StageFighter | null): boolean {
  const me = view.self, m = me.mover;
  if (m.ground === null) return false;
  let who: StageFighter | null = foe && inHands(me, foe) ? foe : null;
  if (!who) {
    for (const o of view.others) {
      if (!inHands(me, o)) continue;
      who = o;
      break;
    }
  }
  if (!who || rng() >= GRAB_CHANCE * (0.75 + 0.5 * memory.mood)) return false;
  memory.intent.mx = who.mover.pos.x >= m.pos.x ? 1 : -1;
  press.grab = true;
  return true;
}

/** Whether `o` can be caught and is surely within the hands' reach (either side: it turns as it grabs). */
function inHands(me: StageFighter, o: StageFighter): boolean {
  if (!grabbable(o)) return false;
  const m = me.mover, q = o.mover;
  const gap = Math.abs(q.pos.x - m.pos.x) - (m.w + q.w) / 2;
  return gap <= GRAB_AHEAD + GRAB_R * GRAB_SURE && Math.abs(q.pos.y - m.pos.y) < GRAB_LEVEL;
}

/**
 * Holding someone: after a moment (so the lift reads) it throws them toward the nearer side of the level (where the
 * out-line is closest), or, when they are badly damaged, sometimes straight up.
 */
function throwHeld(view: SimView, rng: Rng, memory: BrainMemory): void {
  const me = view.self, held = me.holding!, p = me.mover.pos, b = view.level.bounds;
  if (memory.throwT < 0) memory.throwT = view.t + THROW_WAIT + rng() * THROW_SPREAD;
  if (view.t < memory.throwT) return;
  press.attack = true;
  if (held.damage >= UP_DAMAGE && rng() < UP_CHANCE) memory.intent.my = 1;
  else memory.intent.mx = p.x - b.left < b.right - p.x ? -1 : 1;
}

/**
 * With no power-up of its own, it goes for the nearest present within PRESENT_REACH that it can get to: to the
 * platform it lies on (or, still falling, will land on) and onto it. Returns whether it is going for one.
 */
function seekPresent(view: SimView, rng: Rng, memory: BrainMemory, foe: StageFighter | null): boolean {
  const items = view.items, me = view.self, m = me.mover, p = m.pos;
  if (!items || me.item !== null || items.presents.length === 0) return false;
  const here = m.ground;
  let bestX = 0, bestOn: string | null = null, bestD = PRESENT_REACH;
  for (const q of items.presents) {
    const on = q.on ?? platformUnder(plats, q.x, q.y);
    const g = on === null ? null : find(plats, on);
    if (!g || g.bounce) continue;
    const d = Math.abs(q.x - p.x) + Math.abs(g.y - p.y) * HEIGHT_WEIGHT;
    if (d >= bestD) continue;
    if (here !== null && here !== g.id && !route(navGraph(view.level, me.stats.moves), here, g.id)) continue;
    bestD = d;
    bestX = q.x;
    bestOn = g.id;
  }
  if (bestOn === null) return false;
  goTo(view, rng, memory, foe, bestOn, bestX);
  return true;
}

/**
 * Holding a custard pie: a foe (the target first, else anyone) its arc would splat: face it and, by chance, throw.
 * Returns whether it is lining a throw up.
 */
function throwPie(view: SimView, rng: Rng, memory: BrainMemory, foe: StageFighter | null): boolean {
  const me = view.self;
  if (me.item !== 'custardPie' || !me.isFree()) return false;
  let who: StageFighter | null = foe && pieReaches(me, foe, view.level.gravity) ? foe : null;
  if (!who) {
    for (const o of view.others) {
      if (o.action === 'out' || !pieReaches(me, o, view.level.gravity)) continue;
      who = o;
      break;
    }
  }
  if (!who) return false;
  const side = who.mover.pos.x >= me.mover.pos.x ? 1 : -1;
  if (me.facing !== side) memory.intent.mx = side;
  else if (rng() < PIE_CHANCE * (0.75 + 0.5 * memory.mood)) press.item = true;
  return true;
}

/**
 * Whether a custard pie thrown at `o` now (turning to it) would splat it: its arc from the hand, under gravity `g`,
 * passes through `o`'s box (where `o` will be about when the pie leaves the hand) on its way across it.
 */
function pieReaches(me: StageFighter, o: StageFighter, g: number): boolean {
  if (!o.canBeHit() || o.action === 'held') return false;
  const m = me.mover, q = o.mover, lead = PIE.windup * DT;
  const side = q.pos.x >= m.pos.x ? 1 : -1;
  const x0 = m.pos.x + side * (m.w / 2 + PIE_HAND), y0 = m.pos.y + m.h * PIE_HIGH;
  const ox = q.pos.x + q.vel.x * lead * FOE_LEAD, oy = q.pos.y;
  const near = side * (ox - x0) - q.w / 2 - PIE.r, far = near + q.w + 2 * PIE.r;
  if (far <= 0) return false;
  // where the arc is as it crosses the box: at its near side, its middle and its far side
  for (const d of [Math.max(0, near), (Math.max(0, near) + far) / 2, far]) {
    const t = d / PIE.speed, y = y0 + PIE.up * t - (g * t * t) / 2;
    if (y >= oy - PIE.r - PIE_SLACK && y <= oy + q.h + PIE.r + PIE_SLACK) return true;
  }
  return false;
}

/** Being hit fires the mood up and starts a grudge against whoever did it (often turning on them at once). */
function feel(view: SimView, rng: Rng, memory: BrainMemory): void {
  const me = view.self, t = view.t;
  if (me.damage > memory.lastDamage) {
    memory.mood = Math.min(1, memory.mood + MOOD_HIT);
    for (const o of view.others) {
      if (o.attack && o.attackHits.has(me.id)) {
        memory.grudge = o.id;
        memory.grudgeT = t + GRUDGE_TIME;
        if (rng() < GRUDGE_TURN) {
          memory.target = o.id;
          memory.retargetT = t + RETARGET_MIN;
          memory.goal = null;
        }
        break;
      }
    }
  }
  memory.lastDamage = me.damage;
  memory.mood += (memory.temper - memory.mood) * Math.min(1, MOOD_SETTLE * DT);
}

/**
 * The foe it is after: the one it has until it is time to pick again (or that one leaves), then the best by distance,
 * damage, grudge and crowding, with a little chance in it. Sometimes it roams to a platform first. Kept current even
 * while it is off the level. Null when alone.
 */
function pickTarget(view: SimView, rng: Rng, memory: BrainMemory): StageFighter | null {
  const me = view.self, p = me.mover.pos, t = view.t;
  let cur: StageFighter | null = null;
  for (const o of view.others) if (o.id === memory.target && o.action !== 'out') cur = o;
  if (cur && t < memory.retargetT) return cur;

  let best: StageFighter | null = null, bestScore = Infinity;
  for (const o of view.others) {
    if (o === me || o.action === 'out') continue;
    const q = o.mover.pos;
    let score = Math.hypot(q.x - p.x, (q.y - p.y) * TARGET_HEIGHT) - o.damage * DAMAGE_PULL + rng() * TARGET_NOISE;
    if (o.id === memory.grudge && t < memory.grudgeT) score -= GRUDGE_PULL;
    if (o === cur) score -= LOYALTY;
    if (o.mover.ground === null && !groundBelow(plats, q.x, q.y)) score += OFFSTAGE_COST;
    for (const g of view.others) {
      if (g !== o && g.action !== 'out' && Math.abs(g.mover.pos.x - q.x) < CROWD_NEAR && Math.abs(g.mover.pos.y - q.y) < CROWD_NEAR) score += CROWD_COST;
    }
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  memory.target = best?.id ?? null;
  memory.retargetT = t + RETARGET_MIN + rng() * RETARGET_SPREAD;
  if (best && memory.goal === null && !near(me, best, ENGAGE_NEAR) && rng() < ROAM_CHANCE * (0.5 + memory.roamer)) {
    pickSpot(view, rng, memory, ROAM_TIME + rng() * ROAM_SPREAD);
  }
  return best;
}

/** Whether `o` is within `d` of `me` (m, either way). */
function near(me: StageFighter, o: StageFighter, d: number): boolean {
  return Math.abs(o.mover.pos.x - me.mover.pos.x) < d && Math.abs(o.mover.pos.y - me.mover.pos.y) < d;
}

/** Chooses a platform it can reach and a spot on it to go to, giving up after `time` s. */
function pickSpot(view: SimView, rng: Rng, memory: BrainMemory, time: number): void {
  const me = view.self, m = me.mover;
  const g = plats[Math.floor(rng() * plats.length)];
  // (a bouncy bed is no place to stand)
  if (!g || g.bounce) return;
  const here = m.ground ?? platformUnder(plats, m.pos.x, m.pos.y);
  if (here !== null && here !== g.id && !route(navGraph(view.level, me.stats.moves), here, g.id)) return;
  const room = Math.max(0, g.w / 2 - m.w / 2 - LEDGE_IN);
  memory.goal = g.id;
  memory.goalX = (rng() * 2 - 1) * room;
  memory.goalUntil = view.t + time;
}

/**
 * Off the level: drift back toward the nearest ledge and jump (the air jump, then the recovery leap) only when falling
 * low enough, keeping back part of what the jumps left could lift it so no rise is spent far out. Under a solid
 * platform's lip it never jumps (it would only bump its head): it drifts out past the side first.
 */
function recover(view: SimView, memory: BrainMemory): void {
  const me = view.self, m = me.mover, p = m.pos, s = me.stats.moves, g = view.level.gravity;
  const goal = nearestLedge(plats, p.x, p.y, m.w, m.h);
  steer(me, memory.intent, goal.x, false);
  if (m.vel.y > 0 || underSolid(plats, p.x, p.y, m.w, m.h)) return;
  const hAir = (s.airJump * s.airJump) / (2 * g), hRec = (s.recovery * s.recovery) / (2 * g);
  const rises = m.airJumpsLeft * hAir + (m.recoveryUsed ? 0 : hRec);
  if (rises <= 0) return;
  press.jump = p.y < goal.y + RECOVER_ABOVE - rises * LATER_SHARE;
}

/**
 * Whether the link under way can still be made from out over a gap: its platform's top is not above the feet, or it
 * is still rising, or it has an air jump left.
 */
function makingIt(view: SimView, memory: BrainMemory): boolean {
  const m = view.self.mover, b = memory.link ? find(plats, memory.link.to) : null;
  return b !== null && (m.pos.y >= b.y - ON_TOP || m.vel.y > 0 || m.airJumpsLeft > 0);
}

/**
 * Whether it is in the air on its way up to a platform with an air jump still to use: it finishes the climb before
 * swinging (a swing would spend the jump's rise).
 */
function climbing(view: SimView, memory: BrainMemory): boolean {
  const m = view.self.mover, b = memory.link ? find(plats, memory.link.to) : null;
  return m.ground === null && b !== null && b.y > m.pos.y && m.airJumpsLeft > 0;
}

/**
 * Dodges, by chance, a foe's wind-up aimed at it (an attack's, or a special's while it charges): rolling away on the
 * ground or a sidestep in place.
 */
function dodge(view: SimView, rng: Rng, memory: BrainMemory): boolean {
  const me = view.self, m = me.mover, p = m.pos;
  for (const o of view.others) {
    if (o.action === 'special' && o.actionT < o.kit.charge) {
      const side = o.facing;
      if (!inSpecialReach(o, aimOf(o.stats, o.kit, view.level.gravity), me, side)) continue;
      if (rng() >= SPECIAL_DODGE + DODGE_CALM * (1 - memory.mood)) return false;
      press.dodge = true;
      // a roll toward it, through the blow while it cannot be hit
      if (m.ground !== null && rng() < 0.5) memory.intent.mx = -side;
      return true;
    }
    const a = o.attack;
    if (o.action !== 'attack' || !a || o.actionT >= a.windup) continue;
    const dx = p.x - o.mover.pos.x;
    if (!a.around && dx !== 0 && Math.sign(dx) !== o.facing) continue;
    if (Math.abs(dx) > a.area.dx + a.area.r + m.w / 2 + DODGE_RANGE) continue;
    if (Math.abs(p.y - o.mover.pos.y) > Math.max(m.h, o.mover.h)) continue;
    if (rng() >= DODGE_BASE + DODGE_CALM * (1 - memory.mood)) return false;
    press.dodge = true;
    if (m.ground !== null && rng() < 0.5) memory.intent.mx = dx >= 0 ? 1 : -1;
    return true;
  }
  return false;
}

/**
 * A foe in reach (the target first, else anyone): face it and swing now and then, in the direction that reaches it.
 * Returns whether it is engaged (it holds its ground for the next swing). Now and then it swings at air at a foe just
 * out of reach (a mistake).
 */
function strike(view: SimView, rng: Rng, memory: BrainMemory, foe: StageFighter | null): boolean {
  const me = view.self, m = me.mover, p = m.pos, want = memory.intent;
  const grounded = m.ground !== null;
  let who: StageFighter | null = null, dir: AttackDir | null = null;
  if (foe) {
    dir = reaches(me, foe, grounded, view.level.gravity);
    if (dir) who = foe;
  }
  if (!dir) {
    for (const o of view.others) {
      if (o === foe || o.action === 'out' || o.action === 'frozen') continue;
      dir = reaches(me, o, grounded, view.level.gravity);
      if (dir) {
        who = o;
        break;
      }
    }
  }
  if (!who || !dir) {
    if (!foe || view.t < memory.mistakeT) return false;
    const q = foe.mover.pos, dx = q.x - p.x;
    if (Math.abs(dx) > me.stats.reach + foe.mover.w / 2 + WHIFF_NEAR || Math.abs(q.y - p.y) > m.h || rng() >= WHIFF_CHANCE) return false;
    memory.mistakeT = view.t + MISTAKE_REST + rng() * MISTAKE_SPREAD;
    want.mx = dx >= 0 ? 1 : -1;
    press.attack = true;
    return true;
  }
  const side = who.mover.pos.x >= p.x ? 1 : -1;
  if (!grounded || me.facing !== side) want.mx = side;
  if (rng() < ATTACK_CHANCE * (0.75 + 0.5 * memory.mood)) {
    press.attack = true;
    want.my = dir === 'up' ? 1 : dir === 'down' ? -1 : 0;
  }
  return true;
}

/**
 * Which of its attacks would reach `o` if it swung now (facing `o`), or null: up at a foe above, the low attack at a
 * short one, else the signature swing; in the air the air attack (or up). Where both move, it guesses ahead to the
 * strike.
 */
function reaches(me: StageFighter, o: StageFighter, grounded: boolean, gravity: number): AttackDir | null {
  // (its attacks as they are now: a pool noodle reaches further, a grown body further still)
  const set = me.attackSet(), m = me.mover, q = o.mover.pos;
  const above = q.y > m.pos.y + m.h * UP_SHARE;
  if (grounded) {
    if (above && hits(me, set.up, o, true, gravity)) return 'up';
    if (o.mover.h < m.h * LOW_SHARE && hits(me, set.down, o, true, gravity)) return 'down';
    if (hits(me, set.forward, o, true, gravity)) return 'forward';
    if (hits(me, set.down, o, true, gravity)) return 'down';
    if (hits(me, set.up, o, true, gravity)) return 'up';
    return null;
  }
  if (above && hits(me, set.up, o, false, gravity)) return 'up';
  if (hits(me, set.air, o, false, gravity)) return 'air';
  if (hits(me, set.up, o, false, gravity)) return 'up';
  return null;
}

/** Whether attack `a`, swung now toward `o`, would reach into its box at the middle of the strike. */
function hits(me: StageFighter, a: Attack, o: StageFighter, grounded: boolean, gravity: number): boolean {
  const m = me.mover, q = o.mover;
  const lead = (a.windup + a.active / 2) * DT;
  const side = q.pos.x >= m.pos.x ? 1 : -1;
  const ox = q.pos.x + q.vel.x * lead * FOE_LEAD, oy = q.pos.y + q.vel.y * lead * FOE_LEAD;
  const sx = m.pos.x + (grounded ? 0 : m.vel.x * lead);
  const sy = m.pos.y + (grounded ? 0 : m.vel.y * lead - (gravity * lead * lead) / 2);
  const cx = sx + side * a.area.dx, cy = sy + a.area.dy, r = a.area.r - REACH_SURE;
  const nx = Math.max(ox - q.w / 2, Math.min(cx, ox + q.w / 2)), ny = Math.max(oy, Math.min(cy, oy + q.h));
  return (cx - nx) ** 2 + (cy - ny) ** 2 <= r * r;
}

/**
 * Goes after `foe`: to the platform it is on (or over), by the route; a foe off the level is waited for at the ledge.
 * On its floor it now and then hops in with an air attack, and it jumps at a foe in the air above.
 */
function chase(view: SimView, rng: Rng, memory: BrainMemory, foe: StageFighter): void {
  const me = view.self, m = me.mover, p = m.pos, q = foe.mover.pos;
  const there = foe.mover.ground ?? platformUnder(plats, q.x, q.y);
  const dx = q.x - p.x, dy = q.y - p.y;
  if (m.ground !== null) {
    const leap = dy > FLOOR_GAP && Math.abs(dx) < JUMP_NEAR && foe.mover.ground === null && rng() < JUMP_CHANCE;
    const hop = Math.abs(dy) < FLOOR_GAP / 2 && Math.abs(dx) > HOP_MIN && Math.abs(dx) < HOP_MAX && rng() < HOP_CHANCE;
    if (leap || hop) {
      press.jump = true;
      steer(me, memory.intent, q.x);
      return;
    }
  }
  goTo(view, rng, memory, foe, there, q.x);
}

/**
 * Alone: strut from spot to spot about the level (up and down the platforms), and on reaching each one pose a moment
 * (`showoff`), sometimes with a flourish (a jump and a swing at the top).
 */
function strut(view: SimView, rng: Rng, memory: BrainMemory): void {
  const m = view.self.mover, t = view.t, want = memory.intent;
  if (memory.flourish) {
    if (m.ground !== null) press.jump = true;
    else if (m.vel.y < AIR_JUMP_AT) {
      press.attack = true;
      want.my = rng() < 0.5 ? 1 : 0;
      memory.flourish = false;
    }
    return;
  }
  if (t < memory.pauseUntil) {
    memory.showoff = m.ground !== null;
    return;
  }
  if (memory.goal === null || t > memory.goalUntil) pickSpot(view, rng, memory, STRUT_TIME);
  const g = memory.goal === null ? null : find(plats, memory.goal);
  if (!g) {
    memory.goal = null;
    return;
  }
  if (goTo(view, rng, memory, null, g.id, g.x + memory.goalX)) {
    memory.goal = null;
    memory.pauseUntil = t + PAUSE_MIN + rng() * PAUSE_SPREAD;
    memory.flourish = rng() < FLOURISH_CHANCE;
  }
}

/**
 * Heads for spot `x` on platform `to` (null: stay on this floor, as near `x` as is safe): along its own floor, or by
 * the route's next link. In the air it steers the link under way. Returns true once standing there.
 */
function goTo(view: SimView, rng: Rng, memory: BrainMemory, foe: StageFighter | null, to: string | null, x: number): boolean {
  const me = view.self, m = me.mover, p = m.pos, want = memory.intent;
  if (m.ground === null) {
    inAir(view, memory, foe, x);
    return false;
  }
  const here = m.ground;
  const hp = find(plats, here);
  if (to === null || to === here || !hp) {
    const gx = to === here || !hp ? x : clampInto(hp, x, m.w / 2 + LEDGE_IN);
    steer(me, want, gx);
    return to === here && Math.abs(gx - p.x) < ARRIVE;
  }
  // (planned again when gravity changes, too: a low-gravity jump is no way once gravity is back; and when a power-up
  // changes how it moves: ruling R27)
  if (memory.planFrom !== here || memory.planTo !== to || memory.planLevel !== view.level || memory.planMoves !== me.stats.moves) {
    memory.plan = bestRoute(view, here, to);
    memory.planFrom = here;
    memory.planTo = to;
    memory.planLevel = view.level;
    memory.planMoves = me.stats.moves;
  }
  if (memory.plan.length === 0) steer(me, want, clampInto(hp, x, m.w / 2 + LEDGE_IN));
  else takeLink(view, rng, memory, memory.plan[0]);
  return false;
}

/** The cheapest route from `here` to `to`, counting the walk to its first platform, never back through `here`; [] if there is none. */
function bestRoute(view: SimView, here: string, to: string): NavLink[] {
  const graph = navGraph(view.level, view.self.stats.moves), x = view.self.mover.pos.x;
  let best: NavLink[] = [], bestCost = Infinity;
  for (const l of graph) {
    if (l.from !== here) continue;
    const rest = route(graph, l.to, to);
    const next = find(plats, l.to);
    // (a route that comes back through here goes round in a circle: one step there and back onto a lift, say)
    if (!rest || !next || rest.some((r) => r.to === here)) continue;
    let cost = NAV_COST[l.how] + Math.abs(next.x - x) * DIST_COST;
    for (const r of rest) cost += NAV_COST[r.how];
    if (cost < bestCost) {
      bestCost = cost;
      best = [l, ...rest];
    }
  }
  return best;
}

/**
 * Takes link `l` from the platform it stands on: walks across; drops through a thin floor where the one below is
 * under it, or steps off the edge on its side; for a jump, goes to a take-off spot (under a thin platform, beside a
 * solid one; for a moving one, where it will be by the top of the jump, waiting for it if need be) and jumps. Now and
 * then it jumps too early (a mistake).
 */
function takeLink(view: SimView, rng: Rng, memory: BrainMemory, l: NavLink): void {
  const me = view.self, m = me.mover, p = m.pos, want = memory.intent;
  const a = find(plats, l.from), b = find(plats, l.to);
  if (!a || !b) return;
  if (l.how === 'walk') {
    // A walk onto a moving platform that is not level with this one now (a lift away up): jump to it instead, or
    // wait for it below.
    if (!b.path || Math.abs(b.y - a.y) <= ON_TOP) {
      steer(me, want, b.x);
      return;
    }
    const s = me.stats.moves, h1 = (s.jump * s.jump) / (2 * view.level.gravity);
    l = { from: l.from, to: l.to, how: b.y - a.y + CLEAR <= h1 ? 'jump' : 'airJump' };
  }
  if (l.how === 'drop') {
    const half = m.w / 2 + LAND_IN;
    let lo = Math.max(a.x - a.w / 2, b.x - b.w / 2) + half, hi = Math.min(a.x + a.w / 2, b.x + b.w / 2) - half;
    const side = stepOff(a, b, me.stats.moves, view.level.gravity);
    // Through a thin one with no edge to step off by, where the floor below is too narrow for that spot (on a moving
    // one after a short wait for a better moment): wherever its box is well over any part of that floor.
    if (a.kind === 'thin' && lo > hi && side === 0 && (!a.path || waited(view.t, memory, l))) {
      lo = Math.max(a.x - a.w / 2, b.x - b.w / 2) + DROP_EDGE;
      hi = Math.min(a.x + a.w / 2, b.x + b.w / 2) - DROP_EDGE;
    }
    if (a.kind === 'thin' && lo <= hi) {
      // (within the steering's slack of the spot: steering lets go that close)
      if (p.x >= lo - GOAL_SLACK && p.x <= hi + GOAL_SLACK) {
        press.down = true;
        memory.link = l;
      } else steer(me, want, Math.max(lo, Math.min(p.x, hi)));
    } else if (side !== 0) {
      // Step off the edge the lower floor is past.
      want.mx = side;
      memory.link = l;
      steppingOff = true;
    } else if (a.path) {
      // Riding a moving platform, it waits (at the end nearer that floor) until stepping off would land on it.
      steer(me, want, clampInto(a, b.x, m.w / 2 + EDGE_LOOK));
    } else {
      const outL = a.x - a.w / 2 - (b.x - b.w / 2), outR = b.x + b.w / 2 - (a.x + a.w / 2);
      want.mx = outR > outL ? 1 : -1;
      memory.link = l;
    }
    return;
  }

  const bf = b.path ? find(platformsAt(view.level, view.t + (l.how === 'jump' ? LEAD_JUMP : LEAD_AIR), ahead), b.id) ?? b : b;
  const al = a.x - a.w / 2 + m.w / 2 + EDGE_LOOK, ar = a.x + a.w / 2 - m.w / 2 - EDGE_LOOK;
  let lo: number, hi: number;
  if (bf.kind === 'thin' || bf.y < a.y) {
    const inset = Math.min(bf.w / 2, m.w / 2 + LAND_IN);
    lo = Math.max(al, bf.x - bf.w / 2 + inset - TAKEOFF_DRIFT);
    hi = Math.min(ar, bf.x + bf.w / 2 - inset + TAKEOFF_DRIFT);
  } else {
    // Beside a solid one, on the side nearer it (or the other if that side has no room).
    const sl = bf.x - bf.w / 2 - m.w / 2 - SIDE_GAP, sr = bf.x + bf.w / 2 + m.w / 2 + SIDE_GAP;
    const leftOk = sl >= al, rightOk = sr <= ar;
    const left = leftOk && (!rightOk || Math.abs(p.x - sl) <= Math.abs(p.x - sr));
    lo = left ? Math.max(al, sl - TAKEOFF_DRIFT) : rightOk ? sr : Infinity;
    hi = left ? sl : rightOk ? Math.min(ar, sr + TAKEOFF_DRIFT) : -Infinity;
  }
  let gx: number, ready: boolean;
  if (lo <= hi) {
    gx = Math.max(lo, Math.min(p.x, hi));
    ready = true;
  } else {
    // Out of reach of a take-off spot: a gap is jumped from the edge. With either platform moving it waits at the
    // nearest point until the gap is one the jump can drift across.
    gx = Math.max(al, Math.min(bf.x, ar));
    const gap = Math.max(0, Math.max(a.x - a.w / 2, bf.x - bf.w / 2) - Math.min(a.x + a.w / 2, bf.x + bf.w / 2));
    // (no reach at all: the top is too high for its jumps just now)
    const reach = jumpReach(me.stats.moves, view.level.gravity, bf.y - a.y, l.how === 'jump' ? 'jump' : 'airJump');
    ready = (!a.path && !b.path) || (reach > 0 && gap <= reach);
  }
  const off = Math.abs(p.x - gx);
  if (ready && off <= TAKEOFF_SLACK) {
    press.jump = true;
    memory.link = l;
    if (bf.kind === 'thin') steer(me, want, Math.max(bf.x - bf.w / 2, Math.min(p.x, bf.x + bf.w / 2)));
    return;
  }
  steer(me, want, gx);
  if (view.t >= memory.mistakeT && off < EARLY_NEAR && rng() < EARLY_CHANCE) {
    press.jump = true;
    memory.link = l;
    memory.mistakeT = view.t + MISTAKE_REST + rng() * MISTAKE_SPREAD;
  }
}

/**
 * In the air: steer the link under way onto its platform (round the side of a solid one first, air jumping if the
 * jump will not reach up to it or across to it), else toward `x`, air jumping at a foe above; never drift off the level.
 */
function inAir(view: SimView, memory: BrainMemory, foe: StageFighter | null, x: number): void {
  const me = view.self, m = me.mover, p = m.pos, want = memory.intent, g = view.level.gravity;
  const b = memory.link ? find(plats, memory.link.to) : null;
  if (b) {
    const inset = Math.min(b.w / 2, m.w / 2 + LAND_IN);
    const below = p.y < b.y + ON_TOP;
    const across = p.x + m.w / 2 > b.x - b.w / 2 && p.x - m.w / 2 < b.x + b.w / 2;
    if (b.kind === 'solid' && below && across) want.mx = p.x < b.x ? -1 : 1;
    else steer(me, want, Math.max(b.x - b.w / 2 + inset, Math.min(p.x, b.x + b.w / 2 - inset)));
    const apex = p.y + Math.max(0, m.vel.y) ** 2 / (2 * g);
    if (m.vel.y < AIR_JUMP_AT && m.airJumpsLeft > 0) {
      if (b.y > p.y - ON_TOP) press.jump = apex < b.y + CLEAR;
      else {
        // Below: air jump if it would come down to that top before drifting over it.
        const lo = b.x - b.w / 2 + inset, hi = b.x + b.w / 2 - inset;
        const across = p.x < lo ? lo - p.x : p.x > hi ? p.x - hi : 0;
        const fall = (m.vel.y + Math.sqrt(m.vel.y * m.vel.y + 2 * g * (p.y - b.y))) / g;
        press.jump = across > me.stats.moves.run * fall;
      }
    }
    return;
  }
  // Aim over ground (a spot past or right by an edge becomes the nearest ledge), and turn back if drifting off:
  // steering to a safe spot from the start, it never flips between the two.
  const edge = x + (x > p.x ? 1 : -1) * EDGE_LOOK;
  const gx = groundBelow(plats, x, p.y) && groundBelow(plats, edge, p.y) ? x : nearestLedge(plats, x, p.y, m.w, m.h).x;
  steer(me, want, gx);
  // (the airlock's pull counts)
  const drift = view.mischief?.driftOn(me) ?? 0;
  if (!groundBelow(plats, p.x + (m.vel.x + drift) * AIR_LOOK, p.y)) steer(me, want, nearestLedge(plats, p.x, p.y, m.w, m.h).x);
  if (foe) {
    const q = foe.mover.pos;
    if (q.y - p.y > FLOOR_GAP && Math.abs(q.x - p.x) < JUMP_NEAR && m.vel.y < AIR_JUMP_AT && m.airJumpsLeft > 0) press.jump = true;
  }
}

/** Counts the time spent in a row waiting to take link `l` (s); true once it reaches DROP_WAIT. */
function waited(t: number, memory: BrainMemory, l: NavLink): boolean {
  if (memory.waitLink !== l || t - memory.waitLast > 1.5 * DT) {
    memory.waitLink = l;
    memory.waitSince = t;
  }
  memory.waitLast = t;
  return t - memory.waitSince >= DROP_WAIT;
}

/**
 * On a vine: swing at a foe in reach; else let go (a jump) while swinging toward where it is going (its target, or
 * the spot it is roaming to) fast enough, with ground ahead to land on; with nowhere to go, now and then. The vine lets
 * go of it anyway after a while.
 */
function rideVine(view: SimView, rng: Rng, memory: BrainMemory, foe: StageFighter | null): void {
  const m = view.self.mover, p = m.pos;
  memory.link = null;
  memory.vine = -1;
  if (strike(view, rng, memory, foe)) return;
  const spot = memory.goal !== null ? find(plats, memory.goal) : null;
  const goal = foe ? foe.mover.pos.x : spot ? spot.x + memory.goalX : null;
  const vx = m.vel.x;
  if (!groundBelow(plats, p.x + vx * LET_GO_LOOK, p.y)) return;
  const go = goal === null ? rng() < LET_GO_IDLE : (goal - p.x) * vx > 0 && Math.abs(vx) >= LET_GO_SPEED && rng() < LET_GO_CHANCE;
  if (go) press.jump = true;
}

/**
 * While the vines are out, now and then (no foe close) it goes for a free one: to the floor under the vine's swing
 * (one from which its jumps reach the grip), then a jump as the grip swings near, steering into it and air jumping up
 * to it. It gives up after a while, or when someone else takes the vine. Returns whether it is going for one.
 */
function seekVine(view: SimView, rng: Rng, memory: BrainMemory, foe: StageFighter | null): boolean {
  const mis = view.mischief, me = view.self, m = me.mover, p = m.pos, t = view.t, want = memory.intent;
  const n = mis ? mis.vineCount() : 0;
  if (!mis || n === 0) {
    memory.vine = -1;
    return false;
  }
  if (memory.vine >= 0 && (t > memory.vineUntil || mis.vineTaken(memory.vine))) memory.vine = -1;
  const s = me.stats.moves, g = view.level.gravity;
  const rise = (s.jump * s.jump + s.airJumps * s.airJump * s.airJump) / (2 * g) - CLEAR;
  if (memory.vine < 0) {
    if (m.ground === null || (foe && near(me, foe, ENGAGE_NEAR)) || rng() >= VINE_CHANCE) return false;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const v = mis.vine(i)!, bottom = v.y - v.length;
      const under = platformUnder(plats, v.x, bottom - m.h), from = under === null ? null : find(plats, under);
      if (mis.vineTaken(i) || !from || bottom - (from.y + m.h) > rise) continue;
      const d = Math.abs(v.x - p.x) + Math.abs(from.y - p.y) * HEIGHT_WEIGHT;
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    }
    if (best < 0) return false;
    memory.vine = best;
    memory.vineUntil = t + VINE_TIME;
  }
  const v = mis.vine(memory.vine)!, grip = mis.grip(memory.vine, t + VINE_LEAD, vineAt)!;
  if (m.ground !== null) {
    const from = platformUnder(plats, v.x, v.y - v.length - m.h);
    if (from !== m.ground) {
      goTo(view, rng, memory, foe, from, v.x);
      return true;
    }
    if (Math.abs(grip.x - p.x) < VINE_NEAR) press.jump = true;
    else steer(me, want, v.x);
    return true;
  }
  if (memory.link) {
    inAir(view, memory, foe, v.x);
    return true;
  }
  steer(me, want, grip.x, false);
  const apex = p.y + m.h + Math.max(0, m.vel.y) ** 2 / (2 * g);
  if (m.vel.y < AIR_JUMP_AT && m.airJumpsLeft > 0 && apex < grip.y) press.jump = true;
  return true;
}

/** The toy train coming at it along its floor: a hop over it just before it arrives, or an air jump falling onto it. */
function dodgeTrain(view: SimView, rng: Rng): void {
  const tr = view.mischief?.train(trainAt);
  if (!tr) return;
  const m = view.self.mover, p = m.pos;
  if (p.y >= tr.y + tr.h + TRAIN_CLEAR || p.y + m.h <= tr.y) return;
  const gap = tr.dir > 0 ? p.x - m.w / 2 - (tr.x + tr.w / 2) : tr.x - tr.w / 2 - (p.x + m.w / 2);
  if (gap < 0 || gap > tr.speed * TRAIN_LEAD) return;
  if (m.ground !== null) {
    if (rng() < TRAIN_HOP) press.jump = true;
  } else if (m.vel.y < 0 && m.airJumpsLeft > 0) press.jump = true;
}

/**
 * After standing still a while, a little step one way or the other (never off the level): no standing about. The step
 * has the stick for its short while, so stepping back to the spot does not fight it.
 */
function fidget(view: SimView, rng: Rng, memory: BrainMemory): void {
  const want = memory.intent, m = view.self.mover, t = view.t;
  if (press.jump || press.attack || press.down || press.dodge) return;
  if (want.mx === 0 && memory.stillT > STILL_FIDGET && t >= memory.fidgetUntil) {
    memory.fidgetUntil = t + FIDGET_TIME;
    memory.fidgetDir = rng() < 0.5 ? -1 : 1;
    memory.stillT = 0;
  }
  if (t >= memory.fidgetUntil) return;
  if (!groundBelow(plats, m.pos.x + memory.fidgetDir * (m.w / 2 + EDGE_LOOK), m.pos.y)) memory.fidgetDir = memory.fidgetDir === 1 ? -1 : 1;
  want.mx = memory.fidgetDir * FIDGET_STICK;
}

/**
 * Points the stick toward x = `goal` (left alone when already there). With `brake`, it lets go once its own braking
 * will stop it there, so it does not overshoot and turn back (no flip-flopping on the spot).
 */
function steer(me: StageFighter, want: Intent, goal: number, brake = true): void {
  const m = me.mover, d = goal - m.pos.x;
  if (Math.abs(d) <= GOAL_SLACK) return;
  if (brake && m.vel.x * d > 0) {
    const accel = m.ground !== null ? me.stats.moves.accel : me.stats.moves.airAccel;
    if ((m.vel.x * m.vel.x) / (2 * accel) >= Math.abs(d)) return;
  }
  want.mx = d > 0 ? 1 : -1;
}

/** `x` kept at least `inset` in from the edges of platform `p` (its centre if it is narrower than that). */
function clampInto(p: Platform, x: number, inset: number): number {
  const lo = p.x - p.w / 2 + inset, hi = p.x + p.w / 2 - inset;
  return lo > hi ? p.x : Math.max(lo, Math.min(x, hi));
}

function find(ps: readonly Platform[], id: string): Platform | null {
  for (const p of ps) if (p.id === id) return p;
  return null;
}

/** Whether some platform's top is under x at or below height y (something to land on). */
function groundBelow(ps: readonly Platform[], x: number, y: number): boolean {
  for (const p of ps) if (Math.abs(x - p.x) <= p.w / 2 && p.y <= y + ON_TOP) return true;
  return false;
}

/** The platform it would land on falling from (x, y): the highest top under x at or below y, or null. */
function platformUnder(ps: readonly Platform[], x: number, y: number): string | null {
  let best: Platform | null = null;
  for (const p of ps) if (Math.abs(x - p.x) <= p.w / 2 && p.y <= y + ON_TOP && (!best || p.y > best.y)) best = p;
  return best?.id ?? null;
}

/** Whether the box (bottom centre x, y; w × h) is under a solid platform's underside: a jump would bump its head. */
function underSolid(ps: readonly Platform[], x: number, y: number, w: number, h: number): boolean {
  for (const p of ps) {
    if (p.kind === 'solid' && y + h <= p.y - p.h + ON_TOP && x + w / 2 > p.x - p.w / 2 && x - w / 2 < p.x + p.w / 2) return true;
  }
  return false;
}

/**
 * Where to steer to get back onto the nearest platform: x a little in from its nearer ledge (or round its side when
 * underneath a solid one) and y its top. Platforms above count as further away (they need the climb). The same object
 * every call.
 */
function nearestLedge(ps: readonly Platform[], x: number, y: number, w: number, h: number): { x: number; y: number } {
  let best = Infinity;
  ledge.x = x;
  ledge.y = y;
  for (const p of ps) {
    const l = p.x - p.w / 2, r = p.x + p.w / 2, inset = Math.min(LEDGE_IN, p.w / 2);
    const under = p.kind === 'solid' && y + h <= p.y - p.h + ON_TOP && x > l - w / 2 && x < r + w / 2;
    const g = under ? (x < p.x ? l - w : r + w) : Math.max(l + inset, Math.min(x, r - inset));
    const cost = Math.abs(g - x) + Math.max(0, p.y - y) * HEIGHT_WEIGHT;
    if (cost < best) {
      best = cost;
      ledge.x = g;
      ledge.y = p.y;
    }
  }
  return ledge;
}
