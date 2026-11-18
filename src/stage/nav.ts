import { platformsAt, type Level, type Platform } from './level';
import type { MoveStats } from './move';

/**
 * One way from a platform to another for a given body: walk across (tops level and touching), jump (one jump is
 * enough, up, or across a gap, also down to a floor too far across to step off onto), air jump (it needs the jump and
 * the air jump), or drop (through a thin platform, or step off an edge and fall onto the other).
 */
export type NavLink = { from: string; to: string; how: 'walk' | 'jump' | 'airJump' | 'drop' };

type How = NavLink['how'];

/** Tops this close in height count as level, and edges this close as touching (m). */
const LEVEL = 0.05;
/** A jump must lift the feet this far over a top to land on it (m). */
const CLEAR = 0.3;
/** Share of the run speed a body keeps up sideways in the air on average (it has to turn and speed up). */
const DRIFT_SHARE = 0.6;
/** Dropping straight through a thin platform needs this much of the floor below under it (m). */
const DROP_OVERLAP = 0.6;
/** Stepping off an edge needs this much of the floor below sticking out past it (m). */
const EDGE_ROOM = 1;
/** A jump up onto a solid platform starts from beside it: the floor needs this much room past its side (m). */
const SIDE_ROOM = 0.8;
/** Moving platforms are tried at this many points along their swing (a link at any of them counts). */
const PHASES = 24;
/** What each way costs when routing: a plain walk is cheapest, a double jump the dearest. */
export const NAV_COST: Record<How, number> = { walk: 1, drop: 1.5, jump: 2, airJump: 3 };
const RANK: Record<How, number> = { walk: 0, drop: 1, jump: 2, airJump: 3 };

/** Graphs worked out already, per level and per body's movement. */
const cache = new WeakMap<Level, WeakMap<MoveStats, NavLink[]>>();

/**
 * Which platforms of `level` a body moving as `moves` can get between, and how: the level as something a brain can
 * plan over. Bodies jump to different heights, so each has its own graph; it is worked out once per level and body
 * (the same array comes back) and must not be changed. Moving platforms are tried along their swing, so a link that
 * works only at some moments is kept (the brain waits for the moment). A bouncy platform is no floor (nobody stands on
 * it): it has no links. The cache is by object, so a level or body that moves differently (low gravity, a power-up) is
 * a new object with its own graph, never one changed in place (ruling R27).
 */
export function navGraph(level: Level, moves: MoveStats): NavLink[] {
  let perLevel = cache.get(level);
  if (!perLevel) cache.set(level, (perLevel = new WeakMap()));
  const known = perLevel.get(moves);
  if (known) return known;

  const g = level.gravity;
  const h1 = (moves.jump * moves.jump) / (2 * g);
  const h2 = h1 + (moves.airJumps * moves.airJump * moves.airJump) / (2 * g);
  let period = 0;
  for (const p of level.platforms) if (p.path) period = Math.max(period, p.path.period);
  const phases = period > 0 ? PHASES : 1;

  const n = level.platforms.length;
  const best: (How | null)[] = new Array<How | null>(n * n).fill(null);
  const ps: Platform[] = [];
  for (let k = 0; k < phases; k++) {
    platformsAt(level, (period * k) / phases, ps);
    for (let i = 0; i < n; i++) {
      if (ps[i].bounce) continue;
      for (let j = 0; j < n; j++) {
        if (i === j || ps[j].bounce) continue;
        const how = linkAt(ps[i], ps[j], moves, g, h1, h2);
        const had = best[i * n + j];
        if (how && (!had || RANK[how] < RANK[had])) best[i * n + j] = how;
      }
    }
  }

  const links: NavLink[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const how = best[i * n + j];
      if (how) links.push({ from: level.platforms[i].id, to: level.platforms[j].id, how });
    }
  }
  perLevel.set(moves, links);
  return links;
}

