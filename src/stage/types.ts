/**
 * Small types shared across the 2D game core. Coordinates are metres, x right, y up; the fight steps at a fixed 60 Hz
 * so a bout replays exactly.
 */

/** The fixed fight step (s). */
export const DT = 1 / 60;

/** A 2D point or vector (m, or m/s for a velocity). */
export type V2 = { x: number; y: number };

/**
 * What a fighter wants this step, from a brain or a controller: the stick (−1…1 each way) and the buttons held.
 * The attack's direction comes from the stick (forward, up, down, in the air).
 */
export type Intent = {
  mx: number;
  my: number;
  jump: boolean;
  attack: boolean;
  special: boolean;
  grab: boolean;
  item: boolean;
  dodge: boolean;
};

/** Wanting nothing: stick centred, no buttons. */
export const NO_INTENT: Readonly<Intent> = Object.freeze({
  mx: 0,
  my: 0,
  jump: false,
  attack: false,
  special: false,
  grab: false,
  item: false,
  dodge: false,
});
