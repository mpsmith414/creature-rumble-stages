import { introText, type Beat, type Slots } from '../announcer/announcer';
import { namesOf } from '../announcer/lines';
import type { AnimState } from '../anim/pose';
import type { BodyData } from '../builder/build';
import { planFor } from '../fight/moves';
import { SPECIAL_FOR, specialSaid } from '../fight/special';
import type { FightPlan } from '../fight/types';
import { LEVEL_ORDER, LEVELS, nextLevel } from '../levels';
import type { Match, MatchEvent } from '../match/match';
import type { Recipe } from '../recipe/schema';
import { carryAt, carryRoute } from '../show/carry';
import { DropIn, dropHeight, dropSpot, topSpot, type DropAt } from '../show/drop-in';
import { Moments } from '../show/moments';
import { TA_DA } from '../show/pops';
import { performCall, StageCalls, type Call, type CallSinks } from '../show/stage-calls';
import { bodyStats, type BodyStats } from '../stage/body';
import type { StageFighter } from '../stage/fighter';
import type { ItemCue } from '../stage/items';
import { platformsAt, type Level, type LevelId } from '../stage/level';
import type { MischiefCue } from '../stage/mischief';
import { StageSim, type StageEvents } from '../stage/sim';
import type { Intent, V2 } from '../stage/types';
import { mulberry32 } from '../util/rng';
import type { StageShow } from './stage-show';
import { StageLoop } from './stage-loop';

export { namesOf };

/** A lone fighter's taunt comes back this often (s) while it stays alone (spec §2.6). */
export const LONE_EVERY_S = 12;
/** A taunt that could not be said (a big line was up) is tried again this soon (s). */
export const LONE_RETRY_S = 2;
/** The champion is carried up to the top platform over this long (s), along a way clear of every solid (`carryRoute`). */
export const CARRY_S = 1.6;
/** The close-ups: a lone drop-in's view (m tall, centred this far over the landing spot), and the champion's. */
export const DROP_VIEW = 7, CROWN_VIEW = 6;
const DROP_LOOK_UP = 2.5, CROWN_LOOK_UP = 1.4;
/** A close-up the show holds is asked for again every frame, for this long (s): it eases back out once it stops. */
const HOLD_S = 0.25;
/** A drop-in's landing squash is posed as a landing this many steps long. */
const LAND_STEPS = 6;
/** Fight steps per second (the show-off clip's time is in steps). */
const STEPS_PER_S = 60;
/** The size of the TA-DA! popped as a newcomer lands. */
const LANDING_POP = 1.4;
/** No fight steps (an empty stage). */
const NO_STEPS: readonly StageEvents[] = [];

/** A creature the Rumble knows: what it is, its body, who made it, the name to shout. */
export type Card = { id: string; recipe: Recipe; body: BodyData; maker: string | null; name: string };
type Entry = Card & { plan: FightPlan; stats: BodyStats };

/** What the Rumble's show draws with (`StageShow`; the tests use a fake). */
export type ShowView = Pick<StageShow,
  'useLevel' | 'add' | 'remove' | 'ids' | 'draw' | 'closeUp' | 'knockOut' | 'pop' | 'crown' | 'stopConfetti' | 'uncrown'>;

type Say = (beat: Beat, slots: Slots, o?: { priority?: boolean; text?: string; title?: string }) => { text: string; spoken: boolean };

/** What the show drives. Everything here is injected, so whole nights can be run in a test. */
export type ShowDeps = {
  view: ShowView;
  /** Random numbers for the show (each new fight on a level is seeded from it). */
  rng: () => number;
  /** The match (made with the drop-ins' lengths: `DROP_IN_S`, `GROUP_DROP_IN_S`). */
  match: Match;
  announcer: {
    say: Say; warm(beat: Exclude<Beat, 'intro'>, slots: Slots, n?: number): void; prefetch(text: string): void;
    warn(who: readonly { id: string; name: string }[]): { text: string }; cancelHeld(id: string): void;
  };
  sfx: CallSinks['sfx'] & { fanfare(): void };
  crowd: { roar(): void };
  roster: { fought(ids: string[]): Promise<void>; crowned(id: string): Promise<void> };
  banner: { hide(): void };
  /** The level the night starts on (the first in order by default). */
  level?: LevelId;
};

