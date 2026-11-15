import type { Move } from './types';

/**
 * The fight's feel, from the spike the owner played (spec §3.2). Mutable: the dev sliders write it, and every fighter
 * and the arena read it live.
 */
export const TUNE = {
  /**
   * × every hit's power. (With the stunts, wild ring §3: leaps, jump attacks and air chases land more blows, so a hit is
   * softer, and wobble counts for a little more, `build`, so the last two settle their duel sooner: knock 0.24 / build
   * 0.16 had a first ring-out at 35–39 s and an end at 84–95 s on seeds 12–14; now 42–49 s and 111–125 s. Softer hits
   * carry less far: `drift` 0.55 → 0.6 keeps a landed hit's median carry over the 1.18 m of before springy bodies.)
   */
  knock: 0.21,
  /** × how long a big hit stuns (a rag-doll flight; pops and staggers have their own short limp). */
  flop: 0.45,
  /** Restitution of every body piece. */
  bounce: 0.15,
  /** m/s², down. */
  gravity: 16,
  /** Knockback grows by this × wobble (wobble = hit power taken, healing slowly). */
  build: 0.17,
  /** Wobble healed per second. */
  heal: 0.05,
  /** Height (m) of the padded bumper round the ring's edge. */
  bumper: 0.65,
  /** m. */
  ringRadius: 6.5,
  /** Seconds to scramble back to full strength after a stun. */
  recoverS: 0.2,
  /** Fighters steer back once this far (m) from the edge. */
  edgeMargin: 2.5,
  /** × the random tumble a hit gives (1 = the spike's torque). */
  spin: 1,
  /** The outward part of a fresh fighter's launch (× power, before wobble adds `build` × wobble): hits send fighters across the ring from the first one. */
  drift: 0.6,
  /** Upward launch speed (m/s) of a normal hit of power 1 on a 1 kg body. */
  pop: 5,
  /** Restitution of the ring's top: fliers bounce. */
  floorBounce: 0.45,
  /** Restitution of the bumper: a trampoline wall that sends fliers back in. */
  bumperBounce: 0.95,
  /** × how hard limbs hold their pose (the brace): 0 lets them dangle. */
  stiff: 0.7,
  /** Seconds a popped fighter tumbles limp before its muscles come back in the air. */
  tumbleS: 0.35,
  /** A launch at least this fast (m/s) is a big one: a full rag-doll flight. Slower ones pop or stagger. */
  bigLaunch: 9,
};
export type Tune = typeof TUNE;

/** Seconds of [wind-up, strike, cool-down] per move (the cool-down is × 0.7–1.3 per attack). */
export const MOVE_TIMING: Record<Move, [windup: number, strike: number, cool: number]> = {
  punch: [0.45, 0.75, 0.4],
  jab: [0.12, 0.45, 0.4],
  kick: [0.3, 0.9, 0.4],
  bump: [0.4, 1.0, 0.4],
  headbutt: [0.55, 1.3, 0.4],
  spin: [0.2, 1.6, 0.4],
  divebomb: [0.45, 1.0, 0.8],
};

/**
 * A landed hit's power (before × `knock`). Retuned with the stunts (wild ring §3, on 210 four-way bouts, seeds 12–14):
 * leaping in, a jump attack and an air chase made every move land more often and the heavy hitters land first (blob
 * won 0.38, horns 0.36, tiny 0.09), so the bump and the headbutt hit softer and tiny's quick jab harder. Again in the
 * wild ring's final balance (Task 8; 140 four-way bouts a pool, ~75 a kind, seeds 101–106): blob won 0.29–0.39 and
 * horns 0.25–0.34 of their bouts, tiny 0.13–0.19 after its pad fix (Fighter.padJump), so bump 1.55 → 1.45, headbutt
 * 2.35 → 2.25, jab 2.3 → 2.45 (every kind 0.13–0.30, seeds 105–106).
 */
export const MOVE_POWER: Record<Move, number> = {
  punch: 2.2, jab: 2.45, kick: 2.6, bump: 1.45, headbutt: 2.25, spin: 2.45, divebomb: 2.65,
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Walking speed (m/s) for a fighter `ringHeight` metres tall: small ones scurry, big ones lumber. */
export const speedFor = (ringHeight: number) => 4.5 * clamp(Math.sqrt(1.4 / ringHeight), 0.75, 1.6);

/** Knockback multiplier: fresh fighters (wobble 0) barely budge, wobbly ones fly. */
export const knockMultiplier = (wobble: number, build: number) => 0.3 + wobble * build;

/**
 * A hit's launch (m/s) on a body of `mass` kg whose wobble (this hit's power included) is `wobble`: `out` (away from
 * the attacker) starts at `drift` and grows with wobble, so even early hits knock a fighter across the ring and late
 * ones send it flying; `up` does not grow. `how` scales each part (specials hit harder and higher). How a fighter
 * reacts goes by the launch's speed (`Fighter.takeHit`: stagger, pop or big).
 */
export function launchFor(power: number, wobble: number, mass: number, tune: Pick<Tune, 'build' | 'pop' | 'drift'>,
  how: { out?: number; up?: number } = {}): { out: number; up: number } {
  const dv = (power * 2.6 * (tune.drift + wobble * tune.build)) / mass ** 0.3;
  return { out: 0.85 * dv * (how.out ?? 1), up: (tune.pop * Math.sqrt(power) * (how.up ?? 1)) / mass ** 0.1 };
}
