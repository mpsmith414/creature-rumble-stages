import { beforeAll, expect, test } from 'vitest';
import { BODY_KINDS, fourWayBouts, summarize, type FourWayReport } from '../../src/fight/sim';
import { runBouts } from '../../tools/bouts';

/**
 * Whole headless bouts (minutes in all): `npm run balance`, not `npm test`. See `npx tsx tools/balance.ts`. The bouts run
 * side by side in helper processes (tools/bouts.ts), with the same results as one after another.
 */
const MINUTES = 60_000;

/**
 * Springy bodies (2026-11-14): hits knock fighters across the ring rather than straight up where they stand (the
 * "bopping back and forth" the owner saw). Before, every landed normal hit was a pop-up that carried its target a
 * median 1.18 m (seed 11, 40 bouts); now a launch (a pop or a big hit) must carry it at least `TRAVEL` m, and hits on
 * the whole (staggers too) at least as far as before. (1.18 m: `npx tsx tools/balance.ts --seed 11 --bouts 40` on
 * b0da54d, the commit before springy bodies, with this sim's travel measure ported to it, "steady" there meaning no
 * longer flying and its stun over, since that code had no reactions.)
 */
const TRAVEL = 1.5, BEFORE_TRAVEL = 1.18;
/**
 * Each way of taking a hit (stagger, pop, big) is a real part of the fight: at least this share of all landed hits.
 * Specials count: their blows are the big rag-doll flights (a normal hit is big only when its target is very wobbly).
 */
const REACTION_SHARE = 0.1;
/**
 * R6: in random four-way bouts a fair share is 0.25; no kind may win more than `MOST` of the bouts it is in, nor fewer
 * than `LEAST` (no kind starved: wild ring Task 8, when the spring pads had cut tiny, the lightest, to ~0.06).
 */
const MOST = 0.35, LEAST = 0.12;

/**
 * The samples (all with the spring pads and ring events on, `simulateBout`'s default), 230 bouts run once for every
 * test: `lengths`, seed 1 × 20 bouts, for how long fights last (the spec's medians); `r6`, seeds 2, 3 and 4 × 70 bouts
 * (210), for who wins; and `pooled`, all 230 together, for everything judged on single hits, stretches or rates —
 * quiet stretches, hit travel, reactions, specials, dizzy stars, liveliness, throws and the ring's pads and events.
 * Ruling (wild ring W14, 2026-11-14): 20 bouts were too few for those. Seed 1's median hit travel ranged 1.09–1.40 m
 * over independent 20-bout samples against a 0.05 m margin, and ~1 in 4 samples failed a criterion on noise alone —
 * the same reasoning as the R6 pooling ruling below. The thresholds are unchanged.
 */
let lengths: FourWayReport, pooled: FourWayReport, r6: FourWayReport;
beforeAll(async () => {
  const parts = [fourWayBouts(20, { seed: 1 }), ...[2, 3, 4].map((seed) => fourWayBouts(70, { seed }))];
  const jobs = parts.flat();
  const bouts = await runBouts(jobs);
  const cast = jobs.map((j) => j.kinds);
  lengths = summarize(bouts.slice(0, 20), cast.slice(0, 20), 240);
  r6 = summarize(bouts.slice(20), cast.slice(20), 240);
  pooled = summarize(bouts, cast, 240);
}, 20 * MINUTES);

test('fights last the spec’s length', () => {
  const r = lengths;
  expect(r.medianFirstOut).toBeGreaterThanOrEqual(40); expect(r.medianFirstOut).toBeLessThanOrEqual(70);
  expect(r.medianEnd).toBeGreaterThanOrEqual(90); expect(r.medianEnd).toBeLessThanOrEqual(180);
});

test('no long stretch without a hit (pooled, 230 bouts)', () => {
  const r = pooled;
  // spec: never a stretch longer than "~3 s" without a hit (ruling: an approximate target). Body geometry still makes
  // the odd longer one (tiny under legs, hugs, wings hovering past the edge), so: none over 4.5 s, few over 3 s.
  expect(r.maxQuiet).toBeLessThanOrEqual(4.5);
  expect(r.quietOver3 / r.bouts.length).toBeLessThanOrEqual(0.15);
});