/**
 * The champion's way up to the top platform: from where it stood, the route clear of the solids (null: the plain arc),
 * when it set off (show s), whether it got there.
 */
type Carry = { id: string; from: V2; to: V2; route: V2[] | null; start: number; done: boolean };

/**
 * The Rumble's show on the stage (spec §9, §12; the night's flow of design 2026-11-09 §2): it runs the match (who is
 * fighting, dropping in, on deck) and the fight on the level, and turns what happens into drop-ins, words, sounds and
 * pictures. A creature drops in from above when it arrives (the fight frozen meanwhile; arrivals close together share
 * one); one knocked out goes back to the roster; past 8 they wait on deck. Crown: the fight stops cleanly and the
 * champion is carried up to the top platform under confetti. Again!: the next level, the cast dropping in together,
 * the champion last. The level changes only then or from the TV menu (`setLevel`).
 */
export class RumbleShow {
  /** The crowned champion's id, or null. */
  champion: string | null = null;
  level: Level;
  sim!: StageSim;
  loop!: StageLoop;
  /** The drop-ins under way. */
  readonly drop = new DropIn();
  private moments!: Moments;
  private calls!: StageCalls;
  private readonly cards = new Map<string, Entry>();
  /** Landed hits by attacker this round (who is crowned). */
  private readonly hits = new Map<string, number>();
  private now = 0;
  /** Quick-fill: the next entrance is skipped, its fighters stood straight on the level. */
  private quiet = false;
  /** Who drops in last after Again! (the last champion, still wearing its crown). */
  private lastChampion: string | null = null;
  private lone: { id: string; next: number } | null = null;
  private carry: Carry | null = null;
  /** Whether the fight is held for a drop-in now. */
  private frozen = false;
  /** The creatures steered by a controller, each with its pad's wanting (kept across new fights and levels). */
  private readonly pads = new Map<string, () => Intent | null>();
  /** While crowned: where the champion stands (x, m), which the others turn to as they stand about; null otherwise. */
  private faceX: number | null = null;
  /** Scratch, refilled every frame. */
  private readonly mischief: MischiefCue[] = [];
  private readonly items: ItemCue[] = [];
  private readonly outs: string[] = [];
  private readonly landed: string[] = [];
  private readonly callsOut: Call[] = [];
  private readonly dropAt: DropAt = { phase: 'done', lift: 0, squash: 0, show: 0, chute: 0 };
  private readonly sinks: CallSinks;
  private readonly adjust = (f: StageFighter, a: AnimState) => this.shape(f, a);

  constructor(private readonly d: ShowDeps) {
    this.level = LEVELS[(d.level ?? LEVEL_ORDER[0]) as keyof typeof LEVELS] ?? LEVELS.jungle;
    this.sinks = { announcer: d.announcer, sfx: d.sfx, pop: (at, word, size) => d.view.pop(at, word, size) };
    this.newFight();
    d.announcer.warm('tie', {});
    d.announcer.warm('again', {});
  }

  /** How many cards it keeps (bounded: only creatures the match still knows). */
  get cardCount(): number { return this.cards.size; }
  card(id: string): Card | undefined { return this.cards.get(id); }
  /** Is this creature fighting, dropping in or on deck? */
  known(id: string): boolean {
    const m = this.d.match;
    return m.fighting.includes(id) || m.entering.includes(id) || m.onDeck.includes(id);
  }
  /** Nobody fighting, dropping in or on deck (the start screen shows). */
  private empty(): boolean {
    const m = this.d.match;
    return !m.fighting.length && !m.entering.length && !m.onDeck.length && !this.sim.fighters().length;
  }

  /**
   * A controller steers creature `id` (stages design §10): `source` is asked once a fight step in place of its brain,
   * so it has exactly the AI's moves and rules. It keeps steering it through new fights, levels and Again!; while the
   * fight is over (crowned) it stands like everyone else; a step its source answers null (the pad put down) the AI
   * drives it. Null gives it back to the AI.
   */
  steer(id: string, source: (() => Intent | null) | null): void {
    if (source) this.pads.set(id, source);
    else {
      this.pads.delete(id);
      this.loop.steer(id, null);
    }
    this.applyPads();
  }

