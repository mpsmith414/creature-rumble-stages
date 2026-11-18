import { namesOf, type Beat, type Slots } from '../announcer/lines';
import { SPECIAL_TITLE, specialSaid } from '../fight/special';
import { damageStep, type StageTune } from '../stage/damage';
import { ITEM_TITLE } from '../stage/items';
import { MISCHIEF_TITLE } from '../stage/mischief';
import type { StageEvents } from '../stage/sim';
import type { V2 } from '../stage/types';
import { POP_WORDS } from './pops';

/**
 * What the show does for one step of the stage fight (spec §9.3): the announcer's beats (hits as chatter, a big launch
 * as a big hit, a special winding up, a grab, a present from the sky, a level's mischief starting, a knockout, and the
 * "about to fly" warning as a creature's damage reaches its last step), the comic words that pop up, and the sounds.
 * It only decides; the caller says, pops and plays them (the announcer rate-limits its own chatter). Display only.
 */

/** One thing for the show to do: an announcer line, a word popping up at a spot, a sound. */
export type Call =
  | { kind: 'say'; beat: Exclude<Beat, 'intro'>; slots: Slots; title?: string }
  /** Creatures now about to fly (each id and name): the announcer's `warn`, one line naming them all, held if need be. */
  | { kind: 'warn'; who: { id: string; name: string }[] }
  /** Take back a warning still held for `id` (it went out, cooled down or left): the announcer's `cancelHeld`. */
  | { kind: 'cancel'; id: string }
  | { kind: 'pop'; at: V2; word: string; size: number }
  | { kind: 'sound'; sound: 'bonk' | 'boing' | 'whoosh' | 'thud' | 'airhorn' | 'ding' | 'sproing' };

/** The words popped for a toy-train bump, a custard pie's splat and a special's blow. */
export const TRAIN_POP = 'TOOT TOOT!', SPLAT_POP = 'SPLAT!', IMPACT_POP = 'KA-BOOM!';
/** Pop sizes: a hit, a launch (a tumble), a special's blow, a power-up opened, a bump. */
const HIT_SIZE = 1, LAUNCH_SIZE = 1.4, IMPACT_SIZE = 1.7, OPEN_SIZE = 1.25, BUMP_SIZE = 1.2;
/** The banner's title over a present's line. */
const PRESENT_TITLE = 'A PRESENT!';
/** The last damage step: "about to fly". */
const FLY = 3;

/** What the warning needs of a fighter in play (a `StageFighter` will do). */
type Hot = { readonly id: string; readonly damage: number; readonly tune: StageTune };

export class StageCalls {
  /** The damage step each fighter in play was last seen at. */
  private readonly steps = new Map<string, number>();
  /** Scratch: the fighters reaching "about to fly" this step. */
  private hot: { id: string; name: string }[] = [];

  /** `name` gives a fighter's name by id; `rng` picks the hit words. */
  constructor(private readonly name: (id: string) => string, private readonly rng: () => number = Math.random) {}

