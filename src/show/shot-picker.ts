import type { FeatureCue } from '../arena/features';
import type { Hit } from '../fight/fighter';
import type { SpecialCue } from '../fight/special';
import type { StuntCue } from '../fight/stunts';
import { SHOT_NAMES, type ShotName } from './shots';

/**
 * The shot director's choosing (wild ring design 2026-11-14 §6): which shot, on whom, for how long. Pure, with its
 * randomness injected (`rng`), so a whole night of shots can be checked headless.
 *
 * The rotation moves on every 5–8 s, weighted by the ring (two fighting: duels and low shots more; five or more: wide
 * and top shots more; a ring event: top, wide and the crane). The fight's moments (`ShotCue`) cut in at once, by
 * priority: a ring-out > a special's release > a grab or throw > a big launch > a pad jump > an event's start or a
 * round's first seconds > the rotation (a special's hero shot follows its own blow's launch to a flier shot). Only the
 * urgent ones cut in soon (a ring-out at once, even on another ring-out; a special or a grab or throw once the shot
 * on screen has held 1.5 s); the others wait until it has held 3.5 s, and a big launch or a pad jump does not cut in
 * again within 6 s of the last, so a busy fight still changes angle at a pace young children can follow. A special, a
 * grab or throw and an event's start are never dropped for coming too soon: they wait their turn. A special whose
 * attacker is already in the frame of the shot on screen is seen there: no close-up (owner, 2026-11-15). A shot holds at
 * most 9 s; after a cue's shot it goes back to the rotation.
 */

/** A moment the camera may cut to. */
export type ShotCue =
  /** A fighter was ruled out of the ring. */
  | { kind: 'ringOut'; id: string }
  /** A special was let go (its attacker). */
  | { kind: 'special'; id: string }
  /** A grab or a throw: the thrower and the one it holds. */
  | { kind: 'throw'; id: string; other: string }
  /** A hit sent its target (`id`) on a big flight; `by` is who hit it. */
  | { kind: 'launch'; id: string; by?: string }
  /** A spring pad fired its fighter up. */
  | { kind: 'pad'; id: string }
  /** A ring event started. */
  | { kind: 'event' }
  /** A round's first seconds (the first fighters in, or the Again! group). */
  | { kind: 'round' };
export type CueKind = ShotCue['kind'];

/** How much each moment outranks the others (the rotation is 0). */
export const CUE_RANK: Record<CueKind, number> = { ringOut: 6, special: 5, throw: 4, launch: 3, pad: 2, event: 1, round: 1 };
/** A shot the dev panel cut to (key V, a dev shot) outranks every moment, so it can be looked at. */
export const DEV_RANK = 7;
/**
 * The moments urgent enough to cut in the moment they happen (a ring-out, a special, a grab or throw). The others (a
 * big launch, a pad jump, an event's start, a round's start) wait until the shot on screen has held MIN_HOLD s.
 */
export const URGENT: ReadonlySet<CueKind> = new Set<CueKind>(['ringOut', 'special', 'throw']);
/** A big launch or a pad jump does not cut in again within CUE_COOLDOWN s of the last of its kind (they come in runs). */
export const CUE_COOLDOWN = 6;
/**
 * How long (s) the shot on screen holds before a moment may cut in: an urgent one (a special, a grab or throw) after
 * QUICK_HOLD, the others after CALM_HOLD. A ring-out cuts in at once.
 */
export const QUICK_HOLD = 1.5, CALM_HOLD = 3.5;
/** A shot holds at least this long (s) unless a higher-priority cue cuts in, and never longer than this. */
export const MIN_HOLD = 2.5, MAX_HOLD = 9;
/** The rotation moves on every ROTATE_MIN–ROTATE_MAX s. */
export const ROTATE_MIN = 5, ROTATE_MAX = 8;
/** How long (s) each moment's shot holds before the rotation comes back (a ring-out watches its fall 1.6 s). */
export const CUE_HOLD: Record<CueKind, number> = { ringOut: 1.6, special: 2.5, throw: 3.5, launch: 3, pad: 3, event: 5, round: 5 };

/**
 * The rotation's weights: every shot's base weight, then × by the ring (design §6). The flier and the ring-out shots
 * come only from their moments; the crane only in an event.
 */
export const ROTATION: Partial<Record<ShotName, number>> = { wide: 3, duel: 2, low: 1.5, top: 1, hero: 1 };
export const PAIR_BOOST = { duel: 2.5, low: 2 }, CROWD_BOOST = { wide: 2, top: 2, duel: 0.5 };
export const EVENT_BOOST = { top: 2, wide: 1.5, crane: 2 };
/** Five or more fighting is a crowd. */
export const CROWD_AT = 5;

