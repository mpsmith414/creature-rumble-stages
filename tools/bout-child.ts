/** One of `fourWayReportFast`'s helper processes: runs the bouts it is sent, one at a time, and sends each result back. */
import { runJob, type BoutJob } from '../src/stage/report';

process.on('message', (m: { i: number; job: BoutJob }) => {
  process.send!({ i: m.i, r: runJob(m.job) });
});
process.send!('ready');
