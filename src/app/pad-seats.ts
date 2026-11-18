import { BUTTONS, EMPTY_PAD, stickMoved, type Button, type PadState } from '../shared/input';
import { ALL_HELD, padIntent } from '../stage/pad-intent';
import { NO_INTENT, type Intent } from '../stage/types';

/**
 * Controller play on the TV (stages design §10): who steers which creature. Anyone can pick up a controller and press
 * A or Start: its picker opens on the TV (`pick`); picking a creature (`claim`) gives the pad that creature, which it
 * steers with exactly the AI's moves and rules (only the wanting changes: `source` stands in for its brain). A creature
 * has one pad at most; several pads play at once, each in its own colour. Start + Select gives the creature back to the
 * AI; so does unplugging the pad, or the creature going out (back to the roster: the pad is free, and A or Start picks
 * again — the same one sent back in from the roster, or another). A pad just freed ignores A for FREE_A_WAIT seconds:
 * a child still pressing A to jump does not open a picker at once. A pad put down for REST_AFTER seconds rests: the AI
 * drives its creature until the pad is touched again. Pure: the TV feeds it each pad's state every frame.
 *
 * A free pad never reaches the TV menu with A or Start (a child mashing A must never crown the champion or call
 * Again!): its Select opens the menu, as the remote and Enter do (`routePress`).
 */

/** Each pad's colour, by its index (four controllers, then the dev keyboard): its picker and the arrow over its creature. */
export const PAD_COLOURS: readonly string[] = ['#ff4f7b', '#3ec7ff', '#ffc933', '#5fd35f', '#b57bff'];
/** A creature picked from the roster is held for its pad this long (s) while it is loaded and sent in; then let go. */
export const SEND_WAIT = 15;
/**
 * A pad nobody has touched for this long (s) rests: the AI drives its creature (so it never stands about as a sitting
 * duck) while the pad keeps it, and any touch takes it back at once.
 */
export const REST_AFTER = 20;
/** A pad just freed (its creature out, left, or its picker shut) ignores A for this long (s); Start picks at once. */
export const FREE_A_WAIT = 1;

/** Pad `pad`'s colour. */
export const padColour = (pad: number): string => PAD_COLOURS[((pad % PAD_COLOURS.length) + PAD_COLOURS.length) % PAD_COLOURS.length];

/**
 * What changed for a pad this frame: its picker opens or shuts, it lets its creature go (to the AI), or it rests (the AI
 * drives meanwhile) or wakes.
 */
export type SeatEvent =
  | { type: 'pick'; pad: number }
  | { type: 'cancel'; pad: number }
  | { type: 'rest' | 'wake'; pad: number; id: string }
  | { type: 'leave'; pad: number; id: string; why: 'left' | 'out' | 'unplugged' };

/** A pad in use: choosing in its picker, or steering creature `id`. */
type Seat = {
  pad: number;
  mode: 'picking' | 'playing';
  id: string | null;
  /** Seconds a creature sent in from the roster has been awaited (-1: it is in play, or was never awaited). */
  waited: number;
  /** Seconds since the pad was last touched, and whether it rests (the AI drives its creature). */
  quiet: number;
  resting: boolean;
  /** The pad as it is now, and as it was when the creature's last intent was made. */
  now: PadState;
  prev: PadState;
  /** The creature's wanting, reused every step. */
  intent: Intent;
  /** Its wanting each step, or null while the pad rests (the brain thinks then). */
  source: () => Intent | null;
};

/** A pad in use, as the TV shows it. */
export type SeatView = { pad: number; colour: string; mode: Seat['mode']; id: string | null; resting: boolean };

/** Whether a pad is being touched: a button down or a stick pushed past its rest (drift is no touch). */
const touched = (p: PadState): boolean => stickMoved(p) || BUTTONS.some((b) => p[b]);

export class PadSeats {
  private readonly byPad = new Map<number, Seat>();
  /** Every pad's state at the last update (free pads too: Start is a fresh press). */
  private last: readonly (PadState | null | undefined)[] = [];
  /** Seconds of updates so far, and when each pad was last freed (for FREE_A_WAIT). */
  private clock = 0;
  private readonly freedAt = new Map<number, number>();

