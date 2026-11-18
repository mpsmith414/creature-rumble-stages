import type { Move } from '../fight/types';
import type { BodyStats } from './body';

/**
 * Which way an attack goes, from the stick: forward (the body's signature swing), up (over its head), down (a quick
 * low sweep) or, in the air, the air attack (stick up in the air is still the up attack).
 */
export type AttackDir = 'forward' | 'up' | 'down' | 'air';

/**
 * One attack: its wind-up, active and cool-down steps (the hit area exists only while active), how hard it launches
 * (`power`, × the knockback curve), the damage it adds, the launch angle in degrees from the attacker's facing (0
 * straight ahead, 90 straight up, negative downward), and its hit circle relative to the attacker's box: `dx` ahead
 * along the facing and `dy` up from the box's bottom centre, radius `r` (m). An `around` attack is centred on the body
 * and pushes away from it on either side.
 */
export type Attack = {
  windup: number;
  active: number;
  cool: number;
  power: number;
  damage: number;
  angle: number;
  area: { dx: number; dy: number; r: number };
  around: boolean;
};

/**
 * A table row: windup, active, cool (steps), power, damage, angle (°), then the area: ahead in units of the body's
 * weapon reach, up in units of its box height, radius in units of the larger of the two (0 ahead = around the body).
 */
type Row = readonly [number, number, number, number, number, number, number, number, number];

/**
 * Every move's four attacks. Forward is the signature swing (big fists punch hard, tiny ones jab fast, long legs kick
 * far, round bodies bump, horns butt at head height, tails sweep all around, wings swipe); up hits above for floors
 * overhead, down is the quick low attack, air is the attack in a jump (wings dive at a downward angle).
 */
const TABLE: Record<Move, Record<AttackDir, Row>> = {
  punch: {
    forward: [9, 4, 14, 1.25, 5.5, 38, 0.75, 0.6, 0.3],
    up: [6, 4, 12, 1, 4, 85, 0.3, 1, 0.32],
    down: [4, 3, 10, 0.75, 2.5, 30, 0.6, 0.2, 0.25],
    air: [5, 4, 12, 0.95, 3.5, 40, 0.6, 0.5, 0.3],
  },
  jab: {
    forward: [3, 3, 7, 1.1, 3, 30, 0.6, 0.55, 0.3],
    up: [3, 3, 8, 1, 3, 85, 0.2, 1, 0.3],
    down: [3, 2, 7, 0.7, 2, 25, 0.6, 0.2, 0.28],
    air: [3, 3, 8, 1, 3, 40, 0.5, 0.5, 0.32],
  },
  kick: {
    forward: [10, 4, 14, 1.1, 5, 40, 0.65, 0.4, 0.3],
    up: [6, 4, 12, 1, 4, 82, 0.35, 0.95, 0.3],
    down: [5, 3, 10, 0.8, 3, 28, 0.7, 0.12, 0.25],
    air: [5, 5, 12, 1, 4, 35, 0.7, 0.3, 0.3],
  },
  bump: {
    forward: [8, 5, 14, 1.3, 4.5, 35, 0.6, 0.45, 0.4],
    up: [7, 4, 13, 1, 4, 85, 0.1, 1, 0.38],
    down: [5, 4, 11, 0.8, 3, 30, 0, 0.15, 0.45],
    air: [6, 5, 12, 1, 4, 25, 0, 0.1, 0.42],
  },
  headbutt: {
    forward: [9, 4, 15, 1.25, 5, 32, 0.8, 0.8, 0.3],
    up: [6, 4, 12, 1.1, 4.5, 88, 0.2, 1.05, 0.32],
    down: [5, 3, 10, 0.8, 2.5, 30, 0.6, 0.25, 0.26],
    air: [5, 4, 12, 1, 4, 38, 0.7, 0.7, 0.3],
  },
  spin: {
    forward: [7, 8, 14, 1.05, 4, 40, 0, 0.4, 0.6],
    up: [6, 5, 12, 0.95, 3.5, 80, 0, 0.9, 0.5],
    down: [5, 4, 11, 0.8, 3, 28, 0, 0.1, 0.55],
    air: [5, 6, 12, 0.95, 3.5, 40, 0, 0.45, 0.55],
  },
  divebomb: {
    forward: [8, 5, 14, 1.15, 4.5, 35, 0.8, 0.5, 0.32],
    up: [6, 4, 12, 1, 4, 85, 0.2, 1, 0.35],
    down: [4, 3, 10, 0.75, 2.5, 30, 0.6, 0.2, 0.26],
    air: [6, 5, 12, 0.95, 4, -35, 0.5, 0.1, 0.32],
  },
};

/** No hit circle is smaller than this (m), so even the tiniest body can land a hit. */
const MIN_RADIUS = 0.32;

/** The attack a body with this signature `move` does in direction `dir`, its hit area sized from the body. */
export function attackFor(move: Move, dir: AttackDir, stats: BodyStats): Attack {
  const [windup, active, cool, power, damage, angle, ahead, up, radius] = TABLE[move][dir];
  const size = Math.max(stats.h, stats.reach);
  return {
    windup, active, cool, power, damage, angle,
    area: { dx: ahead * stats.reach, dy: up * stats.h, r: Math.max(MIN_RADIUS, radius * size) },
    around: ahead === 0,
  };
}

const sets = new WeakMap<BodyStats, Record<AttackDir, Attack>>();

/** The body's four attacks, worked out once per body (the same object every call: do not change it). */
export function attackSet(stats: BodyStats): Record<AttackDir, Attack> {
  let set = sets.get(stats);
  if (!set) {
    set = {
      forward: attackFor(stats.move, 'forward', stats), up: attackFor(stats.move, 'up', stats),
      down: attackFor(stats.move, 'down', stats), air: attackFor(stats.move, 'air', stats),
    };
    sets.set(stats, set);
  }
  return set;
}
