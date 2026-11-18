import { newBrainMemory, think, type BrainMemory } from '../stage/brain';
import type { Action, StageFighter } from '../stage/fighter';
import type { StageEvents, StageSim } from '../stage/sim';
import { DT, type Intent } from '../stage/types';
import type { Rng } from '../util/rng';

/** The most fight steps one frame may take: after a stall the fight carries on rather than racing to catch up. */
export const MAX_STEPS = 4;
/** Slack when counting whole steps in the time gathered (s), so 0.05 s is exactly 3 steps despite rounding. */
const STEP_SLACK = 1e-9;

/** Where a fighter was just before the last step: its box's bottom centre, its action and the steps into it. */
export type Before = { x: number; y: number; t: number; action: Action };

/**
 * The fight's clock on the TV: whatever the screen's frame rate, the fight steps at a fixed DT (60 Hz), at most
 * MAX_STEPS a frame, the time left over carried to the next frame. Each step every fighter in play gets its wanting
 * from the simple brain (when `brains` is on), or from a controller that `steer`s it instead. `timeScale` is slow
 * motion: fewer steps per real second, never a different step, so a slowed fight is the same fight. Before each step it
 * notes where everyone was (`prev`), so a frame can be drawn between two steps (`alpha`) and look smooth at any rate.
 */
export class StageLoop {
  readonly sim: StageSim;
  /** Slow motion (display): 1 is real time, 0.25 a quarter of the steps per second, 0 stops the fight. */
  timeScale = 1;
  /** How far the next step is, as a share of a step (0…1): where to draw between `prev` and now. */
  alpha = 0;
  /** The level time (s) just before the last step. */
  prevTime = 0;
  /**
   * Whether the brains think: off (the crowning), every fighter not steered wants nothing (stands, or lands and
   * stands). A steered one still follows its controller.
   */
  thinking = true;

  private readonly rng: Rng;
  private readonly brains: boolean;
  /** Time gathered toward the next step (s of fight time). */
  private acc = 0;
  private readonly sources = new Map<string, () => Intent | null>();
  private readonly memory = new Map<string, BrainMemory>();
  private readonly before = new Map<string, Before>();
  /** The step each `before` was noted at (only the last step's count), and the steps this loop has taken. */
  private readonly noted = new Map<string, number>();
  private steps = 0;
  /** Reused every step: this step's wanting, and everyone but the one thinking. */
  private readonly intents = new Map<string, Intent>();
  private readonly others: StageFighter[] = [];

  constructor(o: { sim: StageSim; rng: Rng; brains?: boolean }) {
    this.sim = o.sim;
    this.rng = o.rng;
    this.brains = o.brains ?? true;
    this.prevTime = o.sim.t;
  }

  /**
   * A pad or the keyboard stands in for this fighter's brain (`source` is asked once a step; a step it answers null, a
   * controller put down, the brain thinks for it); null gives it back. Telling it the same again changes nothing; a
   * change starts its brain afresh (what it was up to before is long past).
   */
  steer(id: string, source: (() => Intent | null) | null): void {
    if ((this.sources.get(id) ?? null) === source) return;
    if (source) this.sources.set(id, source);
    else this.sources.delete(id);
    this.memory.delete(id);
  }

  /**
   * Drops what the loop keeps for `id` (its brain's memory, where it was before the last step), as the fighter leaves
   * the stage, so a newcomer with the same id starts afresh. Its controller (`steer`) is kept: a player keeps the pad
   * through a comeback; `steer(id, null)` gives that back.
   */
  forget(id: string): void {
    this.memory.delete(id);
    this.before.delete(id);
    this.noted.delete(id);
  }

  /** Whether `id`'s brain is posing alone on the level just now (the show plays the show-off clip while it is). */
  showingOff(id: string): boolean {
    return this.memory.get(id)?.showoff ?? false;
  }

  /** The ids the loop keeps records for (their brain's memory or their place before the last step). */
  tracked(): string[] {
    return [...new Set([...this.before.keys(), ...this.memory.keys()])];
  }

  /** Where `id` was just before the last step (undefined if it was not in play then). */
  prev(id: string): Readonly<Before> | undefined {
    const b = this.before.get(id);
    return b && this.noted.get(id) === this.steps ? b : undefined;
  }

  /**
   * Gathers `realDt` seconds (× `timeScale`) and takes as many fixed steps as they make, at most MAX_STEPS (a longer
   * stall's backlog is dropped). Returns each step's events, in order. A broken or negative `realDt` counts as none.
   */
  frame(realDt: number): StageEvents[] {
    const out: StageEvents[] = [];
    const dt = Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    const scale = Number.isFinite(this.timeScale) && this.timeScale > 0 ? this.timeScale : 0;
    this.acc += dt * scale;
    while (this.acc >= DT - STEP_SLACK) {
      if (out.length === MAX_STEPS) {
        this.acc %= DT;
        if (this.acc >= DT - STEP_SLACK) this.acc = 0;
        break;
      }
      this.acc = Math.max(0, this.acc - DT);
      out.push(this.step());
    }
    this.alpha = Math.min(1, this.acc / DT);
    return out;
  }

  /** One fight step: remember everyone, gather the wanting (controllers first, else the brain), step the sim. */
  private step(): StageEvents {
    const sim = this.sim, fs = sim.fighters(), intents = this.intents, others = this.others;
    this.prevTime = sim.t;
    this.steps++;
    intents.clear();
    for (const f of fs) {
      this.note(f);
      const want = this.sources.get(f.id)?.() ?? null;
      if (want) {
        intents.set(f.id, want);
        continue;
      }
      if (!this.brains || !this.thinking) continue;
      let mem = this.memory.get(f.id);
      if (!mem) this.memory.set(f.id, (mem = newBrainMemory()));
      others.length = 0;
      for (const g of fs) if (g !== f) others.push(g);
      intents.set(f.id, think({ self: f, others, level: sim.level, t: sim.t, mischief: sim.mischief, items: sim.items }, this.rng, mem));
    }
    others.length = 0;
    return sim.step(intents);
  }

  /** Notes where `f` is now, before the step (each fighter's record is reused). */
  private note(f: StageFighter): void {
    let b = this.before.get(f.id);
    if (!b) this.before.set(f.id, (b = { x: 0, y: 0, t: 0, action: 'idle' }));
    b.x = f.mover.pos.x;
    b.y = f.mover.pos.y;
    b.t = f.actionT;
    b.action = f.action === 'frozen' ? f.frozenFrom : f.action;
    this.noted.set(f.id, this.steps);
  }
}
