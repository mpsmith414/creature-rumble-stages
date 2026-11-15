import type RAPIER from '@dimforge/rapier3d-compat';
import { BALL_R, RING_EVENTS, type FeatureCue, type RingEventName } from '../arena/features';
import { Vector3, type Camera, type Color } from 'three/webgpu';
import { introText, type Beat, type Slots } from '../announcer/announcer';
import type { BodyData } from '../builder/build';
import { Fighter, type Hit } from '../fight/fighter';
import { planFor } from '../fight/moves';
import { SPECIAL_FOR, SPECIAL_TITLE, type SpecialCue, type SpecialName } from '../fight/special';
import type { StuntCue } from '../fight/stunts';
import type { Tune } from '../fight/tune';
import type { FightPlan } from '../fight/types';
import type { Match, MatchEvent } from '../match/match';
import { ragdollLayout, type RagdollLayout } from '../physics/layout';
import type { Recipe } from '../recipe/schema';
import { BYE_BYE } from '../show/pops';
import { trailsOn } from '../show/event-look';
import type { Looks } from '../show/ring-looks';
import { shotCues, type ShotCue } from '../show/shot-picker';
import { bigLaunch, type SlowMo } from '../show/slowmo';
import {
  airborne, glowLevel, IMPACT_RING, OOH_GAP, outward, shakeFor, SPECIAL_POP, SPECIAL_POP_SIZE, specialSaid, WHEE_GAP, WHEE_HEIGHT,
  WHEE_LAUNCH, WHEEE,
} from '../show/special-fx';
import { trailColour } from '../show/trails';
import type { RingLoop } from './loop';

/** A lone fighter's taunt comes back this often (s) while it stays alone (spec §2.6). */
export const LONE_EVERY_S = 12;
/** A taunt that could not be said (a big line was up) is tried again this soon (s). */
export const LONE_RETRY_S = 2;
/** Quick-filled fighters stand on a circle this far (× ring radius) from the centre, facing in. */
const FILL_AT = 0.4;
/** How long (s) the crowd rises as a special winds up; the impact word pops this high (m) over the impact. */
const CHARGE_RISE_S = 1, IMPACT_POP_UP = 1.5;
/** A WHEEE! pops this high (m) over the flier's torso. */
const WHEE_POP_UP = 0.9, WHEE_POP_SIZE = 1.3;
/** A rope spring's word, popped this high (m) over where it springs off the bumper, this big. */
export const ROPE_POP = 'BOING!';
const ROPE_POP_UP = 1, ROPE_POP_SIZE = 1.1;
/**
 * The wild ring's words (design 2026-11-14 §5.1): a spring pad firing, a pinball post's kick, the beach ball's bonk,
 * and a grab (a throw has WHEEE!), popped this high (m) over where it happened, this big.
 */
export const PAD_POP = 'SPROING!', POST_POP = 'DING!', BALL_POP = 'BONK!', GRAB_POP = 'YOINK!';
const RING_POP_UP = 1, RING_POP_SIZE = 1.2;
/** A ring event's banner title, and its name as the announcer says it (`{event}`). */
export const EVENT_TITLE: Record<RingEventName, string> = {
  bounceParty: 'BOUNCE PARTY!', moonJump: 'MOON JUMP!', beachBall: 'BEACH BALL!', pinball: 'PINBALL!',
};
export const EVENT_SAID: Record<RingEventName, string> = {
  bounceParty: 'Bounce Party', moonJump: 'Moon Jump', beachBall: 'Beach Ball', pinball: 'Pinball',
};

/** A creature the ring knows: what it is, its body, who made it, the name to shout. */
export type Card = { id: string; recipe: Recipe; body: BodyData; maker: string | null; name: string };
type Entry = Card & { plan: FightPlan; layout: RagdollLayout; colour: Color };

type Say = (beat: Beat, slots: Slots, o?: { priority?: boolean; text?: string; title?: string }) => { text: string; spoken: boolean };
type At = { x: number; y: number; z: number };