  /** The calls for one step's events, in order, with `fighters` in play (for the warning); appended to `out`. */
  calls(e: StageEvents, fighters: readonly Hot[], out: Call[] = []): Call[] {
    for (const h of e.hits) {
      const word = POP_WORDS[Math.floor(this.rng() * POP_WORDS.length) % POP_WORDS.length];
      out.push({ kind: 'pop', at: h.at, word, size: h.tumble ? LAUNCH_SIZE : HIT_SIZE });
      out.push({ kind: 'sound', sound: 'bonk' });
      if (h.tumble) out.push({ kind: 'sound', sound: 'whoosh' });
      out.push({ kind: 'say', beat: h.tumble ? 'bigHit' : 'hit', slots: { name: this.name(h.attacker), other: this.name(h.target) } });
    }
    for (const b of e.bumps) {
      out.push({ kind: 'pop', at: b.at, word: TRAIN_POP, size: BUMP_SIZE });
      out.push({ kind: 'sound', sound: 'boing' });
    }
    for (const c of e.specials) {
      if (c.phase === 'charge') {
        out.push({ kind: 'say', beat: 'special', slots: { name: this.name(c.id), special: specialSaid(c.special) }, title: SPECIAL_TITLE[c.special] });
      } else if (c.phase === 'impact') {
        out.push({ kind: 'pop', at: c.at, word: IMPACT_POP, size: IMPACT_SIZE });
        out.push({ kind: 'sound', sound: 'thud' });
      }
    }
    for (const g of e.grabs) {
      if (g.phase === 'grab') out.push({ kind: 'say', beat: 'throw', slots: { name: this.name(g.id), other: this.name(g.other) } });
      else if (g.phase === 'throw') out.push({ kind: 'sound', sound: 'whoosh' });
    }
    for (const c of e.items) {
      if (c.phase === 'drop') {
        out.push({ kind: 'say', beat: 'present', slots: { event: ITEM_TITLE[c.item] }, title: PRESENT_TITLE });
        out.push({ kind: 'sound', sound: 'ding' });
      } else if (c.phase === 'open') {
        out.push({ kind: 'pop', at: c.at, word: `${ITEM_TITLE[c.item]}!`, size: OPEN_SIZE });
        out.push({ kind: 'sound', sound: 'sproing' });
      } else if (c.phase === 'end' && c.item === 'custardPie' && c.target) {
        out.push({ kind: 'pop', at: c.at, word: SPLAT_POP, size: LAUNCH_SIZE });
      }
    }
    for (const m of e.mischief) {
      if (m.phase !== 'start') continue;
      const title = MISCHIEF_TITLE[m.name];
      out.push({ kind: 'say', beat: 'levelEvent', slots: { event: title }, title: `${title}!` });
      out.push({ kind: 'sound', sound: 'airhorn' });
    }
    if (e.outs.length) {
      out.push({ kind: 'say', beat: 'knockOut', slots: { other: namesOf(e.outs.map(this.name)) } });
      out.push({ kind: 'sound', sound: 'whoosh' });
    }
    // everyone reaching "about to fly" is warned: several the same step in one line naming them all (the announcer
    // holds a warning that comes while another line is up and says it after). One knocked out this very step is not
    // (its knockout is called instead); one that cools back down (an Ice Pop) has a warning still held taken back.
    const hot = this.hot;
    for (const f of fighters) {
      const step = damageStep(f.damage, f.tune), was = this.steps.get(f.id) ?? 0;
      this.steps.set(f.id, step);
      if (step === FLY && was < FLY && !e.outs.includes(f.id)) hot.push({ id: f.id, name: this.name(f.id) });
      else if (step < FLY && was === FLY) out.push({ kind: 'cancel', id: f.id });
    }
    if (hot.length) {
      out.push({ kind: 'warn', who: hot });
      this.hot = [];
    }
    return out;
  }

  /**
   * Forgets `id` (it went out or left the stage: a comeback starts afresh). Returns the call that takes back a warning
   * still held for it, for the caller to pass to the announcer.
   */
  forget(id: string): Call {
    this.steps.delete(id);
    return { kind: 'cancel', id };
  }
}

/** Where the calls go: the announcer, the sounds and the pops (a pop at a spot on the stage). */
export type CallSinks = {
  announcer: {
    say(beat: Exclude<Beat, 'intro'>, slots: Slots, o?: { title?: string }): { text: string };
    warn(who: readonly { id: string; name: string }[]): { text: string };
    cancelHeld(id: string): void;
  };
  sfx: Record<Exclude<Extract<Call, { kind: 'sound' }>['sound'], 'boing'>, () => void> & { boing(sizeM: number): void };
  pop(at: V2, word: string, size: number): void;
  /** Every beat said (the dev page keeps them for its checks), if wanted. */
  said?: string[];
};

/** Does what the show decided for a step (`StageCalls.calls`): says it, warns or takes a warning back, pops it, plays it. */
export function performCall(c: Call, s: CallSinks): void {
  if (c.kind === 'say') {
    if (s.announcer.say(c.beat, c.slots, c.title ? { title: c.title } : {}).text) s.said?.push(c.beat);
  } else if (c.kind === 'warn') {
    if (s.announcer.warn(c.who).text) s.said?.push('aboutToFly');
  } else if (c.kind === 'cancel') s.announcer.cancelHeld(c.id);
  else if (c.kind === 'pop') s.pop(c.at, c.word, c.size);
  else if (c.sound === 'boing') s.sfx.boing(1);
  else s.sfx[c.sound]();
}
