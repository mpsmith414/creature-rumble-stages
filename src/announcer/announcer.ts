/**
 * The announcer: picks a line for a beat of the fight, always shows the words, and speaks them only if the audio is already
 * decoded (an entrance never waits for audio). Chatter is rate-limited and never talks over a big moment; big moments interrupt.
 * Intros are framed with a drum roll, a sting on the name and a roar from the crowd.
 */
import type { Crowd } from '../audio/crowd';
import type { Mixer } from '../audio/mixer';
import type { Sfx } from '../audio/sfx';
import { fillIntro } from '../show/intro';
import type { Banner } from '../show/banner';
import type { VoiceClient } from './voice';
import { fillSlots, LINES, namesOf, type Beat, type Slots } from './lines';

export { fillSlots, LINES, namesOf, type Beat, type Slots } from './lines';

/** How many line ids are remembered, so the same words do not come back soon. */
export const RECENT_KEEP = 200;
/** The least time between two `hit` / `bigHit` lines, in milliseconds. */
export const HIT_GAP_MS = 6000;
/** Beats that interrupt anything, and are never talked over. */
const PRIORITY: ReadonlySet<Beat> = new Set<Beat>(['intro', 'groupIntro', 'knockOut', 'crown', 'tie', 'again']);
/**
 * Beats that are priority too (they cut chatter off and are never talked over by it) but never interrupt an intro: a
 * special winding up while a name is being called is dropped (the intro keeps the banner and the voice).
 */
const GENTLE: ReadonlySet<Beat> = new Set<Beat>(['special']);
/**
 * Beats that are priority but never interrupt an intro (dropped while one is up), like a special; unlike a special
 * they do cut off a knockout or a special line still up: a level mischief's start (its title must not be lost, and
 * mischief can start the moment after a knockout).
 */
const POLITE: ReadonlySet<Beat> = new Set<Beat>(['levelEvent']);
/**
 * Beats that must not be lost: a warning that a creature is about to fly. One that comes while an intro, a priority line
 * or another warning is up waits (held) and is said when that line ends; warnings waiting together are said as one line
 * naming them all. One that has waited longer than HOLD_MAX_MS is stale and dropped.
 */
const HELD: ReadonlySet<Beat> = new Set<Beat>(['aboutToFly']);
/** A held warning older than this (ms) is no longer news. */
export const HOLD_MAX_MS = 12000;
/** While a line is speaking with no known end, a held warning looks again this often (ms); and it never retries sooner than HOLD_MIN_MS. */
const HOLD_POLL_MS = 400, HOLD_MIN_MS = 50;
/** Beats that are chatter: rate-limited and always the first to give way. */
const CHATTER: ReadonlySet<Beat> = new Set<Beat>(['hit', 'bigHit']);
/** The drum roll before an intro, in seconds. */
const ROLL_S = 1;
/** How long a words-only intro waits before its sting and roar, in milliseconds. */
const SILENT_STING_MS = 2500;
/** A private stand-in that keeps `{maker}` safe from `fillSlots` until `fillIntro` fills it. */
const MAKER_MARK = '\u0000maker\u0000';

/** The last line ids said, oldest first, kept in a store (localStorage in the game). A store that throws is ignored. */
export class RecentLines {
  private ids: string[];
  constructor(private store: { get(): string[]; set(ids: string[]): void }, private keep = RECENT_KEEP) {
    try { this.ids = store.get().slice(-keep); } catch { this.ids = []; }
  }
  /** Whether this line was said lately. */
  has(id: string): boolean { return this.ids.includes(id); }
  /** Notes a line as just said. */
  add(id: string): void {
    this.ids = [...this.ids.filter((x) => x !== id), id].slice(-this.keep);
    try { this.store.set(this.ids); } catch { /* the memory is only a nicety */ }
  }
  /** How long ago this line was said, as a rank: the older, the lower (never said: -1). */
  age(id: string): number { return this.ids.indexOf(id); }
  /** Of these ids, the one heard longest ago (one never heard counts as oldest). */
  oldest(ids: string[]): string {
    return ids.reduce((a, b) => (this.ids.indexOf(b) < this.ids.indexOf(a) ? b : a));
  }
}

/** The intro of a creature as said and shown: `raw` (its recipe's `fight.intro`, or the default) with its slots filled and `{maker}` filled and capped. */
export function introText(raw: string | undefined, slots: Slots): string {
  const text = raw?.trim() || `In this corner! From the bedroom of {maker}! ${slots.weight ? 'Weighing in at {weight}! ' : ''}The one, the only... {name}!`;
  return fillIntro(fillSlots(text.replace(/\{maker\}/g, MAKER_MARK), slots).replaceAll(MAKER_MARK, '{maker}'), slots.maker);
}

type VoiceLike = Pick<VoiceClient, 'prefetch' | 'play' | 'stop' | 'isReady'>;

