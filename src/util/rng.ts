/** A source of random numbers 0 ≤ n < 1 (a seeded one, so a fight replays exactly). */
export type Rng = () => number;

/** Small, fast, seeded random numbers (0 ≤ n < 1). Same seed, same sequence. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform number in [lo, hi). */
export const between = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();