// Fighters fly: hits knock them across the ring, they stagger, pop and rag-doll in turn, and everyone unleashes specials.
test('fighters fly: knocked across the ring, every reaction, specials (pooled, 230 bouts)', () => {
  const r = pooled;
  expect(r.medianLaunchTravel, 'median distance a normal launch carries its target').toBeGreaterThanOrEqual(TRAVEL);
  expect(r.medianTravel, 'median distance a landed normal hit carries its target').toBeGreaterThanOrEqual(BEFORE_TRAVEL);
  for (const k of ['stagger', 'pop', 'big'] as const) {
    expect(r.reactions[k], `share of landed hits taken as a ${k}`).toBeGreaterThanOrEqual(REACTION_SHARE);
  }
  expect(r.specialsPer45, 'specials each fighter performs per 45 s of fighting').toBeGreaterThanOrEqual(1);
});

// Dizzy stars warn that a fighter is in danger of going out (design ruling W7): most fighters show them as they are
// rung out, and they are not up most of the time. (Each kind's share, target ≥ 40%, is printed by tools/balance.ts.)
test('dizzy stars come before a ring-out (pooled, 230 bouts)', () => {
  const r = pooled;
  const kinds = Object.entries(r.starsAtOutByKind).map(([k, x]) => `${k} ${x.toFixed(2)}`).join(', ');
  expect(r.starsAtOut, `share of ring-outs with stars showing (${kinds})`).toBeGreaterThanOrEqual(0.5);
  expect(r.starsTime, 'share of fighting time with stars showing').toBeLessThanOrEqual(0.35);
});

// Wild ring (2026-11-14 §3): the fighters jump around the ring — they leap, spring off the ropes and keep moving —
// rather than bop back and forth on the spot. Per fighter-minute of fighting (2+ fighting), in four-way bouts.
test('fighters jump around the ring (pooled, 230 bouts)', () => {
  const l = pooled.lively;
  expect(l.leaps, 'leaps per fighter-minute').toBeGreaterThanOrEqual(6);
  expect(l.metres, 'metres travelled per fighter-minute').toBeGreaterThanOrEqual(90);
  expect(l.still, 'share of unstunned time standing still').toBeLessThanOrEqual(0.25);
  expect(l.ropeSprings, 'rope springs per fighter-minute').toBeGreaterThanOrEqual(0.5);
});

// Grab and throw (wild ring §4): the Royal Rumble move is part of most fights without deciding most of them: the
// median bout has a throw, and at most 45% of ring-outs come straight from a throw.
test('fighters grab and throw each other (pooled, 230 bouts)', () => {
  const r = pooled;
  expect(r.medianThrows, `throws in the median bout (${r.throwsPerBout.toFixed(2)} a bout)`).toBeGreaterThanOrEqual(1);
  expect(r.throwOutShare, 'share of ring-outs straight from a throw').toBeLessThanOrEqual(0.45);
});

// The wild ring (§5.1): every sample here runs with the spring pads and ring events on, so the lengths, travel, quiet
// stretches, stars, liveliness, throws and R6 all hold with them. And they are part of the fights: a ring event or two
// in a bout, and pad jumps.
test('the wild ring is part of the fights (pooled, 230 bouts)', () => {
  const g = pooled.ring;
  expect(g.events, 'ring events a bout').toBeGreaterThanOrEqual(1);
  expect(g.padJumps, 'pad jumps a bout').toBeGreaterThanOrEqual(3);
});

// R6: a bout that runs out of time with 2+ left has no winner. Ruling (big fights, 2026-11-12): pooled over three seeds
// (210 bouts, ~120 per kind). One 70-bout seed gave each kind ~35 bouts, where a fair 0.25 kind tops 0.35 by chance
// alone often enough (sd ~0.07) that the check failed on noise and invited tuning to the seed.
test('no body kind dominates, none is starved (seeds 2–4, 210 bouts)', () => {
  const k = r6.kinds;
  const rates = BODY_KINDS.map((x) => `${x} ${k[x].wins}/${k[x].bouts}`).join(', ');
  for (const x of BODY_KINDS) {
    expect(k[x].bouts, x).toBeGreaterThanOrEqual(90);
    expect(k[x].winRate, `${x} (${rates})`).toBeLessThanOrEqual(MOST);
    expect(k[x].winRate, `${x} (${rates})`).toBeGreaterThanOrEqual(LEAST);
  }
  console.log(`R6 pooled win rates: ${rates}`);
});