  /** `known(id)`: is this creature in play (fighting, dropping in or waiting on deck)? */
  constructor(private readonly known: (id: string) => boolean) {}

  /**
   * One frame: each pad's state by index (null or missing: unplugged), the real seconds since the last, and whether
   * A or Start may open a picker now (not while the TV menu or the workshop has the screen). Returns what changed.
   */
  update(pads: readonly (PadState | null | undefined)[], dt: number, joinable: boolean): SeatEvent[] {
    this.clock += Number.isFinite(dt) && dt > 0 ? dt : 0;
    const out: SeatEvent[] = [];
    const done = new Set<number>();
    for (const seat of [...this.byPad.values()]) {
      const p = pads[seat.pad];
      done.add(seat.pad);
      if (!p) {
        // unplugged mid-fight: the AI takes over (a picker just shuts)
        this.free(seat.pad);
        out.push(seat.mode === 'playing' ? { type: 'leave', pad: seat.pad, id: seat.id!, why: 'unplugged' } : { type: 'cancel', pad: seat.pad });
        continue;
      }
      const was = seat.now;
      seat.now = p;
      const start = p.start && !was.start, select = p.select && !was.select;
      if (seat.mode === 'picking') {
        if (start) {
          this.free(seat.pad);
          out.push({ type: 'cancel', pad: seat.pad });
        }
        continue;
      }
      const id = seat.id!;
      let gone: 'left' | 'out' | null = null;
      if (p.start && p.select && (start || select)) gone = 'left';
      else if (seat.waited >= 0) {
        // sent in from the roster: held for its pad until it is in play, or for SEND_WAIT at most
        if (this.known(id)) seat.waited = -1;
        else if ((seat.waited += Number.isFinite(dt) && dt > 0 ? dt : 0) > SEND_WAIT) gone = 'out';
      } else if (!this.known(id)) gone = 'out';
      if (gone) {
        this.free(seat.pad);
        out.push({ type: 'leave', pad: seat.pad, id, why: gone });
        continue;
      }
      // a pad put down rests (the AI drives); any touch wakes it at once
      if (touched(p)) {
        seat.quiet = 0;
        if (seat.resting) {
          seat.resting = false;
          seat.prev = was; // the touch that woke it counts (a press now is a press)
          out.push({ type: 'wake', pad: seat.pad, id });
        }
      } else if (!seat.resting && (seat.quiet += Number.isFinite(dt) && dt > 0 ? dt : 0) >= REST_AFTER) {
        seat.resting = true;
        out.push({ type: 'rest', pad: seat.pad, id });
      }
    }
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || done.has(i)) continue;
      const was = this.last[i] ?? EMPTY_PAD;
      // Start, or A once the pad has been free a moment (never with Select held: half of leaving)
      const a = p.a && !was.a && this.clock - (this.freedAt.get(i) ?? -Infinity) >= FREE_A_WAIT;
      if (joinable && !p.select && ((p.start && !was.start) || a)) {
        this.byPad.set(i, this.seat(i, 'picking', null, p));
        out.push({ type: 'pick', pad: i });
      }
    }
    this.last = [...pads];
    return out;
  }

  /** Is pad `pad` choosing in its picker? */
  picking(pad: number): boolean {
    return this.byPad.get(pad)?.mode === 'picking';
  }

  /** Is pad `pad` resting (put down: the AI drives its creature until it is touched)? */
  resting(pad: number): boolean {
    return this.byPad.get(pad)?.resting ?? false;
  }

  /** Is pad `pad` in use (picking or steering)? Its presses are then its own, never the TV menu's. */
  owns(pad: number): boolean {
    return this.byPad.has(pad);
  }

  /** The creature pad `pad` steers, or null. */
  playing(pad: number): string | null {
    const s = this.byPad.get(pad);
    return s?.mode === 'playing' ? s.id : null;
  }

  /** The pad steering creature `id`, or undefined. */
  steering(id: string): number | undefined {
    for (const s of this.byPad.values()) if (s.mode === 'playing' && s.id === id) return s.pad;
    return undefined;
  }

  /**
   * Picking pad `pad` takes creature `id` (one in play, or with `sending` one just sent in from the roster, held for it
   * while it arrives). False when the pad is not picking or another pad has that creature. A button still down as it
   * picks (the A that chose) does nothing until it is let go and pressed again.
   */
  claim(pad: number, id: string, sending = false): boolean {
    const s = this.byPad.get(pad);
    if (s?.mode !== 'picking' || this.steering(id) !== undefined) return false;
    s.mode = 'playing';
    s.id = id;
    s.waited = sending ? 0 : -1;
    s.quiet = 0;
    s.resting = false;
    s.prev = ALL_HELD;
    Object.assign(s.intent, NO_INTENT);
    return true;
  }

  /** Shuts pad `pad`'s picker (B, or a pick that could not be had). */
  cancel(pad: number): void {
    if (this.picking(pad)) this.free(pad);
  }

  /** Frees pad `pad` (its creature to the AI; a failed send-in). Returns the creature it had, or null. */
  release(pad: number): string | null {
    const s = this.byPad.get(pad);
    if (s) this.free(pad);
    return s?.mode === 'playing' ? s.id : null;
  }

  /** What pad `pad`'s creature wants each fight step (asked once a step in place of its brain; null while it rests), or null. */
  source(pad: number): (() => Intent | null) | null {
    const s = this.byPad.get(pad);
    return s?.mode === 'playing' ? s.source : null;
  }

  /** The pads in use. */
  seats(): SeatView[] {
    return [...this.byPad.values()].map((s) => ({ pad: s.pad, colour: padColour(s.pad), mode: s.mode, id: s.id, resting: s.resting }));
  }

  /** Pad `pad` is free again (from now, A waits FREE_A_WAIT before it picks). */
  private free(pad: number): void {
    this.byPad.delete(pad);
    this.freedAt.set(pad, this.clock);
  }

  private seat(pad: number, mode: Seat['mode'], id: string | null, now: PadState): Seat {
    const s: Seat = {
      pad, mode, id, waited: -1, quiet: 0, resting: false, now, prev: ALL_HELD, intent: { ...NO_INTENT },
      source: () => {
        if (s.resting) return null;
        padIntent(s.prev, s.now, s.intent);
        s.prev = s.now;
        return s.intent;
      },
    };
    return s;
  }
}