/**
 * What the picker knows of the ring: who is fighting, the closest engaged pair, a fighter worth a hero shot, an event,
 * and who is in the camera's frame right now (`inView`; none when it is not known).
 */
export type RingView = {
  ids: readonly string[]; pair: readonly [string, string] | null; star: string | null; event: boolean; inView?: ReadonlySet<string>;
};

/** A shot chosen: which, about whom, its rank (the rotation's is 0), how long it holds at most, its side and its roll. */
export type ShotPick = { shot: ShotName; a?: string; b?: string; rank: number; hold: number; side: 1 | -1; roll: number };

/** The shot each moment cuts to (a pad jump's may be low or hero). */
const SHOT_FOR: Record<CueKind, ShotName | null> = {
  ringOut: 'ringOut', special: 'hero', throw: 'duel', launch: 'flier', pad: null, event: 'crane', round: 'crane',
};
/** The moments with a cool-down (each its own): big launches and pad jumps come in runs. */
export const COOLED: ReadonlySet<CueKind> = new Set<CueKind>(['launch', 'pad']);
/**
 * How long (s) a moment that must not be missed waits for its turn (until the shot on screen may be cut): a special
 * or a grab or throw a moment, an event's start long enough for the shot on screen to have its hold.
 */
export const WAIT_FOR: Partial<Record<CueKind, number>> = { special: 1.5, throw: 1.5, event: 8 };
/** Are these the same moment (same kind, same fighters)? */
const sameMoment = (a: ShotCue, b: ShotCue) =>
  a.kind === b.kind && (!('id' in a) || !('id' in b) || a.id === b.id) && (a.kind !== 'throw' || b.kind !== 'throw' || a.other === b.other);
/** A special's hero shot follows its blow's launch to a flier shot once it has held this long (s). */
export const FOLLOW_AFTER = 1;

/** A special's blow (a `big` reaction) is a flight worth following only when it launches at least this fast (m/s). */
export const BIG_FLIGHT = 4.5;

/**
 * The camera's moments in one ring-loop step: ring-outs, releases, grabs and throws, big launches (a launch of
 * `bigSpeed` m/s or more, or a `big` reaction of BIG_FLIGHT or more) and pad jumps, and an event's start. Written into
 * `cues` (cleared first), so a frame loop can reuse one list.
 */
export function shotCues(r: { outs: readonly string[]; specials: readonly SpecialCue[]; stunts: readonly StuntCue[];
  features: readonly FeatureCue[]; hits: readonly Hit[] }, bigSpeed: number, cues: ShotCue[] = []): ShotCue[] {
  cues.length = 0;
  for (const id of r.outs) cues.push({ kind: 'ringOut', id });
  for (const c of r.specials) if (c.phase === 'release') cues.push({ kind: 'special', id: c.id });
  for (const c of r.stunts) {
    if (c.phase === 'start' && c.other && (c.stunt === 'grab' || c.stunt === 'throw')) cues.push({ kind: 'throw', id: c.id, other: c.other });
  }
  for (const h of r.hits) {
    if (h.launch >= bigSpeed || (h.reaction === 'big' && h.launch >= BIG_FLIGHT)) cues.push({ kind: 'launch', id: h.target.id, by: h.attacker.id });
  }
  for (const c of r.features) {
    if (c.type === 'pad') cues.push({ kind: 'pad', id: c.id });
    else if (c.type === 'event' && c.phase === 'start') cues.push({ kind: 'event' });
  }
  return cues;
}

export class ShotPicker {
  /** The shot now, and how long (s) it has held. */
  pick: ShotPick;
  held = 0;
  /** The last rotation shot (the rotation never picks it twice running). */
  private lastTurn: ShotName = 'wide';
  /** Where the dev key V is in SHOT_NAMES. */
  private devAt = 0;
  /** The picker's clock (s), and when each kind of moment last cut in. */
  private clock = 0;
  private readonly cuedAt = new Map<CueKind, number>();
  /** Moments that must not be missed, waiting for their turn (until `until` on the clock). */
  private readonly waiting: { cue: ShotCue; until: number }[] = [];
  /** The ring as this frame's `update` saw it (who is in the camera's frame). */
  private view: RingView | null = null;

  constructor(private readonly rng: () => number = Math.random) {
    this.pick = { shot: 'wide', rank: 0, hold: ROTATE_MIN, side: 1, roll: 0 };
  }

