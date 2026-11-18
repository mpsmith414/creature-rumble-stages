import type { StageFighter } from '../stage/fighter';
import type { Level } from '../stage/level';
import { makeMover, stepMover, type MoveInput, type MoveStats } from '../stage/move';
import type { StageEvents } from '../stage/sim';
import { DT, type V2 } from '../stage/types';

/**
 * The big moments (spec §9.2): slow motion and a short close-up, only for a knockout launch (the hit that sends someone
 * out) and a special that lands. Kept rare (the owner asked for fewer close-ups): at most one every MOMENT_GAP_S, and
 * when a knockout and a special come together the knockout wins. Display only: the fight never hears about it (slow
 * motion only takes fewer fight steps per real second), so a replay stays exact.
 */

/** At most one moment every this many real seconds. */
export const MOMENT_GAP_S = 10;
/** A moment's slow motion (× real time) and how long it lasts (real seconds). */
export const MOMENT_SLOW = 0.3, MOMENT_SECONDS = 1.2;
/** The close-up's view height (m): a knockout shows the launch and the way it flies, a special the blow up close. */
export const KO_VIEW = 7, SPECIAL_VIEW = 6;
/** After a moment the time scale eases back to real time over this long (real seconds), so the fight never lurches. */
export const MOMENT_EASE = 0.25;
/**
 * A launch counts as a knockout when its flight, with nothing steered, crosses the level's bounds before the creature
 * could act again (its hit freeze and tumble), or within this many steps more: a creature that far gone is not coming
 * back. Measured on 60 headless bouts over the four levels: 93% of the launches it calls go out, and it calls 79% of
 * the knockouts (12 more steps: 83% and 90%; none: 93% and 57%) — rare and right beats often and wrong.
 */
export const KO_EXTRA_STEPS = 8;

/** A big moment for the show: where to look, how tall a view, the slow motion and how long (real seconds). */
export type Moment = { at: V2; height: number; slow: number; seconds: number; kind: 'knockout' | 'special'; id: string };

/** What the prediction needs of a fighter. */
export type Flier = Pick<StageFighter, 'mover' | 'stats' | 'tune' | 'freeze' | 'action' | 'actionT' | 'actionLen'>;

const NO_INPUT: MoveInput = { mx: 0, jump: false, down: false, recover: false };
const scratch = makeMover({ x: 0, y: 0 }, 1, 1);
const coast: MoveStats = { run: 0, accel: 0, airAccel: 0, jump: 0, airJump: 0, airJumps: 0, recovery: 0, fall: 0, fastFall: 0 };

/**
 * Whether `f`'s launch will carry it out of `level` (from level time `t`): its flight is played on a copy of its box,
 * coasting as a tumble does (no steering, the tune's light air drag, the level's platforms and gravity), through the
 * steps it cannot act (the hit freeze and the tumble or stagger) and `extra` more. True if the box crosses the bounds on
 * the way. Pure: the fighter is never touched.
 */
export function willFlyOut(f: Flier, level: Level, t: number, extra = KO_EXTRA_STEPS): boolean {
  if (f.action !== 'tumble' && f.action !== 'hitstun') return false;
  const m = scratch, src = f.mover;
  m.pos.x = src.pos.x;
  m.pos.y = src.pos.y;
  m.vel.x = src.vel.x;
  m.vel.y = src.vel.y;
  m.w = src.w;
  m.h = src.h;
  m.ground = src.ground;
  m.airJumpsLeft = 0;
  m.recoveryUsed = true;
  m.dropTimer = src.dropTimer;
  Object.assign(coast, f.stats.moves);
  coast.accel = coast.airAccel = 0;
  const b = level.bounds, drag = f.tune.airDrag;
  // the hit freeze holds it still first (the level's moving platforms go on)
  const steps = Math.max(0, f.actionLen - f.actionT) + extra, t0 = t + Math.max(0, f.freeze) * DT;
  for (let k = 0; k < steps; k++) {
    if (m.ground === null) m.vel.x *= 1 - drag * DT;
    stepMover(m, NO_INPUT, coast, level, t0 + k * DT, DT);
    const p = m.pos;
    if (p.x < b.left || p.x > b.right || p.y < b.bottom || p.y > b.top) return true;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  }
  return false;
}

/**
 * Decides the big moments. `moment` is asked once per fight step's events (in order) with the real clock (s); it
 * answers with a moment to start now, or null. A knockout launch is a hit whose target `willFlyOut`; a landed special
 * is a special's `impact`. One per MOMENT_GAP_S; within a step's events a knockout wins, and a knockout that comes while
 * a special's moment is still playing takes it over (the gap then runs from the knockout). `timeScale(now)` is the
 * slow motion to show: MOMENT_SLOW while one plays, easing back to 1 after.
 */
export class Moments {
  private last = -Infinity;
  private current: Moment | null = null;
  private readonly kos: Moment = { at: { x: 0, y: 0 }, height: KO_VIEW, slow: MOMENT_SLOW, seconds: MOMENT_SECONDS, kind: 'knockout', id: '' };
  private readonly sps: Moment = { at: { x: 0, y: 0 }, height: SPECIAL_VIEW, slow: MOMENT_SLOW, seconds: MOMENT_SECONDS, kind: 'special', id: '' };

  /**
   * `fighter` finds a fighter in play by id (the sim's `get`), `level` the level as it is now (low gravity included) and
   * `t` the level time (s), for the knockout prediction.
   */
  constructor(private readonly o: { fighter: (id: string) => Flier | undefined; level: () => Level; t: () => number }) {}

  /** The moment to start for this step's events at real time `now` (s), or null. The returned object is reused. */
  moment(e: StageEvents, now: number): Moment | null {
    const playing = this.current !== null && now - this.last < this.current.seconds;
    const free = now - this.last >= MOMENT_GAP_S;
    if (!free && !(playing && this.current?.kind === 'special')) return null;
    for (const h of e.hits) {
      if (!h.tumble) continue;
      const f = this.o.fighter(h.target);
      if (!f || !willFlyOut(f, this.o.level(), this.o.t())) continue;
      const m = this.kos;
      m.id = h.target;
      m.at.x = (h.at.x + f.mover.pos.x) / 2;
      m.at.y = (h.at.y + f.mover.pos.y + f.mover.h / 2) / 2;
      return this.start(m, now);
    }
    if (!free) return null;
    for (const c of e.specials) {
      if (c.phase !== 'impact') continue;
      const m = this.sps;
      m.id = c.id;
      m.at.x = c.at.x;
      m.at.y = c.at.y;
      return this.start(m, now);
    }
    return null;
  }

  /** The slow motion to show at real time `now` (s): MOMENT_SLOW during a moment, easing back to 1 over MOMENT_EASE. */
  timeScale(now: number): number {
    const c = this.current;
    if (!c) return 1;
    const left = now - this.last - c.seconds;
    if (left < 0) return c.slow;
    if (left >= MOMENT_EASE) return 1;
    return c.slow + (1 - c.slow) * (left / MOMENT_EASE);
  }

  /** Forgets every moment (a new fight). */
  reset(): void {
    this.last = -Infinity;
    this.current = null;
  }

  private start(m: Moment, now: number): Moment {
    this.last = now;
    this.current = m;
    return m;
  }
}
