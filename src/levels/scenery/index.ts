import type { Level } from '../../stage/level';
import { jungleScenery } from './jungle';
import type { LevelScenery } from './kit';
import { shipScenery } from './ship';
import { testScenery } from './test';
import { toyRoomScenery } from './toyroom';

export type { LevelScenery, MischiefView, SceneryState } from './kit';

/**
 * A level's 3D scenery, picked by its id (so a low-gravity copy of a level gets the same scenery): the jungle, the
 * space ship, the toy room, or the practice level's grey box.
 */
export function buildScenery(level: Level): LevelScenery {
  switch (level.id) {
    case 'jungle': return jungleScenery(level);
    case 'ship': return shipScenery(level);
    case 'toyroom': return toyRoomScenery(level);
    default: {
      const s = testScenery(level);
      return {
        root: s.group,
        update: (t) => s.update(t),
        state: () => ({ airlock: { left: 0, right: 0 }, tint: 0 }),
        dispose: () => s.dispose(),
      };
    }
  }
}