  /**
   * One frame (`dt` s) with the ring as it is and this frame's moments. Returns the new pick when it cut, else null.
   */
  update(dt: number, ring: RingView, cues: readonly ShotCue[]): ShotPick | null {
    this.held += Math.max(0, dt);
    this.clock += Math.max(0, dt);
    const p = this.pick;
    this.view = ring;
    this.wait(cues, ring);
    let best: ShotCue | null = null;
    for (const c of cues) if (this.cuts(c) && (!best || CUE_RANK[c.kind] > CUE_RANK[best.kind])) best = c;
    for (const w of this.waiting) if (this.cuts(w.cue) && (!best || CUE_RANK[w.cue.kind] > CUE_RANK[best.kind])) best = w.cue;
    // a special's hero shot follows its own blow, once it has been seen: the one it launches gets the flier shot
    if (p.shot === 'hero' && p.rank === CUE_RANK.special && this.held >= FOLLOW_AFTER) {
      for (const c of cues) {
        if (c.kind === 'launch' && c.by === p.a && (!best || CUE_RANK[best.kind] <= CUE_RANK.special)) return this.cue(c);
      }
    }
    if (best) return this.cue(best);
    if (this.held < Math.min(MAX_HOLD, p.hold)) return null;
    return this.after(ring); // the shot is over
  }

