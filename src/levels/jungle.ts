import type { Level } from '../stage/level';

/** Depth of the jungle floor below its top, and of a branch (m). */
const GROUND_DEPTH = 4, BRANCH_DEPTH = 0.4;
/** The vines: hung this high (m), this long, swinging this far either side (radians) once every this many seconds. */
const VINE_TOP = 15, VINE_LENGTH = 7, VINE_SWING = 0.5, VINE_PERIOD = 3.2;

/**
 * The jungle: a wide jungle floor (solid, open edges, the river below), branches on three floors above it (two side
 * branches, the canopy, and a little crown branch at the top that sways side to side). Its mischief: swinging vines
 * (one over each side of the floor, swinging opposite ways; their grips pass about 8–9 m up, clear of every branch,
 * caught by jumping up from a side branch) and the river flooding the floor and sweeping everyone along. Room is left
 * past the camera bounds for the scenery (ruling R22): the river and trees below and beside, the canopy above.
 */
export const JUNGLE: Level = {
  id: 'jungle',
  name: 'Jungle',
  gravity: 30,
  platforms: [
    { id: 'ground', kind: 'solid', x: 0, y: 0, w: 24, h: GROUND_DEPTH },
    { id: 'branchL', kind: 'thin', x: -7.5, y: 3.5, w: 6, h: BRANCH_DEPTH },
    { id: 'branchR', kind: 'thin', x: 7.5, y: 3.5, w: 6, h: BRANCH_DEPTH },
    { id: 'canopy', kind: 'thin', x: 0, y: 7, w: 7, h: BRANCH_DEPTH },
    { id: 'crown', kind: 'thin', x: 0, y: 10.5, w: 4, h: BRANCH_DEPTH, path: { dx: 4, dy: 0, period: 8 } },
  ],
  // (the top edge sits 4 m over the camera bounds, as close as the level test allows: Task 16's balance)
  bounds: { left: -23, right: 23, bottom: -9, top: 20 },
  camera: { left: -17, right: 17, bottom: -4, top: 16 },
  entries: [-10.5, -7.5, -4.5, -1.5, 1.5, 4.5, 7.5, 10.5].map((x) => ({ x, y: 0 })),
  drops: [-10, -7.5, 0, 7.5, 10],
  mischief: [
    {
      name: 'vines',
      vines: [
        { x: -8, y: VINE_TOP, length: VINE_LENGTH, swing: VINE_SWING, period: VINE_PERIOD, phase: 0 },
        { x: 8, y: VINE_TOP, length: VINE_LENGTH, swing: VINE_SWING, period: VINE_PERIOD, phase: Math.PI },
      ],
    },
    { name: 'river', floor: 'ground' },
  ],
};