export class Announcer {
  private readonly o: ConstructorParameters<typeof Announcer>[0];
  private readonly recent: RecentLines;
  private readonly later: (fn: () => void, ms: number) => void;
  private lastChatter = -Infinity;
  /** Until when (ms) a priority line is still on screen. */
  private priorityUntil = -Infinity;
  private prioritySpeaking = false;
  /** Counts what was said; a line that is no longer the latest does not frame itself or clear the speaking flag. */
  private token = 0;
  /** Until when (ms) the latest intro is still up, and its token (it is still speaking while it is the latest line). */
  private introUntil = -Infinity;
  private introToken = -1;
  /** Until when (ms) the last held line (a warning) is up; the warnings waiting (who, since when); a retry is due. */
  private heldUntil = -Infinity;
  private readonly waiting: { id: string; name: string; at: number }[] = [];
  private retryDue = false;

  constructor(o: {
    voice: VoiceLike; banner: Banner; mixer: Mixer; sfx: Sfx; crowd: Crowd; rng: () => number; now: () => number;
    /** Where the recently said ids are kept (default: in memory). */
    store?: { get(): string[]; set(ids: string[]): void };
    /** Runs `fn` after `ms` milliseconds (default: setTimeout). */
    later?: (fn: () => void, ms: number) => void;
  }) {
    this.o = o;
    let mem: string[] = [];
    this.recent = new RecentLines(o.store ?? { get: () => mem, set: (ids) => void (mem = ids) });
    this.later = o.later ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  /** Start fetching and decoding `text` now (the exact text `say` will show, e.g. from `introText`). */
  prefetch(text: string): void {
    this.o.voice.prefetch(text);
  }

  /** Get a few lines of a beat decoded ahead of time, so that one of them can be spoken when the beat comes. */
  warm(beat: Exclude<Beat, 'intro'>, slots: Slots, n = 3): void {
    const bank = LINES[beat];
    const pool = this.candidates(beat);
    for (let k = 0; k < n && pool.length; k++) {
      const [i] = pool.splice(Math.floor(this.o.rng() * pool.length) % pool.length, 1);
      this.o.voice.prefetch(fillSlots(bank[i], slots));
    }
  }

  /** Is an intro (or a group's) still up or still speaking? */
  private introOn(now: number): boolean {
    return now < this.introUntil || (this.prioritySpeaking && this.token === this.introToken);
  }

  /**
   * Say a line for a beat: shown on the banner always, spoken only if its audio is ready. `text` is an intro's own words (the
   * recipe's `fight.intro`); `title` is the banner's big words over the line (a special's name). Chatter that is too soon,
   * or that would talk over a priority line, is dropped (`text: ''`), as is a special while any priority line is still up.
   */
  say(beat: Beat, slots: Slots, o: { priority?: boolean; text?: string; title?: string } = {}): { text: string; spoken: boolean } {
    const { voice, banner, mixer, sfx, crowd } = this.o;
    const now = this.o.now();
    const priority = o.priority ?? (PRIORITY.has(beat) || GENTLE.has(beat) || POLITE.has(beat));
    if (HELD.has(beat) && this.heldBack(now)) {
      this.hold(slots.name ?? '', slots.name ?? '', now);
      return { text: '', spoken: false };
    }
    if (POLITE.has(beat) && this.introOn(now)) return { text: '', spoken: false };
    const framed = beat === 'intro' || beat === 'groupIntro';
    // A special never cuts off an intro, a knockout, a tie or another special still up: it waits its turn (dropped).
    if (GENTLE.has(beat) && (this.introOn(now) || now < this.priorityUntil || this.prioritySpeaking)) return { text: '', spoken: false };
    if (!priority) {
      if (now < this.priorityUntil || this.prioritySpeaking) return { text: '', spoken: false };
      if (CHATTER.has(beat) && now - this.lastChatter < HIT_GAP_MS) return { text: '', spoken: false };
    }
    const text = beat === 'intro' ? introText(o.text, slots) : this.pick(beat, slots);
    const mine = ++this.token;
    if (priority) voice.stop(); // the old line ends now (its duck and framing are over: its token is stale)
    if (CHATTER.has(beat)) this.lastChatter = now;

    const title = o.title ?? (beat === 'intro' || beat === 'crown' ? (slots.name ?? '').toUpperCase() : beat === 'groupIntro' ? (slots.names ?? '').toUpperCase() : '');
    const shownFor = beat === 'intro' ? 9 : Math.min(8, Math.max(2.5, text.length * 0.07));
    if (framed) sfx.drumRoll(ROLL_S);
    banner.show(title, text, shownFor);
    if (beat === 'tie') crowd.aww();

    const frame = () => {
      if (!framed || mine !== this.token) return;
      sfx.sting();
      crowd.roar();
    };
    // The words are up now; the voice comes after the drum roll of an intro (it is the roll that frames the line).
    const start = (): { spoken: boolean; seconds: number } => {
      const r = voice.play(text, () => {
        mixer.duckForVoice(false);
        if (mine === this.token) this.prioritySpeaking = false;
        frame();
      });
      if (r.spoken) mixer.duckForVoice(true);
      else if (mine === this.token) this.prioritySpeaking = false;
      return r;
    };
    if (framed) this.introToken = mine;
    else if (priority) this.introUntil = -Infinity; // a big line cut the intro off: it is over
    if (framed && voice.isReady(text)) {
      this.prioritySpeaking = true;
      this.priorityUntil = this.introUntil = now + (ROLL_S + shownFor) * 1000;
      this.later(() => { if (mine === this.token) start(); }, ROLL_S * 1000);
      return { text, spoken: true };
    }
    const r = framed ? { spoken: false, seconds: 0 } : start();
    this.prioritySpeaking = r.spoken && priority;
    if (!r.spoken && framed) this.later(frame, SILENT_STING_MS);
    if (priority) this.priorityUntil = now + Math.max(shownFor, r.seconds) * 1000;
    if (framed) this.introUntil = this.priorityUntil;
    if (HELD.has(beat)) this.heldUntil = now + Math.max(shownFor, r.seconds) * 1000;
    return { text, spoken: r.spoken };
  }

  /** Whether a held beat must wait: an intro, a priority line or another warning is still up (or speaking). */
  private heldBack(now: number): boolean {
    return this.introOn(now) || now < this.priorityUntil || this.prioritySpeaking || now < this.heldUntil;
  }

  /**
   * Warns that the creatures in `who` (each its fighter id and name) are about to fly: one line naming them all, said
   * now, or, while another line holds it back, held (each by its id, so `cancelHeld` can take one back) and said when
   * that line ends.
   */
  warn(who: readonly { id: string; name: string }[]): { text: string; spoken: boolean } {
    if (!who.length) return { text: '', spoken: false };
    const now = this.o.now();
    if (this.heldBack(now)) {
      for (const w of who) this.hold(w.id, w.name, now);
      return { text: '', spoken: false };
    }
    return this.say('aboutToFly', { name: namesOf(who.map((w) => w.name)) });
  }

  /**
   * Takes back a held warning for fighter `id` (it went out, cooled down or left the stage): it is never said. A line
   * already said is not affected.
   */
  cancelHeld(id: string): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) if (this.waiting[i].id === id) this.waiting.splice(i, 1);
  }

  /** Keeps a warning for fighter `id` (`name`) to say when the line up now ends. */
  private hold(id: string, name: string, now: number): void {
    if (!this.waiting.some((w) => w.id === id)) this.waiting.push({ id, name, at: now });
    this.retry(now);
  }

  /** Looks again when the line holding the warnings back should be over. */
  private retry(now: number): void {
    if (this.retryDue) return;
    this.retryDue = true;
    const ends = Math.max(this.priorityUntil, this.introUntil, this.heldUntil) - now;
    const wait = ends > 0 ? ends : HOLD_POLL_MS;
    this.later(() => {
      this.retryDue = false;
      this.sayWaiting();
    }, Math.max(HOLD_MIN_MS, wait));
  }

  /** Says the warnings waiting, as one line naming them all, once nothing holds them back (stale ones are dropped). */
  private sayWaiting(): void {
    const now = this.o.now();
    for (let i = this.waiting.length - 1; i >= 0; i--) if (now - this.waiting[i].at > HOLD_MAX_MS) this.waiting.splice(i, 1);
    if (!this.waiting.length) return;
    if (this.heldBack(now)) {
      this.retry(now);
      return;
    }
    const names = this.waiting.splice(0).map((w) => w.name).filter((n) => n);
    this.say('aboutToFly', names.length ? { name: namesOf(names) } : {});
  }

  /** A line of the beat that was not said lately (one that is already decoded is preferred; all said lately: the oldest). */
  private pick(beat: Exclude<Beat, 'intro'>, slots: Slots): string {
    const bank = LINES[beat];
    const from = this.candidates(beat);
    const ready = from.filter((k) => this.o.voice.isReady(fillSlots(bank[k], slots)));
    const choice = ready.length ? ready : from;
    const i = choice[Math.floor(this.o.rng() * choice.length) % choice.length];
    this.recent.add(`${beat}:${i}`);
    return fillSlots(bank[i], slots);
  }

  /** The line indexes that may be said next: those not said lately; once all were, the longest-ago half of the bank. */
  private candidates(beat: Exclude<Beat, 'intro'>): number[] {
    const ids = LINES[beat].map((_, i) => `${beat}:${i}`);
    const fresh = ids.map((_, i) => i).filter((i) => !this.recent.has(ids[i]));
    if (fresh.length) return fresh;
    const byAge = [...ids].sort((a, b) => this.recent.age(a) - this.recent.age(b));
    return byAge.slice(0, Math.ceil(ids.length / 2)).map((id) => ids.indexOf(id));
  }
}