  /** Is creature `id` steered by a controller? */
  steered(id: string): boolean {
    return this.pads.has(id);
  }

  /** The level's id now. */
  get levelId(): LevelId {
    return this.level.id;
  }

  /**
   * How a creature fights and its stage stats; throws when its recipe and body cannot make a fighter. The stats are
   * laid out from the body's own skeleton (the one its mesh was skinned to), so its picture always fits its pose.
   */
  static check(recipe: Recipe, body: BodyData): { plan: FightPlan; stats: BodyStats } {
    const plan = planFor(recipe, body.skeleton);
    const stats = bodyStats(recipe, body.skeleton);
    if (stats.layout.boneSegment.length > body.skeleton.bones.length) {
      throw new Error(`the layout has ${stats.layout.boneSegment.length} bones, the body ${body.skeleton.bones.length}`);
    }
    return { plan, stats };
  }

  /** Learn a creature (a release, a send-back, a fixture): its intro starts fetching now, so its drop-in never waits. */
  register(c: Card): void {
    const { plan, stats } = RumbleShow.check(c.recipe, c.body);
    this.cards.set(c.id, { ...c, plan, stats });
    this.d.announcer.prefetch(introText(plan.intro, this.slots(c.id)));
  }

  /** Into the fight (a drop-in follows; past 8 they wait on deck). Unknown ids are skipped. */
  arrive(ids: string[]): void {
    const known = ids.filter((id) => this.cards.has(id));
    this.d.match.arrive(known);
    this.warmBigMoments(known);
    this.warmGroup([...new Set([...this.d.match.entering, ...known])]);
  }

  /** Dev: `ids` (registered) straight onto the level with no drop-in. */
  quickFill(ids: string[]): void {
    const m = this.d.match;
    if (m.phase !== 'open' || m.entering.length) return this.arrive(ids);
    this.arrive(ids);
    this.quiet = true;
    try {
      this.onMatch(m.tick(1e3));
    } finally {
      this.quiet = false;
    }
  }

  /**
   * "Crown the champion!" (TV menu, phone, dev): only while the fight is open with someone fighting. The fight stops
   * cleanly whatever anyone was doing (specials end, holds let go, power-ups, presents and mischief go; a launch runs
   * its course), nobody thinks any more, anyone dropping in goes back on deck, and the champion is carried up to the
   * top platform, crowned under confetti. True when it crowned.
   */
  crown(): boolean {
    const { match, view } = this.d;
    if (match.phase !== 'open' || match.fighting.length === 0) return false;
    const entering = [...match.entering];
    for (const e of match.crown(this.hits)) {
      if (e.type !== 'crowned') continue;
      // anyone mid-drop-in went back on deck: it drops in again when it enters
      for (const id of entering) this.takeOff(id);
      this.drop.cancel();
      this.setFrozen(false);
      this.sim.calm();
      this.loop.thinking = false;
      this.loop.timeScale = 1;
      this.moments.reset();
      this.lone = null;
      for (const f of this.sim.fighters()) this.perform(this.calls.forget(f.id)); // no warning held to say after the crown
      this.champion = e.id;
      const champ = this.sim.get(e.id);
      if (champ) {
        const to = topSpot(this.sim.level), from = { x: champ.mover.pos.x, y: champ.mover.pos.y };
        const route = carryRoute(platformsAt(this.sim.level, this.sim.t), from, to, champ.mover.w, champ.mover.h);
        this.carry = { id: e.id, from, to, route, start: this.now, done: false };
        this.sim.put(e.id, to);
        view.crown(e.id, false); // the confetti comes once it is up there
      }
      this.d.sfx.fanfare();
      this.d.crowd.roar();
      this.d.announcer.say('crown', this.slots(e.id));
      this.warmGroup([...match.fighting]); // the Again! drop-in is likely next
      void this.d.roster.crowned(e.id).catch((err) => console.warn('could not mark the champion', err));
    }
    return true;
  }

  /**
   * "Again!": after a crowning, the next level (in order), the same cast plus anyone made meanwhile dropping in together,
   * the champion last, still wearing its crown. True when it went.
   */
  again(): boolean {
    const { match, view } = this.d;
    if (match.phase !== 'crowned') return false;
    view.stopConfetti();
    this.lastChampion = this.champion;
    this.champion = null;
    this.carry = null;
    this.lone = null;
    this.moveTo(LEVELS[nextLevel(this.level.id) as keyof typeof LEVELS]);
    this.onMatch(match.again());
    this.tidyView();
    this.prune();
    return true;
  }

