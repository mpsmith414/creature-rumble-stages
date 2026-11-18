import { expect, test } from 'vitest';
import { fourWayReport } from '../../src/stage/report';
import { fourWayReportFast } from '../../tools/bouts';

test('bouts run side by side give the same report as one after another, told in order', async () => {
  const o = { seed: 3, seconds: 8 }, told: number[] = [];
  const fast = await fourWayReportFast(3, { ...o, procs: 2, onBout: (i) => told.push(i) });
  expect(fast).toEqual(fourWayReport(3, o));
  expect(told).toEqual([0, 1, 2]);
}, 60_000);