/** What the show drives. Everything here is injected, so the whole round (and many rounds) can be run in a test. */
export type ShowDeps<O> = {
  world: RAPIER.World; tune: Tune; rng: () => number; match: Match; loop: RingLoop; slow: SlowMo; camera: Camera;
  entrance: { run(fs: readonly Fighter[], group: boolean, champion?: Fighter | null): void; cancel(): void };
  finale: { crown(f: Fighter): void; stop(): void; clear(): void; update(dt: number): void; readonly champion: unknown };
  stars: { update(f: Fighter, dt: number): void; remove(f: Fighter): void; clear(): void };
  pops: { pop(at: Vector3, camera: Camera, word?: string, size?: number): void };
  banner: { hide(): void };
  announcer: { say: Say; warm(beat: Exclude<Beat, 'intro'>, slots: Slots, n?: number): void; prefetch(text: string): void };
  sfx: {
    boing(sizeM: number): void; bonk(): void; whoosh(): void; fanfare(): void; thud(): void; drum(): void;
    sproing(): void; ding(): void; airhorn(): void;
  };
  crowd: { roar(): void; rise(seconds: number): void; ooh(): void };
  roster: { fought(ids: string[]): Promise<void>; crowned(id: string): Promise<void> };
  /**
   * The fighter's picture: made when its ragdoll is, driven each frame, disposed with it. `glow` sets how strongly it
   * glows (0 … 1) for its special, every frame.
   */
  objects: { make(card: Card, layout: RagdollLayout): O; drive(o: O, f: Fighter, dt: number): void; dispose(o: O): void; glow(o: O, level: number): void };
  /** The camera's gentle shake at a special's impact (`CameraDirector`; its shots follow `frame`'s cues). */
  director: { shake(amp: number): void };
  /** Specials' floor shockwaves (`Shockwaves`). */
  shockwaves: { spawn(at: At, radius: number): void; update(dt: number): void; clear(): void };
  /** Fliers' motion trails (`Trails`), keyed by fighter. */
  trails: {
    update(key: object, at: At, height: number, air: boolean, colour: Color, dt: number): void; flush(): void; remove(key: object): void; clear(): void;
  };
  /** The wild ring's looks (`RingLooks`: rim lights, spotlights, event looks, the crowd, confetti, the props), if drawn. */
  looks?: Looks;
};

const _at = new Vector3();
const ROUND: ShotCue = { kind: 'round' };

