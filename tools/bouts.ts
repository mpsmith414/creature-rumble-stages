/**
 * Four-way balance samples run side by side: `fourWayReport`'s bouts spread over helper processes, one per spare core
 * (each bout is seeded on its own, so the report is the same as `fourWayReport`'s, only sooner). Node only: for the
 * balance tests and tools/balance.ts.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fourWayBouts, summarize, type BoutJob, type BoutResult, type FourWayOptions, type FourWayReport } from '../src/fight/sim';

const CHILD = fileURLToPath(new URL('./bout-child.ts', import.meta.url));

/** How many helper processes run bouts: `BOUT_PROCS` if set, else one per core but one. */
export const boutProcs = (): number => Math.max(1, Number(process.env.BOUT_PROCS) || availableParallelism() - 1);

/** Runs `jobs` over `procs` helpers; `onBout` sees the bouts in order (bout i once bouts 0..i are all done). */
export async function runBouts(jobs: BoutJob[], o: { procs?: number; onBout?: (i: number, r: BoutResult) => void } = {}): Promise<BoutResult[]> {
  const results: (BoutResult | undefined)[] = new Array(jobs.length);
  let next = 0, told = 0;
  const tell = () => { while (told < jobs.length && results[told]) o.onBout?.(told, results[told]!), told++; };
  const procs = Math.min(o.procs ?? boutProcs(), jobs.length);
  const kids: ChildProcess[] = [];
  try {
    await Promise.all(Array.from({ length: procs }, () => new Promise<void>((resolve, reject) => {
      const kid = fork(CHILD, [], { execArgv: ['--import', 'tsx'], serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      kids.push(kid);
      const give = () => {
        if (next >= jobs.length) { kid.disconnect(); resolve(); return; }
        const i = next++;
        kid.send({ i, job: jobs[i] });
      };
      kid.on('message', (m: 'ready' | { i: number; r: BoutResult }) => {
        if (m !== 'ready') { results[m.i] = m.r; tell(); }
        give();
      });
      kid.on('error', reject);
      kid.on('exit', (code) => { if (next < jobs.length || code) reject(new Error(`a bout helper stopped (exit ${code})`)); });
    })));
  } finally {
    for (const k of kids) if (k.exitCode === null) k.kill();
  }
  return results as BoutResult[];
}

/** `fourWayReport(n, o)`, its bouts run side by side. */
export async function fourWayReportFast(n: number, o: FourWayOptions & { procs?: number; onBout?: (i: number, cast: string[], r: BoutResult) => void } = {}): Promise<FourWayReport> {
  const jobs = fourWayBouts(n, o);
  const bouts = await runBouts(jobs, { procs: o.procs, onBout: (i, r) => o.onBout?.(i, jobs[i].kinds, r) });
  return summarize(bouts, jobs.map((j) => j.kinds), o.seconds ?? 240);
}