  /**
   * The moments that must not be missed (a special, a grab or throw, an event's start) wait their turn: each is kept
   * WAIT_FOR s (while its fighters are still fighting) until it may cut in. One already on screen is let go.
   */
  private wait(cues: readonly ShotCue[], ring: RingView): void {
    for (const c of cues) {
      const keep = WAIT_FOR[c.kind];
      if (keep === undefined) continue;
      const i = this.waiting.findIndex((w) => sameMoment(w.cue, c));
      if (i >= 0) this.waiting.splice(i, 1);
      this.waiting.push({ cue: c, until: this.clock + keep });
    }
    const p = this.pick;
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const c = this.waiting[i].cue;
      const gone = ('id' in c && !ring.ids.includes(c.id)) || (c.kind === 'throw' && !ring.ids.includes(c.other));
      const showing = (p.rank === CUE_RANK[c.kind] && p.shot === SHOT_FOR[c.kind] && (!('id' in c) || p.a === c.id)) || this.onScreen(c);
      if (this.clock > this.waiting[i].until || gone || (showing && this.held > 0)) this.waiting.splice(i, 1);
    }
  }

  /**
   * Would this moment cut in now? A ring-out always does (a new flier's cuts in on another's ring-out shot). Others
   * must outrank the shot on screen (or match it once that has held MIN_HOLD s), wait until the shot on screen has
   * held QUICK_HOLD s (a special, a grab or throw) or CALM_HOLD s (the rest), and a big launch's or a pad jump's shot
   * is not cut to again within CUE_COOLDOWN s of the last.
   */
  private cuts(c: ShotCue): boolean {
    const rank = CUE_RANK[c.kind], p = this.pick;
    if (c.kind === 'ringOut') return rank > p.rank || (p.shot === 'ringOut' && p.a !== c.id);
    if (this.onScreen(c)) return false;
    if (rank < p.rank || (rank === p.rank && this.held < MIN_HOLD)) return false;
    if (this.held < (URGENT.has(c.kind) ? QUICK_HOLD : CALM_HOLD)) return false;
    return !COOLED.has(c.kind) || this.clock - (this.cuedAt.get(c.kind) ?? -Infinity) >= CUE_COOLDOWN;
  }

  /**
   * Is this special already on screen? Its attacker is who the hero shot or the duel on screen is about, or it is in
   * the frame of whatever shot is on screen (a wide, duel, low, top, crane or flier shot shows it well enough): no cut
   * is needed to see it. (Owner, 2026-11-15: fewer close-ups — "no need to capture them all in a close up". Every
   * special cut to its hero shot, ~19 in a 90 s four-way bout, gave the hero shot 43% of the bout.)
   */
  private onScreen(c: ShotCue): boolean {
    if (c.kind !== 'special') return false;
    const p = this.pick;
    return ((p.shot === 'hero' || p.shot === 'duel') && (p.a === c.id || p.b === c.id)) || (this.view?.inView?.has(c.id) ?? false);
  }

  /** Cuts to a moment's shot (and remembers when, for the cool-down; a waiting one is done with). */
  private cue(c: ShotCue): ShotPick {
    const pick = this.forCue(c);
    this.cuedAt.set(c.kind, this.clock);
    const i = this.waiting.findIndex((w) => sameMoment(w.cue, c));
    if (i >= 0) this.waiting.splice(i, 1);
    return this.cut(pick);
  }

  /**
   * The shot can no longer be framed (its fighter is gone, its pair too far apart): on to `next`, or a moment waiting
   * its turn, or the rotation.
   */
  end(ring: RingView, next?: ShotCue): ShotPick {
    return next ? this.cue(next) : this.after(ring);
  }

  /** After a shot: a moment still waiting its turn comes next (the best of them), else the rotation. */
  private after(ring: RingView): ShotPick {
    let next: ShotCue | null = null;
    for (const w of this.waiting) if (!next || CUE_RANK[w.cue.kind] > CUE_RANK[next.kind]) next = w.cue;
    return next ? this.cue(next) : this.cut(this.rotation(ring));
  }

  /** Dev (key V): the next shot in SHOT_NAMES' order, on the ring's pair or star, held 5–8 s whatever happens. */
  next(ring: RingView): ShotPick {
    this.devAt = (SHOT_NAMES.indexOf(this.pick.shot) + 1) % SHOT_NAMES.length;
    const shot = SHOT_NAMES[this.devAt];
    return this.cut(this.shotOn(shot, ring, DEV_RANK, this.between(ROTATE_MIN, ROTATE_MAX)));
  }

  /** Straight to `shot` (dev shots), on the ring's pair or star, held MAX_HOLD s whatever happens. */
  force(shot: ShotName, ring: RingView): ShotPick {
    return this.cut(this.shotOn(shot, ring, DEV_RANK, MAX_HOLD));
  }

  private cut(p: ShotPick): ShotPick {
    this.pick = p;
    this.held = 0;
    return p;
  }

  private forCue(c: ShotCue): ShotPick {
    const rank = CUE_RANK[c.kind], hold = CUE_HOLD[c.kind], side = this.side(), roll = this.rng();
    switch (c.kind) {
      case 'ringOut': return { shot: 'ringOut', a: c.id, rank, hold, side, roll };
      case 'special': return { shot: 'hero', a: c.id, rank, hold, side, roll };
      case 'throw': return { shot: 'duel', a: c.id, b: c.other, rank, hold, side, roll };
      case 'launch': return { shot: 'flier', a: c.id, rank, hold, side, roll };
      case 'pad': return { shot: roll < 0.5 ? 'low' : 'hero', a: c.id, rank, hold, side, roll: this.rng() };
      default: return { shot: 'crane', rank, hold, side, roll };
    }
  }

  /**
   * The rotation's next shot: weighted by the ring, never the last rotation shot twice running (unless it is all there
   * is); the wide shot of an empty ring.
   */
  private rotation(ring: RingView): ShotPick {
    const w = new Map<ShotName, number>();
    const n = ring.ids.length;
    for (const [k, v] of Object.entries(ROTATION) as [ShotName, number][]) w.set(k, v);
    if (!ring.pair) w.delete('duel');
    if (n === 0) return this.shotOn('wide', ring, 0, this.between(ROTATE_MIN, ROTATE_MAX)); // an empty ring: its middle
    if (n === 2) for (const [k, v] of Object.entries(PAIR_BOOST)) w.set(k as ShotName, (w.get(k as ShotName) ?? 0) * v);
    if (n >= CROWD_AT) for (const [k, v] of Object.entries(CROWD_BOOST)) w.set(k as ShotName, (w.get(k as ShotName) ?? 0) * v);
    if (ring.event) for (const [k, v] of Object.entries(EVENT_BOOST)) w.set(k as ShotName, (w.get(k as ShotName) ?? 1) * v);
    for (const [k, v] of w) if (!(v > 0)) w.delete(k);
    if (w.size > 1) w.delete(this.lastTurn);
    let total = 0;
    for (const v of w.values()) total += v;
    let roll = this.rng() * total, shot: ShotName = 'wide';
    for (const [k, v] of w) {
      shot = k;
      if ((roll -= v) < 0) break;
    }
    this.lastTurn = shot;
    return this.shotOn(shot, ring, 0, this.between(ROTATE_MIN, ROTATE_MAX));
  }

  /** `shot` about the ring's pair (a duel), its star or someone at random (a hero, a flier, a ring-out), or everyone. */
  private shotOn(shot: ShotName, ring: RingView, rank: number, hold: number): ShotPick {
    const p: ShotPick = { shot, rank, hold: Math.min(MAX_HOLD, hold), side: this.side(), roll: this.rng() };
    if (shot === 'duel' && ring.pair) { p.a = ring.pair[0]; p.b = ring.pair[1]; }
    else if (shot === 'duel' && ring.ids.length >= 2) { p.a = ring.ids[0]; p.b = ring.ids[1]; }
    else if ((shot === 'hero' || shot === 'flier' || shot === 'ringOut') && ring.ids.length) {
      p.a = ring.star ?? ring.ids[Math.floor(this.rng() * ring.ids.length) % ring.ids.length];
    }
    return p;
  }

  private side(): 1 | -1 { return this.rng() < 0.5 ? -1 : 1; }
  private between(lo: number, hi: number): number { return lo + (hi - lo) * this.rng(); }
}
