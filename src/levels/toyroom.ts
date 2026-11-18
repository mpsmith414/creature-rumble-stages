import type { Level } from '../stage/level';

/** Depth of the floor below its top, and of a crayon or the bed (m). */
const FLOOR_DEPTH = 4, CRAYON_DEPTH = 0.4;
/**
 * The two giant toy blocks: their top (m), depth (so their underside is 2.5 m up: room for the tallest creature under
 * them, and above the train) and width. They float (on toy shelves in the scenery) rather than stand on the floor: a
 * block standing on the floor would be a wall a creature could be pinned against and hit over and over. They are set in
 * from the floor's ends, so a creature coming back to a ledge never bumps into one.
 */
const BLOCK_TOP = 3.5, BLOCK_DEPTH = 1, BLOCK_W = 3;
/** The bouncy bed springs a lander up at its jump speed × this. */
const BED_BOUNCE = 1.4;
/** The bed's top (m): its underside clears the toy train (1 m tall) that runs under it. */
const BED_TOP = 1.5;

/**
 * The toy room: a wide floor (open ends), a giant toy block over each end of it (set in a little), a bouncy bed in the middle (low, so
 * creatures walk under it; whoever lands on it is sprung up), two crayons laid across as platforms between the blocks,
 * and a crayon on top sliding side to side. Its mischief: the toy train, which runs along the floor from one end to
 * the other (under the bed and the blocks) and back. Room is left past the camera bounds for the scenery (ruling R22):
 * the track runs on past the floor's ends there.
 */
export const TOY_ROOM: Level = {
  id: 'toyroom',
  name: 'Toy Room',
  gravity: 30,
  platforms: [
    { id: 'floor', kind: 'solid', x: 0, y: 0, w: 25, h: FLOOR_DEPTH },
    { id: 'blockL', kind: 'solid', x: -9, y: BLOCK_TOP, w: BLOCK_W, h: BLOCK_DEPTH },
    { id: 'blockR', kind: 'solid', x: 9, y: BLOCK_TOP, w: BLOCK_W, h: BLOCK_DEPTH },
    { id: 'bed', kind: 'thin', x: 0, y: BED_TOP, w: 3.6, h: CRAYON_DEPTH, bounce: BED_BOUNCE },
    { id: 'crayonL', kind: 'thin', x: -4.25, y: 3.5, w: 4.5, h: CRAYON_DEPTH },
    { id: 'crayonR', kind: 'thin', x: 4.25, y: 3.5, w: 4.5, h: CRAYON_DEPTH },
    { id: 'crayonTop', kind: 'thin', x: 0, y: 7, w: 5, h: CRAYON_DEPTH, path: { dx: 5, dy: 0, period: 8 } },
  ],
  // (the top edge sits 4 m over the camera bounds, the least the level test allows: Task 16's balance)
  bounds: { left: -23, right: 23, bottom: -9, top: 19 },
  camera: { left: -17, right: 17, bottom: -4, top: 15 },
  entries: [-11, -7, -4.5, -2.5, 2.5, 4.5, 7, 11].map((x) => ({ x, y: 0 })),
  drops: [-9, -4.25, 0, 4.25, 9],
  mischief: [{ name: 'toyTrain', track: 'floor' }],
};
