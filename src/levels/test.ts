import type { Level } from '../stage/level';

/** Depth of the main stage below its top (m) and of a thin platform. */
const STAGE_DEPTH = 4, THIN_DEPTH = 0.4;

/**
 * The plain level the core is tested and balanced on: a solid main stage 24 m wide (top at y = 0, open edges),
 * two thin platforms at 3.5 m left and right, and a thin one at 7 m in the centre that swings ±3 m every 6 s.
 */
export const TEST_LEVEL: Level = {
  id: 'test',
  name: 'Practice Stage',
  gravity: 30,
  platforms: [
    { id: 'main', kind: 'solid', x: 0, y: 0, w: 24, h: STAGE_DEPTH },
    { id: 'left', kind: 'thin', x: -6, y: 3.5, w: 6, h: THIN_DEPTH },
    { id: 'right', kind: 'thin', x: 6, y: 3.5, w: 6, h: THIN_DEPTH },
    { id: 'centre', kind: 'thin', x: 0, y: 7, w: 6, h: THIN_DEPTH, path: { dx: 3, dy: 0, period: 6 } },
  ],
  bounds: { left: -22, right: 22, bottom: -10, top: 20 },
  camera: { left: -16, right: 16, bottom: -4, top: 14 },
  entries: [-10.5, -7.5, -4.5, -1.5, 1.5, 4.5, 7.5, 10.5].map((x) => ({ x, y: 0 })),
  drops: [-9, -6, 0, 6, 9],
  mischief: [],
};
