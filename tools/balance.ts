/**
 * The fight-balance report: headless four-way bouts of random body kinds, against the spec's targets (§3.2). By default
 * it runs the balance tests' own samples: 20 bouts (seed 1) for fight length and spectacle (pop-ups, air time,
 * specials), 70 bouts (seed 2) for who wins.
 * Run: npx tsx tools/balance.ts
 *      npx tsx tools/balance.ts --bouts 40 --seed 3    one sample of your own, both tables
 *      npx tsx tools/balance.ts --seconds 300          a longer cap per bout (default 240)
 *      npx tsx tools/balance.ts --bouts 40 --off       the same without the wild ring's pads and events
 * Bouts run side by side, one helper process per core but one (BOUT_PROCS=n to change); results are the same.
 */
import { BODY_KINDS, type FourWayReport } from '../src/fight/sim';
import { fourWayReportFast } from './bouts';

const arg = (name: string): number | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`--${name} needs a number`);
  return v;
};
const seconds = arg('seconds') ?? 240;
/** `--off`: no spring pads or ring events (for comparison). */
const features = !process.argv.includes('--off');
const s1 = (x: number) => x.toFixed(1).padStart(6);

async function sample(bouts: number, seed: number): Promise<FourWayReport> {
  console.log(`\n${bouts} four-way bouts (seed ${seed}, at most ${seconds} s each)`);
  console.log(`  #  cast                          first out     end  quiet  throws  pads ev  winner${features ? '' : '   (pads and events off)'}`);
  return fourWayReportFast(bouts, {
    seed, seconds, features,
    onBout: (i, cast, b) => console.log(
      `${String(i + 1).padStart(3)}  ${cast.join(' ').padEnd(28)}  ${s1(b.ringOuts[0]?.t ?? seconds)}  ${s1(b.end)}${b.timedOut ? '*' : ' '} ${s1(b.longestQuiet)}  ${String(b.throws).padStart(2)}/${b.throwOuts}  ${String(b.padJumps).padStart(4)} ${String(b.events).padStart(2)}  ${b.winner ?? '-'}`,
    ),
  });
}

function lengths(r: FourWayReport): void {
  console.log(`\n(* = timed out with 2+ left, no winner: ${r.timedOut} of ${r.bouts.length})`);
  console.log(`median first ring-out  ${s1(r.medianFirstOut)} s   (target 40–70)`);
  console.log(`median end             ${s1(r.medianEnd)} s   (target 90–180)`);
  console.log(`longest quiet          ${r.maxQuiet.toFixed(2).padStart(6)} s   (target ≤ 4.5, while 2+ fight)`);
  console.log(`bouts with a quiet > 3 s  ${r.quietOver3} of ${r.bouts.length} (${((100 * r.quietOver3) / r.bouts.length).toFixed(0)}%; target ≤ 15%)`);
}

/** Median peak torso height of a landed normal hit before big fights (seed 1 sample; 0.98 for seed 2). */
const BEFORE_PEAK = 0.97;

/** The spectacle: pop-ups and air time (big fights, 2026-11-12), travel and reactions (springy bodies), specials. */
function spectacle(r: FourWayReport): void {
  const normal = r.bouts.flatMap((b) => b.launches.filter((l) => !l.special));
  const speeds = normal.map((l) => l.launch).sort((a, b) => a - b);
  const pct = (q: number) => (speeds.length ? speeds[Math.min(speeds.length - 1, Math.floor(q * speeds.length))] : 0);
  console.log(`
spectacle (${normal.length} normal hits landed)`);
  console.log(`median peak torso height  ${r.medianPeak.toFixed(2).padStart(6)} m   (big fights wanted ≥ ${(2 * BEFORE_PEAK).toFixed(2)}; springy bodies knock across instead)`);
  console.log(`hits peaking ≥ 1.5 m      ${(100 * r.highShare).toFixed(0).padStart(6)} %`);
  console.log(`median air time / launch  ${r.medianAir.toFixed(2).padStart(6)} s`);
  console.log(`median travel / hit       ${r.medianTravel.toFixed(2).padStart(6)} m   (1.18 before springy bodies, seed 11)`);
  console.log(`median travel / launch    ${r.medianLaunchTravel.toFixed(2).padStart(6)} m   (target ≥ 1.5: knocked across the ring)`);
  const pc = (x: number) => `${(100 * x).toFixed(0)}%`;
  console.log(`reactions  stagger ${pc(r.reactions.stagger)}  pop ${pc(r.reactions.pop)}  big ${pc(r.reactions.big)}  armoured ${pc(r.reactions.none)}   (all hits, specials too; target ≥ 10% each)`);
  const kinds = Object.entries(r.starsAtOutByKind).map(([k, x]) => `${k} ${pc(x)}`).join('  ');
  console.log(`dizzy stars at ring-out  ${pc(r.starsAtOut).padStart(6)}     (target ≥ 50%; each kind ≥ 40%: ${kinds})`);
  console.log(`dizzy stars, fight time  ${pc(r.starsTime).padStart(6)}     (target ≤ 35%)`);
  console.log(`specials per 45 s         ${r.specialsPer45.toFixed(2).padStart(6)}     (target ≥ 1 per fighter)`);
  console.log(`launch speed (Hit.launch) p50 ${pct(0.5).toFixed(1)}  p75 ${pct(0.75).toFixed(1)}  p90 ${pct(0.9).toFixed(1)} m/s`);
}

