import { buildSkeleton, type Skeleton } from '../builder/skeleton';
import { planFor } from '../fight/moves';
import type { Move } from '../fight/types';
import { bodyLayout, type BodyLayout, type Segment, type SegmentKind } from '../anim/layout';
import type { Recipe } from '../recipe/schema';
import { dist } from '../util/vec';
import type { MoveStats } from './move';

/**
 * Everything the stage needs to know about a creature's body: its fighting-size `height` (0.7–2.4 m, as `fightScale`),
 * its box (`w × h`, standing on its bottom centre), its `weight` (1 for an average 1.4 m body; heavier is launched less
 * and falls a bit faster), its signature `move`, how far its weapons `reach` from the body's centre (m), how it moves,
 * and the segment layout its looks are posed from.
 */
export type BodyStats = {
  height: number;
  w: number;
  h: number;
  weight: number;
  move: Move;
  reach: number;
  moves: MoveStats;
  layout: BodyLayout;
};

/** The average body's fighting height (m): it gets exactly the average stats below. */
const AVERAGE_HEIGHT = 1.4;
/** How the average body moves (gravity 30): a 2.8 m jump plus a 2 m air jump, a 3.3 m recovery leap. */
const AVERAGE_MOVES: Readonly<MoveStats> = {
  run: 7, accel: 60, airAccel: 30, jump: 13, airJump: 11, airJumps: 1, recovery: 14, fall: 18, fastFall: 26,
};
/** Run speed ∝ (1.4 m / height)^this: a 0.7 m body runs ×1.19, a 2.4 m one ×0.87 (a little, like the old ring's `speedFor`). */
const RUN_SIZE_EXP = 0.25;
/** Jump speeds ∝ (height / 1.4 m)^this: nearly the same jump in metres for everyone, so small bodies jump far more body heights. */
const JUMP_SIZE_EXP = 0.1;
/** Falling speeds ∝ weight^this: heavier bodies fall a bit faster. */
const FALL_WEIGHT_EXP = 0.25;

/** Segment kinds the box is sized from: the body itself, not arms (they swing), wings, tails or horns. */
const BOX_KINDS: readonly SegmentKind[] = ['torso', 'head', 'leg', 'foot'];
/** The box is never narrower than this share of its height, so even a stick-legged body is a fair target. */
const MIN_WIDTH_SHARE = 0.3;

/** Weight ∝ (height / 1.4 m)^SIZE × (roundness / AVERAGE_ROUNDNESS)^ROUND, kept within WEIGHT_MIN…WEIGHT_MAX. */
const WEIGHT_SIZE_EXP = 1, WEIGHT_ROUND_EXP = 0.5;
/** A typical body's box width over its height (most of the fixtures sit near it). */
const AVERAGE_ROUNDNESS = 0.4;
const WEIGHT_MIN = 0.85, WEIGHT_MAX = 1.6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A recipe's body as the stage sees it: built into a skeleton, laid out at fighting size, measured. A creature made on a
 * phone has its body built by a worker: pass that body's own `skeleton`, so the layout its looks are posed from has
 * exactly the bones its mesh was skinned to (a layout from another build of the skeleton could differ).
 */
export function bodyStats(recipe: Recipe, sk: Skeleton = buildSkeleton(recipe)): BodyStats {
  const plan = planFor(recipe, sk);
  const layout = bodyLayout(sk, plan);
  const height = layout.fightHeight;

  const core = layout.segments.filter((s) => BOX_KINDS.includes(s.kind));
  const box = core.length ? core : [layout.segments[0]];
  const h = Math.max(...box.map((s) => Math.max(s.a.y, s.b.y) + s.radius));
  // The fighter faces left or right turned toward the camera, so its width on screen is the larger of its
  // side-to-side (x) and front-to-back (z) spans.
  const bodyW = Math.max(span(box, 'x'), span(box, 'z'));
  const w = Math.max(bodyW, MIN_WIDTH_SHARE * h);

  // (from the body's own width: widening a thin body's box to a fair target does not make it heavier)
  const roundness = bodyW / h;
  const weight = clamp((height / AVERAGE_HEIGHT) ** WEIGHT_SIZE_EXP * (roundness / AVERAGE_ROUNDNESS) ** WEIGHT_ROUND_EXP,
    WEIGHT_MIN, WEIGHT_MAX);

  return { height, w, h, weight, move: plan.move, reach: Math.max(weaponReach(layout), w / 2), moves: movesFor(height, weight), layout };
}

/** The width of the segments' capsules along one horizontal axis (m). */
function span(segs: readonly Segment[], axis: 'x' | 'z'): number {
  let lo = Infinity, hi = -Infinity;
  for (const s of segs) {
    lo = Math.min(lo, s.a[axis] - s.radius, s.b[axis] - s.radius);
    hi = Math.max(hi, s.a[axis] + s.radius, s.b[axis] + s.radius);
  }
  return hi - lo;
}

/** How far the weapon segments reach from the centre of the root (torso) segment, their thickness included (m). */
function weaponReach(layout: BodyLayout): number {
  const root = layout.segments[0];
  const c = { x: (root.a.x + root.b.x) / 2, y: (root.a.y + root.b.y) / 2, z: (root.a.z + root.b.z) / 2 };
  let reach = 0;
  for (const s of layout.segments) if (s.weapon) reach = Math.max(reach, Math.max(dist(c, s.a), dist(c, s.b)) + s.radius);
  return reach;
}

/**
 * The average body's movement, scaled by size: small bodies run a little faster and jump relatively higher, heavy ones
 * fall a bit faster. Accelerations scale with the run speed, so every body reaches its top speed in the same time.
 */
function movesFor(height: number, weight: number): MoveStats {
  const size = height / AVERAGE_HEIGHT;
  const run = AVERAGE_MOVES.run * size ** -RUN_SIZE_EXP;
  const runShare = run / AVERAGE_MOVES.run;
  const jumpShare = size ** JUMP_SIZE_EXP;
  const fallShare = weight ** FALL_WEIGHT_EXP;
  return {
    run,
    accel: AVERAGE_MOVES.accel * runShare,
    airAccel: AVERAGE_MOVES.airAccel * runShare,
    jump: AVERAGE_MOVES.jump * jumpShare,
    airJump: AVERAGE_MOVES.airJump * jumpShare,
    airJumps: AVERAGE_MOVES.airJumps,
    recovery: AVERAGE_MOVES.recovery * jumpShare,
    fall: AVERAGE_MOVES.fall * fallShare,
    fastFall: AVERAGE_MOVES.fastFall * fallShare,
  };
}