/** How to get from platform `a` to `b` where they are now, or null. */
function linkAt(a: Platform, b: Platform, moves: MoveStats, g: number, h1: number, h2: number): How | null {
  const al = a.x - a.w / 2, ar = a.x + a.w / 2, bl = b.x - b.w / 2, br = b.x + b.w / 2;
  const dy = b.y - a.y;
  const overlap = Math.min(ar, br) - Math.max(al, bl);
  const gap = Math.max(0, -overlap);

  if (Math.abs(dy) <= LEVEL && gap <= LEVEL) return 'walk';

  if (dy < -LEVEL) {
    if (a.kind === 'thin' && overlap >= DROP_OVERLAP) return 'drop';
    if (stepOff(a, b, moves, g) !== 0) return 'drop';
    // Under a solid one there is no way down but its edges: no jump in place into its underside (ruling R28).
    if (a.kind === 'solid' && overlap > 0) return null;
    // Too far across to step off onto: jump across (below).
  } else if (b.kind === 'solid' && overlap > 0 && !(al < bl - SIDE_ROOM || ar > br + SIDE_ROOM)) {
    // Up (or level): a solid platform can only be landed on from beside it.
    return null;
  }
  if (dy + CLEAR <= h1 && gap <= jumpReach(moves, g, dy, 'jump')) return 'jump';
  if (moves.airJumps > 0 && dy + CLEAR <= h2 && gap <= jumpReach(moves, g, dy, 'airJump')) return 'airJump';
  return null;
}

/**
 * Which edge of platform `a` a body can step off to land on the lower platform `b` (where they are now): −1 the left,
 * 1 the right, 0 neither. `b` must stick out past that edge, near enough to drift onto while falling.
 */
export function stepOff(a: Platform, b: Platform, moves: MoveStats, g: number): -1 | 0 | 1 {
  const dy = b.y - a.y;
  if (dy >= -LEVEL) return 0;
  const al = a.x - a.w / 2, ar = a.x + a.w / 2, bl = b.x - b.w / 2, br = b.x + b.w / 2;
  const drift = moves.run * DRIFT_SHARE * Math.sqrt((-2 * dy) / g);
  if (bl < al - EDGE_ROOM && br > al - drift) return -1;
  if (br > ar + EDGE_ROOM && bl < ar + drift) return 1;
  return 0;
}

/**
 * How far sideways (m) a body moving as `moves` can drift in a jump (or a jump and its air jumps) that ends on a top
 * `dy` above where it took off (negative: below), counting the time until its feet come back down to that top.
 */
export function jumpReach(moves: MoveStats, g: number, dy: number, how: 'jump' | 'airJump'): number {
  const h1 = (moves.jump * moves.jump) / (2 * g);
  const rise1 = moves.jump / g;
  if (how === 'jump') return dy > h1 ? 0 : moves.run * DRIFT_SHARE * (rise1 + Math.sqrt((2 * (h1 - dy)) / g));
  const h2 = h1 + (moves.airJumps * moves.airJump * moves.airJump) / (2 * g);
  if (dy > h2) return 0;
  return moves.run * DRIFT_SHARE * (rise1 + (moves.airJumps * moves.airJump) / g + Math.sqrt((2 * (h2 - dy)) / g));
}

/**
 * The cheapest way from platform `from` to `to` over `graph` (walks and drops are cheaper than jumps), as the links to
 * take in order: [] when already there, null when there is no way. Ties go to the link listed first, so the same graph
 * always gives the same route.
 */
export function route(graph: readonly NavLink[], from: string, to: string): NavLink[] | null {
  if (from === to) return [];
  const dist = new Map<string, number>([[from, 0]]);
  const via = new Map<string, NavLink>();
  const done = new Set<string>();
  for (;;) {
    let cur: string | null = null, cd = Infinity;
    for (const [id, d] of dist) {
      if (!done.has(id) && d < cd) {
        cur = id;
        cd = d;
      }
    }
    if (cur === null) return null;
    if (cur === to) break;
    done.add(cur);
    for (const l of graph) {
      if (l.from !== cur) continue;
      const d = cd + NAV_COST[l.how];
      if (d < (dist.get(l.to) ?? Infinity)) {
        dist.set(l.to, d);
        via.set(l.to, l);
      }
    }
  }
  const path: NavLink[] = [];
  for (let id = to; id !== from;) {
    const l = via.get(id)!;
    path.push(l);
    id = l.from;
  }
  return path.reverse();
}