  /** "Clear the stage": everyone back to the roster, the start screen comes back (the same level). */
  reset(): void {
    const { match, view, banner } = this.d;
    match.reset();
    this.champion = this.lastChampion = null;
    this.carry = null;
    this.lone = null;
    view.uncrown();
    this.moveTo(this.level);
    this.tidyView();
    banner.hide();
    this.prune();
  }

  /**
   * The TV menu's level pick: the fight moves to level `id` now. While the fight is open everyone on the stage (and
   * anyone dropping in) drops into the new level together; after a crowning the champion stands crowned on its top
   * platform under fresh confetti with the others about (the fight still over). The same level again does nothing.
   */
  setLevel(id: LevelId): void {
    const level = LEVELS[id as keyof typeof LEVELS];
    if (!level || level === this.level) return;
    const cast = this.sim.fighters().map((f) => f.id);
    const crowned = this.d.match.phase === 'crowned' ? this.champion : null;
    this.carry = null;
    this.moveTo(level);
    const taken: V2[] = [];
    const who: { id: string; at: V2; from: number }[] = [];
    for (const fid of cast) {
      const c = this.cards.get(fid);
      if (!c) continue;
      const at = fid === crowned ? topSpot(level) : dropSpot(level, this.sim.t, taken, c.stats.w);
      taken.push(at);
      this.addFighter(c, at);
      if (!crowned) who.push({ id: fid, at, from: dropHeight(at.y, level.camera.top, c.stats.h) });
    }
    if (crowned) {
      // the fight stays over on the new level: no presents, no mischief, nobody thinking; the old level's confetti
      // stops and the champion is crowned again where it now stands (a fresh shower over the new top platform)
      this.sim.calm();
      this.loop.thinking = false;
      this.d.view.stopConfetti();
      if (this.sim.get(crowned)) {
        const to = topSpot(level);
        this.carry = { id: crowned, from: to, to, route: null, start: this.now - CARRY_S, done: true };
        this.d.view.crown(crowned, true);
      }
    } else if (who.length) this.drop.start(who, this.now, { group: true });
    this.applyFreeze();
    this.tidyView();
  }

  /**
   * One frame (`dt` real s, `now` the show clock in s): the match's clock, the drop-ins, the fight (slowed for a big
   * moment), what it says and plays, knockouts, the champion's carry, the lone taunt, and the picture. Hands back who
   * went out this frame (read it before the next frame).
   */
  frame(dt: number, now: number): { outs: readonly string[] } {
    this.now = now;
    const { match, view, announcer } = this.d;
    this.onMatch(match.tick(dt));
    this.landed.length = 0;
    for (const id of this.drop.update(now, this.landed)) {
      const f = this.sim.get(id);
      if (!f) continue;
      view.pop({ x: f.mover.pos.x, y: f.mover.pos.y + f.mover.h }, TA_DA, LANDING_POP);
      this.d.sfx.boing(f.stats.height);
    }
    this.applyFreeze();
    this.applyPads();
    const open = match.phase === 'open';
    this.loop.timeScale = open && !this.frozen ? this.moments.timeScale(now) : 1;

    this.mischief.length = this.items.length = this.outs.length = 0;
    // an empty stage waits (the start screen): no presents dropping, no mischief, for nobody
    for (const ev of this.sim.fighters().length ? this.loop.frame(dt) : NO_STEPS) {
      this.mischief.push(...ev.mischief);
      this.items.push(...ev.items);
      for (const h of ev.hits) this.hits.set(h.attacker, (this.hits.get(h.attacker) ?? 0) + 1);
      if (open) {
        const m = this.moments.moment(ev, now);
        if (m) view.closeUp(m.at, m.height, m.seconds); // real seconds: the close-up lasts as long as the slow motion
      }
      this.callsOut.length = 0;
      for (const c of this.calls.calls(ev, this.sim.fighters(), this.callsOut)) {
        // crowned: the champion's line is the last word (a creature launched just before the crown flies out a moment
        // later, and a knockout line, a priority beat, would cut it off); pops, sounds and the crowd still come
        if (match.phase === 'crowned' && (c.kind === 'say' || c.kind === 'warn')) continue;
        this.perform(c);
      }
      for (const id of ev.outs) {
        const gone = this.sim.get(id)?.mover.pos;
        if (gone) view.knockOut(gone);
        this.takeOff(id);
        this.outs.push(id);
      }
    }
    if (this.outs.length) this.onMatch(match.knockOut([...this.outs]));
    // the stage emptied (everyone out, nobody dropping in or on deck): what was under way goes, so no present hangs
    // frozen over the start screen and no mischief stays running; the next arrival starts a fresh fight
    if (this.outs.length && this.empty()) this.moveTo(this.level);

    // the camera: a lone drop-in's landing spot, or the champion on top
    const focus = this.drop.focus();
    if (focus) view.closeUp({ x: focus.x, y: focus.y + DROP_LOOK_UP }, DROP_VIEW, HOLD_S);
    this.faceX = null;
    if (this.champion && match.phase === 'crowned') this.onTop(now);

    if (this.lone) {
      const id = this.lone.id;
      const still = open && match.fighting.length === 1 && match.fighting[0] === id && !match.entering.length && !match.onDeck.length;
      if (!still) this.lone = null;
      else if (now >= this.lone.next) {
        // never over a big line (an intro still speaking): a taunt that could not be said is tried again soon
        const said = announcer.say('lone', this.slots(id)).text !== '';
        this.lone.next = now + (said ? LONE_EVERY_S : LONE_RETRY_S);
      }
    }
    view.draw(this.sim, this.loop, dt, { mischief: this.mischief, items: this.items, adjust: this.adjust, beam: this.level.id === 'ship' });
    return { outs: this.outs };
  }

