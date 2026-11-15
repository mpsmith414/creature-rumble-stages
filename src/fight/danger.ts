import { MOVE_POWER, launchFor, type Tune } from './tune';

/**
 * How close a fighter is to going out, for the show's dizzy stars (pure; the balance sim measures it too). A fighter's
 * danger is how fast a punch (`MOVE_POWER.punch` × `knock`, a typical solid normal hit, its own power counted toward the
 * wobble) would launch it now, as a share of `bigLaunch` (1 = that punch is a big rag-doll flight).
 */

/** What danger reads of the tuning (live: the dev sliders write it). */
export type DangerTune = Pick<Tune, 'knock' | 'build' | 'pop' | 'drift' | 'bigLaunch'>;

/**
 * Stars show from this danger on. Chosen by measurement (design W7: stars mean "in danger of going out"; targets:
 * stars on at least half of fighters as they are rung out, every kind in at least 40% of its ring-outs, and up on at
 * most 35% of fighting time). On 210 four-way bouts (seeds 12–14): 0.8 → 72% of ring-outs but 36% of the time; 0.85 →
 * 63% of ring-outs, 29% of the time, the lowest kind (fists) 48%; 0.9 → 52%, 22%, fists 40%. At 1 ("the next punch is
 * big") a 0.4 kg body needed ~27 wobble and a blob ~46, when a punch adds ~0.55 and wobble heals 0.05/s: stars almost
 * never showed. Retuned with the stunts (wild ring §3: knock 0.21, build 0.17, drift 0.6, a 2.2 punch), on 210 four-way
 * bouts (seeds 12–14): 0.7 → 68–77% of ring-outs, 36–39% of the time; 0.75 → 56–68%, 28–30%; 0.8 → 45–56%, 20–22%.
 */
export const STARS_DANGER = 0.75;

/** A punch's launch speed on a body of `mass` kg at `wobble`, ÷ `bigLaunch`. */
export function danger(wobble: number, mass: number, tune: DangerTune): number {
  const p = MOVE_POWER.punch * tune.knock;
  const l = launchFor(p, wobble + p, mass, tune);
  return Math.hypot(l.out, l.up) / tune.bigLaunch;
}

/**
 * The wobble at which a body of `mass` kg reaches danger `k` (0 when even a fresh one is there, Infinity when no
 * wobble gets there). A launch's outward part grows in step with wobble, its upward part not at all.
 */
export function dangerWobble(mass: number, tune: DangerTune, k = STARS_DANGER): number {
  const p = MOVE_POWER.punch * tune.knock, target = k * tune.bigLaunch;
  const at0 = launchFor(p, 0, mass, tune), at1 = launchFor(p, 1, mass, tune);
  if (Math.hypot(at0.out, at0.up) >= target) return 0;
  const need = Math.sqrt(target ** 2 - at0.up ** 2), perWobble = at1.out - at0.out;
  if (!(perWobble > 0)) return Infinity;
  // the punch's own power counts toward the wobble it is launched by
  return Math.max(0, (need - at0.out) / perWobble - p);
}