/** The TV menu as `routePress` drives it (`menuControl`'s). */
export type PressMenu = { readonly open: unknown; press(b: Button, repeat?: boolean): boolean; show(): void; close(): void };
export type PressDeps = {
  seats: Pick<PadSeats, 'picking' | 'owns'>;
  /** A press for pad `pad`'s open picker. */
  picker(pad: number, b: Button, repeat: boolean): void;
  menu: PressMenu;
};

/**
 * Where a button press on the TV goes (`pad`: the controller's index; undefined: the keyboard or the remote). A pad
 * choosing in its picker drives it; a pad playing keeps every button for its creature. A free pad: with the TV menu
 * shut, its A and Start are PadSeats' (they open its picker) and its Select opens the menu — nothing else of it does
 * anything, so a child pressing A to jump never opens the menu, let alone crowns; with the menu up it drives the menu
 * (Start or Select shuts it). The keyboard and the remote: Enter (A), the Menu key or N (Start) open the menu, and drive it.
 */
export function routePress(b: Button, repeat: boolean, pad: number | undefined, d: PressDeps): void {
  if (pad !== undefined) {
    if (d.seats.picking(pad)) return d.picker(pad, b, repeat);
    if (d.seats.owns(pad)) return; // playing: its buttons are its creature's
    if (!d.menu.open) {
      if (b === 'select' && !repeat) d.menu.show();
      return;
    }
    if (b === 'select') {
      if (!repeat) d.menu.close();
      return;
    }
  }
  if (d.menu.press(b, repeat)) return;
  if (b === 'a' && !repeat) d.menu.show();
}