  // ---------- the fight on a level ----------

  /**
   * A new fight on `level` (the scenery changes if it is another level): everyone in the old fight leaves it (their
   * pictures are kept, for the caller to reuse or `tidyView` away), drop-ins end, the hit count starts again.
   */
  private moveTo(level: Level): void {
    for (const f of [...this.sim.fighters()]) this.takeOff(f.id, false);
    this.drop.cancel();
    this.frozen = false;
    if (level !== this.level) {
      this.level = level;
      this.d.view.useLevel(level);
    }
    this.newFight();
    this.hits.clear();
  }

  /** A fresh fight on the level: its sim (with presents), the loop, the big moments and the calls. */
  private newFight(): void {
    const rng = mulberry32(Math.floor(this.d.rng() * 2 ** 32));
    this.sim = new StageSim({ level: this.level, rng, items: true });
    this.loop = new StageLoop({ sim: this.sim, rng });
    this.moments = new Moments({ fighter: (id) => this.sim.get(id), level: () => this.sim.level, t: () => this.sim.t });
    this.calls = new StageCalls((id) => this.name(id), this.d.rng);
  }

  /** Puts creature `c` on the stage standing on `at`, and draws it. */
  private addFighter(c: Entry, at: V2): StageFighter {
    const f = this.sim.add(c.id, c.stats, at);
    this.d.view.add(f, { recipe: c.recipe, body: c.body, stats: c.stats, name: c.name });
    return f;
  }

  /**
   * Takes `id` off the stage (knocked out, back on deck, or a new fight): out of the fight and its loop, its held
   * warning taken back, and (with `picture`) no longer drawn.
   */
  private takeOff(id: string, picture = true): void {
    this.sim.remove(id);
    this.loop.forget(id);
    if (picture) this.d.view.remove(id);
    this.perform(this.calls.forget(id)); // a warning still held for it is never said
  }

  /** Stops drawing anyone no longer on the stage (after a new fight was set up: the bodies back in it are kept). */
  private tidyView(): void {
    for (const id of this.d.view.ids()) if (!this.sim.get(id)) this.d.view.remove(id);
  }

  /** The controllers steer their creatures while the fight is open (a new fight's loop is told again); crowned, nobody moves. */
  private applyPads(): void {
    const open = this.d.match.phase === 'open';
    for (const [id, source] of this.pads) this.loop.steer(id, open ? source : null);
  }

  /** The fight is held while anyone drops in (or the match still has someone entering). */
  private applyFreeze(): void {
    this.setFrozen(this.d.match.phase === 'open' && (this.drop.active || this.d.match.entering.length > 0));
  }

