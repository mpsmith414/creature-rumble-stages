/** One of `fourWayReportFast`'s helper processes: runs the bouts it is sent, one at a time, and sends each result back. */
import { simulateBout, type BoutJob } from '../src/fight/sim';
import { initPhysics } from '../src/physics/world';

await initPhysics();
process.on('message', (m: { i: number; job: BoutJob }) => {
  const r = simulateBout(m.job.kinds, m.job);
  process.send!({ i: m.i, r });
});
process.send!('ready');
