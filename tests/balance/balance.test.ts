import { beforeAll, describe, expect, test } from 'vitest';
import { BODY_KINDS, fourWayBouts, runJob, summarize, type BoutJob, type BoutResult, type StageReport } from '../../src/stage/report';
import type { LevelId } from '../../src/stage/level';
import { runBouts } from '../../tools/bouts';

/**
 * Whole headless stage bouts (seconds in all): `npm run balance`, not `npm test`. `npx tsx tools/balance.ts` prints the
 * same sample's numbers bout by bout.
 * The bouts run side by side in helper processes (tools/bouts.ts), with the same results as one after another.
 *
 * The sample: seeds 2, 3 and 4 × 70 four-way bouts on each level (210 per level), as on the TV: presents dropping and
 * each level's mischief on. The pace is checked level by level; fairness is pooled over the three themed levels (630
 * bouts, ~360 per kind), and checked on the practice level on its own as before. Pooled over three seeds because one
 * 70-bout seed gives each kind ~40 bouts, where a fair 0.25 kind tops 0.35 by chance alone often enough (sd ~0.07)
 * that the check would fail on noise and invite tuning to the seed. Tuning is done on other seeds (101 and up, ruling
 * R31), so these stay a check.
 */
const MINUTES = 60_000;
const SEEDS = [2, 3, 4], PER_SEED = 70;
const THEMED: LevelId[] = ['jungle', 'ship', 'toyroom'];
const LEVEL_IDS: LevelId[] = ['test', ...THEMED];

/** Spec §5.4: the first knockout around 30–60 s (median, s)… */
const FIRST_OUT = [30, 60] as const;
/** …a bout over in about 1.5–3 min (median, s)… */
const LENGTH = [90, 180] as const;
/** …quiet stretches over 3 s rare: in at most this share of bouts… */
const QUIET_SHARE = 0.15;
/**
 * …nobody stands still for long: at most this share of all fighter-time is spent standing still for over 3 s at a
 * stretch (ruling R32; measured ~0.1% on every level, so this only catches creatures standing about)…
 */
const STILL_SHARE = 0.05;
/** …and fair: no kind wins more than MOST of the four-way bouts it is in, none fewer than LEAST (fair share 0.25). */
const MOST = 0.35, LEAST = 0.12;

const jobs: Record<string, BoutJob[]> = {}, results: Record<string, BoutResult[]> = {}, reports: Record<string, StageReport> = {};
let themed: StageReport;
beforeAll(async () => {
  const all = LEVEL_IDS.flatMap((level) => SEEDS.flatMap((seed) => fourWayBouts(PER_SEED, { seed, level })));
  const done = await runBouts(all);
  for (const level of LEVEL_IDS) {
    const idx = all.flatMap((j, i) => (j.level === level ? [i] : []));
    jobs[level] = idx.map((i) => all[i]);
    results[level] = idx.map((i) => done[i]);
    reports[level] = summarize(results[level], jobs[level].map((j) => j.kinds));
  }
  themed = summarize(THEMED.flatMap((l) => results[l]), THEMED.flatMap((l) => jobs[l].map((j) => j.kinds)));
}, 20 * MINUTES);

test('the bouts run side by side match the same bouts run one after another', () => {
  for (const level of LEVEL_IDS) {
    for (const i of [0, PER_SEED + 3, 2 * PER_SEED + 5]) expect(results[level][i], `${level} bout ${i}`).toEqual(runJob(jobs[level][i]));
  }
});

describe.each(LEVEL_IDS)('the pace on the %s level (items and mischief on)', (level) => {
  test('the first knockout comes around 30–60 s (median)', () => {
    expect(reports[level].firstOut).toBeGreaterThanOrEqual(FIRST_OUT[0]);
    expect(reports[level].firstOut).toBeLessThanOrEqual(FIRST_OUT[1]);
  });

  test('a bout lasts about 1.5–3 minutes (median)', () => {
    expect(reports[level].length).toBeGreaterThanOrEqual(LENGTH[0]);
    expect(reports[level].length).toBeLessThanOrEqual(LENGTH[1]);
  });

  test('quiet stretches over 3 s are rare', () => {
    expect(reports[level].quiet, 'share of bouts with a quiet stretch over 3 s').toBeLessThanOrEqual(QUIET_SHARE);
  });

  test('nobody stands still for long', () => {
    expect(reports[level].still, 'share of fighter-time standing still over 3 s at a stretch').toBeLessThanOrEqual(STILL_SHARE);
  });
});

/** Every kind's win rate within LEAST..MOST, each with at least `least` bouts. */
function fair(r: StageReport, least: number): void {
  const k = r.kinds;
  const rates = BODY_KINDS.map((x) => `${x} ${k[x].wins}/${k[x].bouts}`).join(', ');
  for (const x of BODY_KINDS) {
    expect(k[x].bouts, x).toBeGreaterThanOrEqual(least);
    expect(k[x].winRate, `${x} (${rates})`).toBeLessThanOrEqual(MOST);
    expect(k[x].winRate, `${x} (${rates})`).toBeGreaterThanOrEqual(LEAST);
  }
}

test('no body kind dominates, none is starved, over the three themed levels (seeds 2–4, 630 bouts)', () => fair(themed, 270));

test('no body kind dominates, none is starved, on the practice level (seeds 2–4, 210 bouts)', () => fair(reports.test, 90));
