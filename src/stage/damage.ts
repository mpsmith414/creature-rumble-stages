/**
 * Hidden damage and how far it sends a creature flying. Every hit adds damage; the more a creature has, the faster a
 * hit launches it, so knockouts come from big launches off the level. Heavier creatures launch less. All the fight's
 * timing and launch numbers live in `STAGE_TUNE`, so the balance tool can tune them in one place (steps are fight
 * steps of 1/60 s).
 */
export const STAGE_TUNE = {
  /** Steps both creatures freeze for when a hit lands, so every hit reads. */
  hitFreeze: 4,
  /**
   * Damage at which the look steps up: warm (pink), hot (red, sweat), about to fly (deep red, steam). "About to fly" is
   * about where knockouts start (a quarter of them come below it: Task 16's balance, knockouts at 101/125/155 damage
   * at the 10th/25th/50th percentile), so it warns before most of them.
   */
  damageSteps: [40, 80, 125] as [number, number, number],
  /** Launch speed (m/s) of a power-1 hit on an average-weight creature with no damage… */
  kbBase: 5,
  /**
   * …plus this much per point of damage: 100 damage launches at 14.5 m/s, 200 at 24 m/s (enough to fly off from near
   * an edge; a special, twice as hard, from further in). Damage builds over many hits, so a fight is a long back and
   * forth: four-way bouts see the first knockout at ~44 s on the test level and ~46–50 s on the themed levels, and
   * last ~100–110 s (Task 16, with presents and mischief).
   */
  kbGrowth: 0.095,
  /**
   * Launch speed ∝ weight^−this: the heaviest body (1.6) flies ×0.85 as fast, the lightest (0.6) ×1.2. Mild, so a tiny
   * creature is not knocked out by half the damage a big one takes, and a big one is still launched for real.
   */
  kbWeightExp: 0.35,
  /** A launch at least this fast (m/s) is a tumble (a clean spin, no control); slower is a short stagger. */
  tumbleFrom: 11,
  /**
   * In a special, a blow launching slower than this (m/s) only rocks the fighter and the special goes on; a faster one
   * knocks it out of it. Above `tumbleFrom`, so a special's wind-up is not lost to any ordinary hit once damage builds
   * (long wind-ups such as the Mega Punch's were nearly always knocked out of before they landed).
   */
  specialArmour: 18,
  /** Stagger (hitstun) length in steps: base + per m/s of launch. */
  hitstunBase: 10,
  hitstunPerSpeed: 0.8,
  /** Tumble length in steps: base + per m/s of launch (a 20 m/s launch tumbles 42 steps, 0.7 s). */
  tumbleBase: 18,
  tumblePerSpeed: 1.2,
  /**
   * A launch's sideways speed fades by this share per second in the air (smooth, so a launch reads as a clean arc): a
   * flight carries less far sideways, so only a big launch reaches the edge of the level.
   */
  airDrag: 1,
  /** A creature hit flat or downward while standing pops up at least this steeply (degrees), never into the floor. */
  groundLift: 20,
  /** Steps of the landing squash after coming down from the air (any action may start during it). */
  landSteps: 5,
  /** Share of its sideways speed a tumbling creature keeps when it lands (a thud, not a long slide). */
  tumbleLandKeep: 0.25,
  /** A dodge lasts this many steps and cannot be hit from step `dodgeSafeFrom` until before `dodgeSafeTo`. */
  dodgeSteps: 22,
  dodgeSafeFrom: 2,
  dodgeSafeTo: 14,
  /** A roll moves at this speed (m/s) while it cannot be hit. */
  dodgeRoll: 9,
  /** Steps after a dodge ends before the next one can start. */
  dodgeRest: 20,
};

export type StageTune = typeof STAGE_TUNE;

/**
 * How fast (m/s) a hit of this `power` launches a creature of this `weight` that has `damage` (counting the hit's own
 * damage). Grows with power and damage, shrinks with weight.
 */
export function knockback(power: number, damage: number, weight: number, tune: StageTune = STAGE_TUNE): number {
  return (power * (tune.kbBase + tune.kbGrowth * damage)) / weight ** tune.kbWeightExp;
}

/** Which damage look a creature shows: 0 fresh, 1 warm, 2 hot, 3 about to fly. */
export function damageStep(damage: number, tune: StageTune = STAGE_TUNE): 0 | 1 | 2 | 3 {
  const [warm, hot, fly] = tune.damageSteps;
  return damage >= fly ? 3 : damage >= hot ? 2 : damage >= warm ? 1 : 0;
}
