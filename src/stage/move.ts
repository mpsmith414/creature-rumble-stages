import { platformsAt, type Level, type Platform } from './level';
import type { V2 } from './types';

/**
 * How a body moves: top run speed (m/s) and how fast it gets there on the ground and in the air (m/s²), jump and air
 * jump speeds (m/s) and how many air jumps it has, the recovery leap's upward speed, and the falling speed gravity
 * stops adding at (`fall`; `fastFall` with down held). A launch faster than the cap keeps its speed (ruling R1).
 */
export type MoveStats = {
  run: number;
  accel: number;
  airAccel: number;
  jump: number;
  airJump: number;
  airJumps: number;
  recovery: number;
  fall: number;
  fastFall: number;
};

/**
 * A moving box: `pos` is its bottom centre, `w × h` its size. `ground` is the id of the platform it stands on (null in
 * the air). `dropTimer` counts down after dropping through a thin platform, while thin platforms are ignored.
 */
export type Mover = {
  pos: V2;
  vel: V2;
  w: number;
  h: number;
  ground: string | null;
  airJumpsLeft: number;
  recoveryUsed: boolean;
  dropTimer: number;
};

/** One step's input: the stick across (−1…1), jump and recover pressed this step (edges), down held. */
export type MoveInput = { mx: number; jump: boolean; down: boolean; recover: boolean };

/** What a step's movement did; `bounce` is added by the sim when a bouncy platform springs a lander back up. */
export type MoveEvent = 'jump' | 'airJump' | 'recover' | 'land' | 'drop' | 'bounce';

/** How long thin platforms are ignored after dropping through one (s). */
const DROP_TIME = 0.25;
/** No sub-step moves the box further than this share of its smaller side, so nothing is skipped over. */
const SUBSTEP_SHARE = 0.25;
/** Slack for "was at or above / beside" comparisons, far below anything visible (m). */
const EPS = 1e-6;

/** Platforms at the start and the end of the current step (reused every step). */
const before: Platform[] = [], after: Platform[] = [];

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
const approach = (v: number, target: number, rate: number) =>
  v < target ? Math.min(v + rate, target) : Math.max(v - rate, target);

/** A mover at rest with its bottom centre at `at`, in the air until it first lands (which gives it its air jumps). */
export function makeMover(at: V2, w: number, h: number): Mover {
  return { pos: { x: at.x, y: at.y }, vel: { x: 0, y: 0 }, w, h, ground: null, airJumpsLeft: 0, recoveryUsed: false, dropTimer: 0 };
}

/**
 * Moves `m` one step of `dt` seconds, starting at level time `t`: run, jump, air jump, drop through, recovery leap,
 * gravity, then a swept move against the platforms (per axis, in sub-steps, with moving platforms placed along the
 * way). A standing mover sits exactly on its platform's top and rides along with it; an upward launch (vel.y > 0)
 * lifts it off. Anything that happened is appended to `events`.
 */
export function stepMover(m: Mover, input: MoveInput, s: MoveStats, level: Level, t: number, dt: number, events?: MoveEvent[]): void {
  if (m.dropTimer > 0) m.dropTimer = Math.max(0, m.dropTimer - dt);
  platformsAt(level, t, before);
  platformsAt(level, t + dt, after);

  if (m.ground !== null && m.vel.y > 0) m.ground = null;
  let gi = m.ground === null ? -1 : indexOf(m.ground);
  if (gi < 0) m.ground = null;
  const startedInAir = gi < 0;

  m.vel.x = approach(m.vel.x, clamp1(input.mx) * s.run, (gi >= 0 ? s.accel : s.airAccel) * dt);

  if (input.jump) {
    if (gi >= 0) {
      m.vel.y = s.jump;
      m.ground = null;
      gi = -1;
      events?.push('jump');
    } else if (m.airJumpsLeft > 0) {
      m.airJumpsLeft--;
      m.vel.y = s.airJump;
      events?.push('airJump');
    }
  } else if (input.down && gi >= 0 && before[gi].kind === 'thin') {
    m.dropTimer = DROP_TIME;
    m.ground = null;
    gi = -1;
    events?.push('drop');
  }
  if (input.recover && startedInAir && !m.recoveryUsed) {
    m.recoveryUsed = true;
    m.vel.y = Math.max(m.vel.y, s.recovery);
    events?.push('recover');
  }

  // Gravity adds speed only up to the cap; the step moves by the average of the old and new speeds, so a jump's arc
  // is exact whatever the step.
  let vyMove = 0;
  if (gi < 0) {
    const v0 = m.vel.y, cap = input.down ? s.fastFall : s.fall;
    if (m.vel.y > -cap) m.vel.y = Math.max(m.vel.y - level.gravity * dt, -cap);
    vyMove = (v0 + m.vel.y) / 2;
  } else m.vel.y = 0;

  const dx = m.vel.x * dt + (gi >= 0 ? after[gi].x - before[gi].x : 0);
  const dy = gi >= 0 ? after[gi].y - before[gi].y : vyMove * dt;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (SUBSTEP_SHARE * Math.min(m.w, m.h))));
  const sx = dx / n;
  let sy = gi >= 0 ? 0 : dy / n;
  for (let k = 1; k <= n; k++) {
    const f0 = (k - 1) / n, f1 = k / n;
    const px = m.pos.x;
    m.pos.x += sx;
    collideX(m, px, f0, f1);
    if (gi >= 0) {
      const g0 = before[gi], g1 = after[gi];
      m.pos.y = lerp(g0.y, g1.y, f1);
      if (!acrossX(m, lerp(g0.x, g1.x, f1), g1.w)) {
        // Walked off the edge: step onto a neighbour at the same height, else start falling (next step).
        gi = supportAt(m, f1);
        m.ground = gi >= 0 ? after[gi].id : null;
      }
    } else {
      const py = m.pos.y;
      m.pos.y += sy;
      const landed = collideY(m, py, f0, f1);
      if (landed >= 0) {
        gi = landed;
        sy = 0;
        m.vel.y = 0;
        m.ground = after[gi].id;
        m.airJumpsLeft = s.airJumps;
        m.recoveryUsed = false;
        events?.push('land');
      }
    }
  }
}

