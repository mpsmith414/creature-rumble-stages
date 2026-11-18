import type { Level } from '../stage/level';

/** Depth of the deck below its top, and of a catwalk or a lift (m). */
const DECK_DEPTH = 4, WALK_DEPTH = 0.4;
/** The lifts beside the deck rise and fall this far either side of the catwalks' height (m), once every this many s. */
const LIFT_TRAVEL = 3.5, LIFT_PERIOD = 7;

/**
 * Our own space ship: a solid deck (open ends, space below), two catwalks over it, the bridge walkway on top, and a
 * lift right at each end of the deck going up and down (opposite ways), from deck height to the bridge's. Its
 * mischief: the airlock (a door at one end opens and pulls everyone toward it) and low gravity. The top edge sits
 * high, so a low-gravity jump stays in. Room is left past the camera bounds for the scenery (ruling R22).
 */
export const SHIP: Level = {
  id: 'ship',
  name: 'Space Ship',
  gravity: 30,
  platforms: [
    { id: 'deck', kind: 'solid', x: 0, y: 0, w: 24, h: DECK_DEPTH },
    { id: 'catwalkL', kind: 'thin', x: -7, y: 3.5, w: 7, h: WALK_DEPTH },
    { id: 'catwalkR', kind: 'thin', x: 7, y: 3.5, w: 7, h: WALK_DEPTH },
    { id: 'bridge', kind: 'thin', x: 0, y: 7, w: 8, h: WALK_DEPTH },
    { id: 'liftL', kind: 'thin', x: -13.5, y: 3.5, w: 3, h: WALK_DEPTH, path: { dx: 0, dy: LIFT_TRAVEL, period: LIFT_PERIOD } },
    { id: 'liftR', kind: 'thin', x: 13.5, y: 3.5, w: 3, h: WALK_DEPTH, path: { dx: 0, dy: -LIFT_TRAVEL, period: LIFT_PERIOD } },
  ],
  bounds: { left: -23, right: 23, bottom: -9, top: 26 },
  camera: { left: -17, right: 17, bottom: -4, top: 15 },
  entries: [-10.5, -7.5, -4.5, -1.5, 1.5, 4.5, 7.5, 10.5].map((x) => ({ x, y: 0 })),
  drops: [-9, -7, 0, 7, 9],
  mischief: [{ name: 'airlock' }, { name: 'lowGravity' }],
};
