/** After this long with no input (s) the AI takes fighter 1 back. */
export const HAND_BACK = 10;

/**
 * Who drives fighter 1 on the TV: the AI until someone touches the keyboard or a controller, then the player, until
 * HAND_BACK seconds pass with no input at all (a held stick or key counts as input), when the AI takes over again.
 * So the fight is never left with a creature standing still because nobody is holding the pad.
 */
export class PlayerSeat {
  /** Whether the player drives now (false: the AI does). */
  playing = false;
  /** Seconds since the last input while the player drives. */
  private quiet = 0;

  /** One frame: `touched` is whether any control was held or pressed this frame, `dt` the real seconds. Returns `playing`. */
  update(touched: boolean, dt: number): boolean {
    if (touched) {
      this.playing = true;
      this.quiet = 0;
    } else if (this.playing && Number.isFinite(dt) && dt > 0) {
      this.quiet += dt;
      if (this.quiet >= HAND_BACK) this.playing = false;
    }
    return this.playing;
  }
}
