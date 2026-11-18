/**
 * The stage balance report: headless four-way bouts of random body kinds, with presents and each level's mischief on,
 * against the spec's pace and fairness targets (§5.4). By default it runs the balance test's own sample: seeds 2, 3
 * and 4 × 70 bouts on each level (the practice level, the jungle, the space ship and the toy room); the pace is shown
 * level by level and fairness per level and pooled over the three themed levels.
 * Run: npx tsx tools/balance.ts
 *      npx tsx tools/balance.ts --seeds 101,102 --bouts 70     a sample of your own (tune on these, ruling R31)
 *      npx tsx tools/balance.ts --level jungle                 one level (or a list: --level jungle,ship; all = the four)
 *      npx tsx tools/balance.ts --seconds 300                  a longer cap per bout (default 240)
 *      npx tsx tools/balance.ts --every                        every bout as well as the tables
 *      npx tsx tools/balance.ts --no-items                     without presents (to compare)
 * Bouts run side by side, one helper process per core but one (BOUT_PROCS=n to change); results are the same.
 */
import type { LevelId } from '../src/stage/level';
import {
  BODY_KINDS, BOUT_SECONDS, fourWayBouts, levelById, QUIET_LONG, STILL_LONG, summarize, type BoutJob, type BoutResult, type StageReport,
} from '../src/stage/report';
import { runBouts } from './bouts';

const THEMED: LevelId[] = ['jungle', 'ship', 'toyroom'];
const ALL: LevelId[] = ['test', ...THEMED];

const value = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const num = (name: string): number | undefined => {
  const v = value(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} needs a number`);
  return n;
};
const seeds = (value('seeds') ?? value('seed') ?? '2,3,4').split(',').map(Number);
if (seeds.some((s) => !Number.isFinite(s))) throw new Error('--seeds needs numbers, e.g. 101,102');
const perSeed = num('bouts') ?? 70;
const seconds = num('seconds') ?? BOUT_SECONDS;
const asked = value('level') ?? 'all';
const levels = (asked === 'all' ? ALL : asked.split(',')) as LevelId[];
for (const l of levels) levelById(l);
const everyBout = process.argv.includes('--every');
const items = !process.argv.includes('--no-items');
const s1 = (x: number) => x.toFixed(1).padStart(6);
const pct = (x: number) => `${(100 * x).toFixed(1).padStart(5)} %`;

const started = performance.now();
const jobs: BoutJob[] = levels.flatMap((level) => seeds.flatMap((seed) => fourWayBouts(perSeed, { seed, seconds, level, items })));
console.log(`\n${jobs.length} four-way bouts on ${levels.join(', ')} (seeds ${seeds.join(', ')} × ${perSeed} per level, at most ${seconds} s each${items ? '' : ', no presents'})`);
if (everyBout) console.log('   #  level    cast                          first out    end  quiet  outs  winner');
const results: BoutResult[] = await runBouts(jobs, {
  onBout: (i, b) => {
    if (!everyBout) return;
    const cast = jobs[i].kinds;
    const kind = (id: string | null) => (id ? cast[Number(id.slice(1))] : '-');
    console.log(`${String(i + 1).padStart(4)}  ${jobs[i].level.padEnd(7)}  ${cast.join(' ').padEnd(28)}  ${s1(b.firstOut ?? b.seconds)}  ${s1(b.seconds)}${b.winner ? ' ' : '*'} ${s1(b.quiet)}  ${String(b.outs.length).padStart(4)}  ${kind(b.winner)}`);
  },
});

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const q = (xs: number[], p: number) => sorted(xs)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const pick = (ls: LevelId[]) => {
  const idx = jobs.flatMap((j, i) => (ls.includes(j.level) ? [i] : []));
  const rs = idx.map((i) => results[i]);
  return { rs, report: summarize(rs, idx.map((i) => jobs[i].kinds)) };
};

console.log(`\nlevel     bouts  first out (p25–p75)   length (p25–p75)    quiet>${QUIET_LONG}s  longest  still>${STILL_LONG}s  no winner`);
console.log('          (targets: first out 30–60 s, length 90–180 s, quiet ≤ 15% of bouts, still ≤ 5% of fighter-time)');
for (const l of levels) {
  const { rs, report: r } = pick([l]);
  const firsts = rs.map((b) => b.firstOut ?? b.seconds), ends = rs.map((b) => b.seconds);
  console.log(`${l.padEnd(8)}  ${String(r.bouts).padStart(5)}  ${s1(r.firstOut)} (${q(firsts, 0.25).toFixed(0)}–${q(firsts, 0.75).toFixed(0)})`
    + `      ${s1(r.length)} (${q(ends, 0.25).toFixed(0)}–${q(ends, 0.75).toFixed(0)})   ${pct(r.quiet)}  ${Math.max(...rs.map((b) => b.quiet)).toFixed(1).padStart(5)} s  ${pct(r.still)}  ${String(rs.filter((b) => !b.winner).length).padStart(9)}`);
}

const table = (name: string, r: StageReport) => {
  console.log(`\n${name}: kind  bouts  wins  win rate   (target 0.12–0.35 each; fair share 0.25)`);
  for (const k of BODY_KINDS) {
    const s = r.kinds[k];
    console.log(`  ${k.padEnd(6)}  ${String(s.bouts).padStart(5)}  ${String(s.wins).padStart(4)}  ${s.winRate.toFixed(2).padStart(8)}`);
  }
};
const themed = THEMED.filter((l) => levels.includes(l));
if (themed.length > 1) table(`pooled over ${themed.join(', ')}`, pick(themed).report);
console.log('\nper level: ' + BODY_KINDS.join(' / '));
for (const l of levels) console.log(`  ${l.padEnd(8)} ${BODY_KINDS.map((k) => pick([l]).report.kinds[k].winRate.toFixed(2)).join('  ')}`);
console.log(`\n${((performance.now() - started) / 1000).toFixed(0)} s wall-clock`);