  private setFrozen(on: boolean): void {
    if (on === this.frozen) return;
    this.frozen = on;
    this.sim.freeze(on);
  }

  /**
   * After the crowning, every frame: the champion's carry (then its confetti), the camera on it, and where the others
   * look (`faceX`: they turn to it in their pose, `shape`; the fight's own facing is left alone).
   */
  private onTop(now: number): void {
    const champ = this.champion!, c = this.carry;
    if (c && !c.done && now - c.start >= CARRY_S) {
      c.done = true;
      this.d.view.crown(champ, true);
    }
    const f = this.sim.get(champ);
    const top = c?.to ?? f?.mover.pos;
    if (top) this.d.view.closeUp({ x: top.x, y: top.y + CROWN_LOOK_UP }, CROWN_VIEW, HOLD_S);
    this.faceX = f ? f.mover.pos.x : null;
  }

  /**
   * How a creature is drawn this frame beyond its place in the fight: dropping in (hidden above the view, then falling
   * under its parachute, landing, showing off), the champion carried up to the top and strutting there, or one of the
   * others turned to it.
   */
  private shape(f: StageFighter, a: AnimState): number | false | void {
    const d = this.drop.state(f.id, this.dropAt);
    if (d) {
      if (d.phase === 'wait') return false;
      if (d.phase === 'fall') {
        a.action = 'air';
        a.ground = false;
        a.pos.y += d.lift;
        a.vel.x = a.vel.y = 0;
        a.spin = 0;
        return d.chute;
      }
      if (d.phase === 'land') {
        a.action = 'land';
        a.len = LAND_STEPS;
        a.t = (1 - d.squash) * LAND_STEPS;
        a.land = d.squash;
        a.ground = true;
        return d.chute;
      }
      if (d.phase === 'showoff') {
        a.action = 'showoff';
        a.t = d.show * STEPS_PER_S;
        a.ground = true;
      }
      return;
    }
    const c = this.carry;
    if (f.id !== this.champion) {
      // standing about after the crowning: turned to the champion (in the pose only)
      if (this.faceX !== null && (a.action === 'idle' || a.action === 'land')) a.facing = this.faceX >= a.pos.x ? 1 : -1;
      return;
    }
    if (!c || c.id !== f.id) return;
    const k = (this.now - c.start) / CARRY_S;
    if (k < 1) {
      // carried up: from where it stood to the top platform, never through a solid
      carryAt(c.from, c.to, c.route, k, a.pos);
      a.action = 'air';
      a.ground = false;
      a.spin = 0;
      a.vel.x = a.vel.y = 0;
    } else if (a.action === 'idle' || a.action === 'land') {
      a.action = 'showoff';
      a.t = (this.now - c.start - CARRY_S) * STEPS_PER_S;
      a.ground = true;
    }
  }

  // ---------- the match ----------

  /** The match's events, each on its own: one that fails is logged and the rest of the batch still plays. */
  private onMatch(events: MatchEvent[]): void {
    for (const e of events) {
      try {
        this.onEvent(e);
      } catch (err) {
        console.error(`the show failed on a ${e.type} event`, err);
      }
    }
  }

  private onEvent(e: MatchEvent): void {
    const { announcer, match } = this.d;
    if (e.type === 'entranceStart') this.enter(e.ids, e.group);
    else if (e.type === 'entranceEnd') {
      this.lastChampion = null;
      // anyone the match brought in with no fighter on the stage (it could not be made) is ruled out
      const missing = e.ids.filter((id) => !this.sim.get(id));
      if (missing.length) this.onMatch(match.knockOut(missing));
      this.applyFreeze();
      this.warmHits();
    } else if (e.type === 'knockOut') {
      // (the announcer's line and the whoosh come with the fight's calls; the crowd roars here)
      this.d.crowd.roar();
      void this.d.roster.fought(e.ids).catch((err) => console.warn('could not count the bout', err));
    } else if (e.type === 'holdsStage') {
      // it comes with the knockout's line: if that is still up, the boast follows a little later
      const said = announcer.say('holdsStage', this.slots(e.id)).text !== '';
      this.lone = { id: e.id, next: this.now + (said ? LONE_EVERY_S : LONE_RETRY_S) };
    } else if (e.type === 'lone') this.lone = { id: e.id, next: this.now }; // taunted at once (this frame), then every 12 s
    else if (e.type === 'tie') announcer.say('tie', {});
    else if (e.type === 'again') announcer.say('again', {});
  }