/** "A", "A and B", "A, B and C". */
export const namesOf = (ns: readonly string[]) => (ns.length < 2 ? ns.join('') : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

/**
 * The Rumble's show (spec §2): turns the match's events into entrances, words, sounds and pictures, and runs the ring
 * loop once a frame. A fighter's ragdoll and picture exist only from its entrance until it has fallen (so those waiting
 * on deck hold no collision bit); a creature's card is kept while the match still knows it.
 */
export class RumbleShow<O> {
  /** The crowned champion (camera push-in, crown), or null. */
  champion: Fighter | null = null;
  private readonly cards = new Map<string, Entry>();
  private readonly objects = new Map<Fighter, O>();
  private now = 0;
  /** Quick-fill: the next entrance is skipped, its fighters placed straight in the ring. */
  private quiet = false;
  /** Who a group entrance after Again! walks in last (the last champion, still wearing its crown). */
  private lastChampion: Fighter | null = null;
  private lone: { id: string; next: number } | null = null;
  /** Fighters whose special is winding up or playing (charge … end): they glow strongly. */
  private readonly charged = new Set<Fighter>();
  /** When each flier last popped a WHEEE!, and when the crowd last oohed (show s). */
  private readonly wheeAt = new Map<Fighter, number>();
  private oohAt = -Infinity;
  /** A round's first seconds, for the camera's crane (handed out with the next frame's cues). */
  private roundCue = false;
  /** The frame's moments for the camera (one list, refilled each frame: read it before the next frame). */
  private readonly shotList: ShotCue[] = [];
  /** Called with every special cue after the show has played it (the dev panel's shot waits on an impact). */
  onCue: (c: SpecialCue) => void = () => {};

  constructor(private readonly d: ShowDeps<O>) {
    d.loop.onEvents = (evs) => this.onMatch(evs);
    d.loop.onGone = (f) => this.gone(f);
    d.announcer.warm('tie', {});
    d.announcer.warm('again', {});
    for (const ev of RING_EVENTS) d.announcer.warm('ringEvent', { event: EVENT_SAID[ev] }, 1);
  }

  /** How many cards it keeps (bounded: only creatures the match still knows). */
  get cardCount(): number { return this.cards.size; }
  get objectCount(): number { return this.objects.size; }
  /** How many fighters glow for a special now (charge … end). */
  get chargedCount(): number { return this.charged.size; }
  card(id: string): Card | undefined { return this.cards.get(id); }
  /** The picture of a fighter in the ring. */
  object(f: Fighter): O | undefined { return this.objects.get(f); }
  /** Is this creature in the ring, entering or on deck? */
  known(id: string): boolean {
    const m = this.d.match;
    return m.fighting.includes(id) || m.entering.includes(id) || m.onDeck.includes(id);
  }

  /** How a creature fights and its ragdoll's layout; throws when its recipe and body cannot make a fighter. */
  static check(recipe: Recipe, body: BodyData): { plan: FightPlan; layout: RagdollLayout } {
    const plan = planFor(recipe, body.skeleton);
    return { plan, layout: ragdollLayout(body.skeleton, plan) };
  }

  /** Learn a creature (a release, a send-back, a fixture): its intro starts fetching now, so its entrance never waits. */
  register(c: Card): void {
    const { plan, layout } = RumbleShow.check(c.recipe, c.body);
    this.cards.set(c.id, { ...c, plan, layout, colour: trailColour(c.recipe) });
    this.d.announcer.prefetch(introText(plan.intro, this.slots(c.id)));
  }

  /** Into the ring (an entrance follows; past 8 they wait on deck). Unknown ids are skipped. */
  arrive(ids: string[]): void {
    const known = ids.filter((id) => this.cards.has(id));
    this.d.match.arrive(known);
    this.warmBigMoments(known);
    this.warmGroup([...new Set([...this.d.match.entering, ...known])]);
  }

  /** Gets the big moments of these fighters decoded (their ring-out, crown, taunt and boast), so they can be spoken. */
  private warmBigMoments(ids: string[]): void {
    const { announcer } = this.d;
    for (const id of ids) {
      const name = this.name(id);
      announcer.warm('ringOut', { other: name }, 1);
      for (const beat of ['lone', 'holdsRing', 'crown'] as const) announcer.warm(beat, { name }, 1);
      const move = this.cards.get(id)?.plan.move;
      if (move) announcer.warm('special', this.specialSlots(id, SPECIAL_FOR[move]), 1);
    }
  }

  /** Gets the group entrance line for these fighters decoded. */
  private warmGroup(ids: string[]): void {
    if (ids.length > 1) this.d.announcer.warm('groupIntro', { names: namesOf(ids.map((id) => this.name(id))) }, 1);
  }

  /** Dev: `ids` (registered) straight into the ring with no entrance. */
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

  /** "Crown the champion!" (TV menu, phone, dev): only while the ring is open with someone fighting. True when it crowned. */
  crown(): boolean {
    const { match, loop, entrance, finale } = this.d;
    if (match.phase !== 'open' || match.fighting.length === 0) return false;
    for (const e of match.crown(loop.hits())) {
      if (e.type !== 'crowned') continue;
      // anyone mid-entrance went back on deck: it is made again when it enters
      entrance.cancel();
      for (const f of loop.all()) if (f.state === 'entering') loop.remove(f.id);
      const champ = loop.get(e.id) ?? null;
      for (const f of loop.all()) {
        f.resetSpecial(); // no special carries on through the crowning, the champion's included
        f.endHold(); // nor a hold
        if (f !== champ && f.state === 'fighting') f.stun = 999; // the others flop over defeated
      }
      loop.features?.reset(); // no ring event goes on through the crowning
      this.d.looks?.crown();
      this.champion = champ;
      loop.champion = champ;
      this.lone = null;
      this.charged.clear();
      if (champ) finale.crown(champ);
      this.d.sfx.fanfare();
      this.d.crowd.roar();
      this.d.announcer.say('crown', this.slots(e.id));
      this.warmGroup([...match.fighting]); // the Again! entrance is likely next
      void this.d.roster.crowned(e.id).catch((err) => console.warn('could not mark the champion', err));
    }
    return true;
  }

  /** "Again!": after a crowning, the same cast plus anyone made meanwhile, in one group entrance. True when it went. */
  again(): boolean {
    const { match, loop, finale, stars } = this.d;
    if (match.phase !== 'crowned') return false;
    finale.stop(); // the champion keeps its crown for the group entrance
    this.lastChampion = this.champion;
    this.champion = null;
    loop.champion = null;
    for (const f of loop.all()) {
      if (f.state === 'out' || f.state === 'gone') loop.remove(f.id);
      else { f.stun = 0; f.wobble = 0; f.resetSpecial(); f.endHold(); } // everyone starts the new round with an empty meter
    }
    loop.resetHits();
    loop.features?.reset(); // the new round's first event comes 25–35 s in
    this.d.looks?.reset();
    stars.clear();
    this.clearSpectacle();
    this.lone = null;
    this.onMatch(match.again());
    // anyone left on deck (more than 8) is made again when it enters
    for (const f of loop.all()) if (!match.entering.includes(f.id)) loop.remove(f.id);
    this.prune();
    return true;
  }

  /** "Clear the ring": everyone out (back to the roster), the start screen comes back. */
  reset(): void {
    const { match, loop, entrance, finale, stars, banner } = this.d;
    entrance.cancel();
    loop.clear();
    match.reset();
    finale.clear();
    stars.clear();
    this.clearSpectacle();
    this.d.looks?.reset();
    banner.hide();
    this.champion = this.lastChampion = null;
    this.lone = null;
    this.prune();
  }

  /**
   * One frame (`dt` real s, `now` the show clock in s): the ring loop, the hits' show, the lone taunt, pictures.
   * Hands back the frame's hits and ring-outs, and the moments the camera's shots cut to (`cues`: refilled every
   * frame, so it is read before the next).
   */
  frame(dt: number, now: number): { hits: Hit[]; outs: string[]; cues: ShotCue[] } {
    this.now = now;
    const { loop, match, announcer } = this.d;
    const r = loop.step(dt, now);
    for (const c of r.specials) {
      try {
        this.special(c);
      } catch (err) {
        console.error(`the show failed on a special's ${c.phase}`, err);
      }
    }
    for (const c of r.stunts) this.stunt(c);
    for (const c of r.features) this.feature(c);
    for (const h of r.hits) this.hit(h);
    this.d.looks?.update(dt, loop.features ?? null);
    if (this.lone) {
      const id = this.lone.id;
      const still = match.phase === 'open' && match.fighting.length === 1 && match.fighting[0] === id && !match.entering.length && !match.onDeck.length;
      if (!still) this.lone = null;
      else if (now >= this.lone.next) {
        // never over a big line (an intro still speaking): a taunt that could not be said is tried again soon
        const said = announcer.say('lone', this.slots(id)).text !== '';
        this.lone.next = now + (said ? LONE_EVERY_S : LONE_RETRY_S);
      }
    }
    for (const f of loop.all()) {
      const o = this.objects.get(f);
      if (o !== undefined) {
        this.d.objects.drive(o, f, dt);
        this.d.objects.glow(o, this.glow(f, now));
      }
      this.d.stars.update(f, dt);
      this.air(f, dt, now);
    }
    this.d.trails.flush();
    this.d.shockwaves.update(dt);
    this.d.finale.update(dt);
    const cues = shotCues(r, this.d.tune.bigLaunch, this.shotList);
    if (this.roundCue) cues.push(ROUND);
    this.roundCue = false;
    return { hits: r.hits, outs: r.outs, cues };
  }

  private name(id: string): string {
    return this.cards.get(id)?.name ?? 'OUR HERO';
  }

  private slots(id: string): Slots {
    const c = this.cards.get(id);
    return { name: c?.name, maker: c?.maker ?? undefined, weight: c?.plan.weight };
  }

  /** The words of a special's line: who does it and what it is called (the same words its warm-up decoded). */
  private specialSlots(id: string, s: SpecialName): Slots {
    return { name: this.name(id), special: specialSaid(s) };
  }

  /** How strongly a fighter glows now: strongly while its special plays, faintly as its meter fills, not once it is out. */
  private glow(f: Fighter, now: number): number {
    const on = this.charged.has(f) || (f.state === 'fighting' && f.special.active !== null);
    if (!on && f.state !== 'fighting') return 0;
    return glowLevel(f.special.meter, on, now);
  }

  /**
   * A special's moment (big-fights design §3). charge: it glows, its name goes up on the banner with a line, a drum hit
   * and the crowd rising. release: a whoosh and a slow-mo (the camera cuts to a hero shot on it: `shotCues`). impact: a shockwave on the floor,
   * a big word, a gentle shake and a roar. end: the glow goes.
   */
  private special(c: SpecialCue): void {
    const { loop, announcer, sfx, crowd, slow, director, shockwaves, pops, camera } = this.d;
    const f = loop.get(c.id) ?? null;
    if (c.phase === 'charge') {
      if (f) { // a charge from a fighter already let go (the ring cleared) makes no noise
        this.charged.add(f);
        announcer.say('special', this.specialSlots(c.id, c.special), { title: SPECIAL_TITLE[c.special] });
        sfx.drum();
        crowd.rise(CHARGE_RISE_S);
      }
    } else if (c.phase === 'release') {
      sfx.whoosh();
      slow.trigger(this.now);
    } else if (c.phase === 'impact') {
      const radius = c.radius ?? IMPACT_RING;
      shockwaves.spawn(c.at, radius);
      pops.pop(_at.set(c.at.x, Math.max(0, c.at.y) + IMPACT_POP_UP, c.at.z), camera, SPECIAL_POP[c.special], SPECIAL_POP_SIZE);
      director.shake(shakeFor(radius));
      sfx.thud();
      crowd.roar();
      this.d.looks?.cheer();
    } else if (f) this.charged.delete(f);
    this.onCue(c);
  }

  /**
   * A stunt's moment (wild ring §3): a whoosh as a leap takes off or a throw lets go, a BOING! as a rope spring springs
   * off the bumper. (The camera's shots follow these cues too: `shotCues`.)
   */
  private stunt(c: StuntCue): void {
    const { sfx, pops, camera, loop } = this.d;
    if ((c.stunt === 'leap' || c.stunt === 'throw') && c.phase === 'start') sfx.whoosh();
    else if (c.stunt === 'ropeSpring' && c.phase === 'land') {
      pops.pop(_at.set(c.at.x, c.at.y + ROPE_POP_UP, c.at.z), camera, ROPE_POP, ROPE_POP_SIZE);
      sfx.boing(loop.get(c.id)?.layout.ringHeight ?? 1);
    }
    if (c.phase !== 'start' || !c.other || (c.stunt !== 'grab' && c.stunt !== 'throw')) return;
    const o = loop.get(c.other);
    const at = o && o.ragdoll.pieces.length ? o.ragdoll.torso.body.translation() : c.at;
    if (c.stunt === 'grab') {
      // YOINK! over the one picked up, and a line (it is up there a second: time to read it)
      pops.pop(_at.set(at.x, at.y + RING_POP_UP, at.z), camera, GRAB_POP, RING_POP_SIZE);
      if (this.d.announcer.say('throw', { name: this.name(c.id), other: this.name(c.other) }).text) this.warmHits('throw');
    } else if (o) {
      // WHEEE! as it is let go (its flight's own WHEEE! waits its turn)
      this.wheeAt.set(o, this.now);
      pops.pop(_at.set(at.x, at.y + WHEE_POP_UP, at.z), camera, WHEEE, WHEE_POP_SIZE);
    }
  }

  /**
   * The wild ring's moments (design §5.1): a pad's SPROING!, a post's DING!, the ball's BONK!, each with its sound; a
   * ring event's start goes up on the banner with its line, an air horn and a roar.
   */
  private feature(c: FeatureCue): void {
    const { sfx, pops, camera, announcer, crowd } = this.d;
    this.d.looks?.cue(c);
    if (c.type === 'event') {
      if (c.phase !== 'start') return;
      announcer.say('ringEvent', { event: EVENT_SAID[c.event] }, { title: EVENT_TITLE[c.event] });
      sfx.airhorn();
      crowd.roar();
      return;
    }
    const word = c.type === 'pad' ? PAD_POP : c.type === 'bump' ? POST_POP : BALL_POP;
    pops.pop(_at.set(c.at.x, Math.max(0, c.at.y) + RING_POP_UP, c.at.z), camera, word, RING_POP_SIZE);
    if (c.type === 'pad') sfx.sproing();
    else if (c.type === 'bump') sfx.ding();
    else sfx.boing(2 * BALL_R);
  }

  /**
   * Air time: a flier leaves a trail, and a WHEEE! once it is high. Fighters walking in or gone never trail, nor does
   * one doing a stunt (a leap or a dash is not a flight: it has its own whoosh), nor one held over a thrower's head.
   * In Moon Jump every fighter's trail stays on, flying or not (wild ring §5.2).
   */
  private air(f: Fighter, dt: number, now: number): void {
    if (!f.ragdoll.pieces.length) return;
    const body = f.ragdoll.torso.body, p = body.translation();
    let flying = false;
    if ((f.state === 'fighting' && f.stunt === null && !f.held) || f.state === 'out') {
      const v = body.linvel();
      flying = airborne(p.y, f.layout.standHeight, v.y, outward(p.x, p.z, v.x, v.z));
    }
    const moon = f.state === 'fighting' && !f.held && trailsOn(this.d.loop.features?.event?.name);
    const trailing = flying || moon;
    const colour = this.cards.get(f.id)?.colour;
    if (colour) this.d.trails.update(f, p, f.layout.ringHeight, trailing, colour, dt);
    if (flying && p.y - f.layout.standHeight >= WHEE_HEIGHT) this.whee(f, p, now);
  }

  /** A big launch: WHEEE! over the flier (at most every WHEE_GAP s each) and the crowd's ooh (at most every OOH_GAP s). */
  private whee(f: Fighter, p: At, now: number): void {
    if (now - (this.wheeAt.get(f) ?? -Infinity) < WHEE_GAP) return;
    this.wheeAt.set(f, now);
    this.d.pops.pop(_at.set(p.x, p.y + WHEE_POP_UP, p.z), this.d.camera, WHEEE, WHEE_POP_SIZE);
    if (now - this.oohAt >= OOH_GAP) {
      this.oohAt = now;
      this.d.crowd.ooh();
    }
  }

  /** Glows, trails, shockwaves and WHEEE! times all go (a new round, or the ring cleared). */
  private clearSpectacle(): void {
    this.charged.clear();
    this.wheeAt.clear();
    this.d.trails.clear();
    this.d.shockwaves.clear();
  }

  /** The fighter for an entrance: the one still standing in the ring (after Again!), or a new one. Null if it cannot be made. */
  private fighterFor(id: string): Fighter | null {
    const { loop, world, tune, rng } = this.d;
    const have = loop.get(id);
    if (have && (have.state === 'fighting' || have.state === 'entering')) return have;
    if (have) loop.remove(id);
    const c = this.cards.get(id);
    if (!c) {
      console.warn(`no card for ${id}: it cannot enter`);
      return null;
    }
    if (!loop.makeRoom()) {
      console.warn(`no room for ${id}'s ragdoll`);
      return null;
    }
    const f = new Fighter(id, world, c.layout, c.plan, { tune, rng });
    loop.add(f);
    this.objects.set(f, this.d.objects.make(c, c.layout));
    return f;
  }

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
    const { announcer, entrance } = this.d;
    if (e.type === 'entranceStart') {
      const fs = e.ids.map((id) => this.fighterFor(id)).filter((f): f is Fighter => f !== null);
      if (this.quiet) this.place(fs);
      else {
        const champ = this.lastChampion && fs.includes(this.lastChampion) ? this.lastChampion : null;
        entrance.run(fs, e.group, champ);
        if (e.ids.length === 1) announcer.say('intro', this.slots(e.ids[0]), { text: this.cards.get(e.ids[0])?.plan.intro });
        else announcer.say('groupIntro', { names: namesOf(e.ids.map((id) => this.name(id))) });
      }
    } else if (e.type === 'entranceEnd') {
      for (const id of e.ids) {
        const f = this.d.loop.get(id);
        if (f && f.state === 'entering') f.state = 'fighting'; // the match's clock is the one that counts
      }
      this.lastChampion = null;
      // the round's first seconds: everyone fighting has just come in (the first fighters, or the Again! group)
      if (this.d.match.fighting.length && this.d.match.fighting.every((id) => e.ids.includes(id))) this.roundCue = true;
      // anyone the match brought in with no fighter in the ring (it could not be made, or it broke) is ruled out
      const missing = e.ids.filter((id) => !this.d.loop.get(id));
      if (missing.length) this.onMatch(this.d.match.ringOut(missing));
      this.warmHits();
    } else if (e.type === 'ringOut') this.ringOut(e.ids);
    else if (e.type === 'holdsRing') {
      // it comes with the ring-out's line: if that is still up, the boast follows a little later
      const said = announcer.say('holdsRing', this.slots(e.id)).text !== '';
      this.lone = { id: e.id, next: this.now + (said ? LONE_EVERY_S : LONE_RETRY_S) };
    } else if (e.type === 'lone') this.lone = { id: e.id, next: this.now }; // taunted at once (this frame), then every 12 s
    else if (e.type === 'tie') announcer.say('tie', {});
    else if (e.type === 'again') announcer.say('again', {});
  }

  /** Quick-fill: stand them round the middle facing in, fighting at once. */
  private place(fs: Fighter[]): void {
    const R = this.d.tune.ringRadius;
    fs.forEach((f, i) => {
      const a = (i / Math.max(1, fs.length)) * Math.PI * 2 + 0.3;
      _at.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(R * FILL_AT);
      f.ragdoll.pose(_at, Math.atan2(-_at.x, -_at.z));
      f.state = 'fighting';
    });
  }

  private ringOut(ids: string[]): void {
    const { loop, pops, camera, stars, finale, sfx, crowd, announcer, slow, roster } = this.d;
    for (const id of ids) {
      const f = loop.get(id);
      if (!f) continue;
      const p = f.ragdoll.pos();
      pops.pop(_at.set(p.x, Math.max(p.y, -1) + 2, p.z), camera, BYE_BYE, 1.3);
      this.d.looks?.ringOut(p); // confetti from the two posts nearest where it flew out
      stars.remove(f);
      if (finale.champion === f) finale.clear();
    }
    sfx.whoosh();
    crowd.roar();
    slow.trigger(this.now);
    announcer.say('ringOut', { other: namesOf(ids.map((id) => this.name(id))) });
    void roster.fought(ids).catch((e) => console.warn('could not count the bout', e));
  }

  private hit(h: Hit): void {
    const { pops, camera, sfx, slow, announcer, tune } = this.d;
    pops.pop(h.at, camera, undefined, 0.8 + h.power * 0.2);
    sfx.bonk();
    sfx.boing(h.target.layout.ringHeight);
    const p = h.target.ragdoll.torso.body.translation();
    if (h.launch >= WHEE_LAUNCH) this.whee(h.target, p, this.now);
    const big = bigLaunch(p, tune.ringRadius, h, tune.bigLaunch);
    this.d.looks?.hit(big, h.at);
    if (big) {
      slow.trigger(this.now);
      sfx.whoosh();
    }
    const beat = big ? 'bigHit' : 'hit';
    if (announcer.say(beat, { name: this.name(h.attacker.id), other: this.name(h.target.id) }).text) this.warmHits(beat);
  }

  /** Gets a few hit lines decoded for a likely pair in the ring, so the next one can be spoken. */
  private warmHits(only?: 'hit' | 'bigHit' | 'throw'): void {
    const ids = this.d.match.fighting;
    if (ids.length < 2) return;
    const r = this.d.rng, i = Math.floor(r() * ids.length) % ids.length;
    const j = (i + 1 + (Math.floor(r() * (ids.length - 1)) % (ids.length - 1))) % ids.length;
    const slots = { name: this.name(ids[i]), other: this.name(ids[j]) };
    for (const beat of only ? [only] : (['hit', 'bigHit', 'throw'] as const)) this.d.announcer.warm(beat, slots);
  }

  private gone(f: Fighter): void {
    const o = this.objects.get(f);
    if (o !== undefined) this.d.objects.dispose(o);
    this.objects.delete(f);
    this.d.stars.remove(f);
    this.d.trails.remove(f);
    this.charged.delete(f);
    this.wheeAt.delete(f);
    if (this.d.finale.champion === f) this.d.finale.clear();
    if (this.champion === f) this.champion = null;
    if (this.lastChampion === f) this.lastChampion = null;
    this.prune();
  }

  /** Forgets cards the match no longer knows and no fighter uses (their bodies are big; the roster keeps them). */
  private prune(): void {
    const m = this.d.match, keep = new Set([...m.fighting, ...m.entering, ...m.onDeck, ...m.lastCast]);
    for (const id of this.cards.keys()) if (!keep.has(id) && !this.d.loop.get(id)) this.cards.delete(id);
  }
}