/** Liveliness (wild ring §3): stunts and movement per fighter-minute of fighting. */
function lively(r: FourWayReport): void {
  const l = r.lively, n = (x: number) => x.toFixed(1).padStart(6);
  console.log(`
liveliness (per fighter-minute of fighting)`);
  console.log(`leaps          ${n(l.leaps)}     (target ≥ 6)`);
  console.log(`metres         ${n(l.metres)}     (target ≥ 90)`);
  console.log(`still          ${(100 * l.still).toFixed(0).padStart(6)} %   (target ≤ 25% of unstunned time under 0.5 m/s)`);
  console.log(`rope springs   ${n(l.ropeSprings)}     (target ≥ 0.5)`);
  console.log(`dashes ${l.dashes.toFixed(1)}  dodges ${l.dodges.toFixed(1)}  air chases ${l.airChases.toFixed(1)}`);
}

/** Grab and throw (wild ring §4). */
function throws(r: FourWayReport): void {
  console.log(`
throws (grab and throw)`);
  console.log(`median throws / bout   ${r.medianThrows.toFixed(1).padStart(6)}     (target ≥ 1)   mean ${r.throwsPerBout.toFixed(2)}`);
  console.log(`ring-outs from a throw ${(100 * r.throwOutShare).toFixed(0).padStart(6)} %   (target ≤ 45%)`);
}

/** The wild ring (§5.1), per bout. */
function ring(r: FourWayReport): void {
  const g = r.ring, n = (x: number) => x.toFixed(1).padStart(6);
  console.log(`
the wild ring (per bout${features ? '' : '; off'})`);
  console.log(`pad jumps      ${n(g.padJumps)}`);
  console.log(`ring events    ${n(g.events)}`);
  console.log(`ball bonks     ${n(g.bonks)}     post kicks ${g.bumps.toFixed(1)}`);
}

function wins(r: FourWayReport): void {
  console.log(`\n(timed out, no winner: ${r.timedOut} of ${r.bouts.length})`);
  console.log('kind    bouts  wins  win rate   (target ≤ 0.35 each, in ≥ 30 bouts; fair share 0.25)');
  for (const k of BODY_KINDS) {
    const s = r.kinds[k];
    console.log(`${k.padEnd(6)}  ${String(s.bouts).padStart(5)}  ${String(s.wins).padStart(4)}  ${s.winRate.toFixed(2).padStart(8)}`);
  }
}

const started = performance.now();
const bouts = arg('bouts'), seed = arg('seed');
if (bouts !== undefined || seed !== undefined) {
  const r = await sample(bouts ?? 70, seed ?? 1);
  lengths(r);
  spectacle(r);
  lively(r);
  throws(r);
  ring(r);
  wins(r);
} else {
  const a = await sample(20, 1);
  lengths(a);
  spectacle(a);
  lively(a);
  throws(a);
  ring(a);
  const b = await sample(70, 2);
  wins(b);
  spectacle(b);
}
console.log(`\n${((performance.now() - started) / 1000).toFixed(0)} s wall-clock`);