  /**
   * An entrance: each creature not yet on the stage is put on its landing spot (spread out; the fight is frozen) and
   * drops in, or with quick-fill simply stands there. Its intro (or the group's line) is said. After Again! the champion
   * drops in last, wearing its crown.
   */
  private enter(ids: string[], group: boolean): void {
    const level = this.sim.level, taken: V2[] = this.sim.fighters().map((f) => f.mover.pos);
    const champ = this.lastChampion && ids.includes(this.lastChampion) ? this.lastChampion : null;
    const solo = ids.length === 1 && !group && !this.drop.active;
    const who: { id: string; at: V2; from: number }[] = [];
    for (const id of ids) {
      if (this.sim.get(id)) continue; // already dropping in (a newcomer joined it)
      const c = this.cards.get(id);
      if (!c) {
        console.warn(`no card for ${id}: it cannot enter`);
        continue;
      }
      const at = dropSpot(level, this.sim.t, taken, c.stats.w);
      taken.push(at);
      this.addFighter(c, at);
      const viewTop = solo ? at.y + DROP_LOOK_UP + DROP_VIEW / 2 : level.camera.top;
      who.push({ id, at, from: dropHeight(at.y, viewTop, c.stats.h) });
    }
    if (this.quiet) return;
    this.drop.start(who, this.now, { group: !solo, champion: champ });
    this.applyFreeze();
    if (champ) this.d.view.crown(champ, false);
    const { announcer } = this.d;
    if (ids.length === 1) announcer.say('intro', this.slots(ids[0]), { text: this.cards.get(ids[0])?.plan.intro });
    else announcer.say('groupIntro', { names: namesOf(ids.map((id) => this.name(id))) });
  }

  // ---------- words ----------

  private perform(c: Call): void {
    performCall(c, this.sinks);
  }

  private name(id: string): string {
    return this.cards.get(id)?.name ?? 'OUR HERO';
  }

  private slots(id: string): Slots {
    const c = this.cards.get(id);
    return { name: c?.name, maker: c?.maker ?? undefined, weight: c?.plan.weight };
  }

  /** Gets the big moments of these fighters decoded (their knockout, crown, taunt and boast), so they can be spoken. */
  private warmBigMoments(ids: string[]): void {
    const { announcer } = this.d;
    for (const id of ids) {
      const name = this.name(id);
      announcer.warm('knockOut', { other: name }, 1);
      for (const beat of ['lone', 'holdsStage', 'crown'] as const) announcer.warm(beat, { name }, 1);
      const move = this.cards.get(id)?.plan.move;
      if (move) announcer.warm('special', { name, special: specialSaid(SPECIAL_FOR[move]) }, 1);
    }
  }

  /** Gets the group drop-in line for these fighters decoded. */
  private warmGroup(ids: string[]): void {
    if (ids.length > 1) this.d.announcer.warm('groupIntro', { names: namesOf(ids.map((id) => this.name(id))) }, 1);
  }

  /** Gets a few hit lines decoded for a likely pair on the stage, so the next one can be spoken. */
  private warmHits(): void {
    const ids = this.d.match.fighting;
    if (ids.length < 2) return;
    const r = this.d.rng, i = Math.floor(r() * ids.length) % ids.length;
    const j = (i + 1 + (Math.floor(r() * (ids.length - 1)) % (ids.length - 1))) % ids.length;
    const slots = { name: this.name(ids[i]), other: this.name(ids[j]) };
    for (const beat of ['hit', 'bigHit', 'throw'] as const) this.d.announcer.warm(beat, slots);
  }

  /** Forgets cards the match no longer knows and no fighter uses (their bodies are big; the roster keeps them). */
  private prune(): void {
    const m = this.d.match, keep = new Set([...m.fighting, ...m.entering, ...m.onDeck, ...m.lastCast]);
    for (const id of this.cards.keys()) if (!keep.has(id) && !this.sim.get(id)) this.cards.delete(id);
  }
}