function indexOf(id: string): number {
  for (let i = 0; i < before.length; i++) if (before[i].id === id) return i;
  return -1;
}

/** Whether the box spans across x with a platform centred at `cx`, `w` wide (strictly: touching edges don't count). */
function acrossX(m: Mover, cx: number, w: number): boolean {
  return m.pos.x - m.w / 2 < cx + w / 2 && m.pos.x + m.w / 2 > cx - w / 2;
}

/** Stops the box at the side of any solid platform it moved into this sub-step (it was beside it before). */
function collideX(m: Mover, px: number, f0: number, f1: number): void {
  const hw = m.w / 2;
  for (let i = 0; i < before.length; i++) {
    const p0 = before[i], p1 = after[i];
    if (p0.kind !== 'solid') continue;
    const top = lerp(p0.y, p1.y, f1);
    if (!(m.pos.y < top && m.pos.y + m.h > top - p1.h)) continue;
    const l0 = lerp(p0.x, p1.x, f0) - p0.w / 2, l1 = lerp(p0.x, p1.x, f1) - p1.w / 2;
    const r0 = l0 + p0.w, r1 = l1 + p1.w;
    if (px + hw <= l0 + EPS && m.pos.x + hw > l1) {
      m.pos.x = l1 - hw;
      if (m.vel.x > 0) m.vel.x = 0;
    } else if (px - hw >= r0 - EPS && m.pos.x - hw < r1) {
      m.pos.x = r1 + hw;
      if (m.vel.x < 0) m.vel.x = 0;
    }
  }
}

/**
 * Stops the box on the highest top it crossed going down this sub-step (a thin one only when not dropping), or under
 * the lowest solid bottom it crossed going up. Returns the platform landed on, or −1.
 */
function collideY(m: Mover, py: number, f0: number, f1: number): number {
  let land = -1, landTop = -Infinity, ceiling = Infinity;
  for (let i = 0; i < before.length; i++) {
    const p0 = before[i], p1 = after[i];
    if (!acrossX(m, lerp(p0.x, p1.x, f1), p1.w)) continue;
    const top0 = lerp(p0.y, p1.y, f0), top1 = lerp(p0.y, p1.y, f1);
    if (py >= top0 - EPS && m.pos.y < top1) {
      if (p0.kind === 'thin' && m.dropTimer > 0) continue;
      if (top1 > landTop) {
        landTop = top1;
        land = i;
      }
    } else if (p0.kind === 'solid' && py + m.h <= top0 - p0.h + EPS && m.pos.y + m.h > top1 - p1.h) {
      ceiling = Math.min(ceiling, top1 - p1.h);
    }
  }
  if (land >= 0) m.pos.y = landTop;
  else if (ceiling < Infinity) {
    m.pos.y = ceiling - m.h;
    if (m.vel.y > 0) m.vel.y = 0;
  }
  return land;
}

/** A platform whose top is level with the box's bottom right under it (a thin one only when not dropping), or −1. */
function supportAt(m: Mover, f: number): number {
  for (let i = 0; i < before.length; i++) {
    const p0 = before[i], p1 = after[i];
    if (p0.kind === 'thin' && m.dropTimer > 0) continue;
    const top = lerp(p0.y, p1.y, f);
    if (Math.abs(top - m.pos.y) <= EPS && acrossX(m, lerp(p0.x, p1.x, f), p1.w)) {
      m.pos.y = top;
      return i;
    }
  }
  return -1;
}
