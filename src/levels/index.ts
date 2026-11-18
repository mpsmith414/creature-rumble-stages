import type { Level, LevelId } from '../stage/level';
import { JUNGLE } from './jungle';
import { SHIP } from './ship';
import { TOY_ROOM } from './toyroom';

/** The themed levels by id (the plain test level is `TEST_LEVEL` in `./test`). */
export const LEVELS: Record<Exclude<LevelId, 'test'>, Level> = { jungle: JUNGLE, ship: SHIP, toyroom: TOY_ROOM };

/** The order the night goes through them: each new round (and Again!) moves to the next (spec §7.2). */
export const LEVEL_ORDER: LevelId[] = ['jungle', 'ship', 'toyroom'];

/** The level after `id`, round and round (from the test level, the first). */
export function nextLevel(id: LevelId): LevelId {
  return LEVEL_ORDER[(LEVEL_ORDER.indexOf(id) + 1) % LEVEL_ORDER.length];
}
