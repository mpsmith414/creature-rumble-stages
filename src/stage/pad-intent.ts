import { BUTTONS, type Button, type PadState } from '../shared/input';
import type { Intent } from './types';

/**
 * A controller as a fighter's wanting (stages design §10): the same Intent the brain gives, so a creature steered by a
 * pad has exactly the AI's moves and rules. Left stick or d-pad to move (and aim), A jump, X attack, Y special, B grab,
 * RB use the power-up, LB or RT dodge. Start and Select are the TV's (joining and leaving), never the fighter's.
 */

/** A stick nearer the middle than this (share of full tilt) wants nothing; past it the stick counts from 0 to full. */
export const PAD_DEAD_ZONE = 0.2;

/** Which buttons want each press. */
const PRESSES: readonly [Exclude<keyof Intent, 'mx' | 'my'>, readonly Button[]][] = [
  ['jump', ['a']],
  ['attack', ['x']],
  ['special', ['y']],
  ['grab', ['b']],
  ['item', ['rb']],
  ['dodge', ['lb', 'rt']],
];

/**
 * Every button held: as `prev` when a pad has just taken a fighter, so a button already down then (the A that picked it
 * in the picker) counts only once it is let go and pressed again.
 */
export const ALL_HELD: Readonly<PadState> = Object.freeze({
  lx: 0, ly: 0, rx: 0, ry: 0, ...(Object.fromEntries(BUTTONS.map((b) => [b, true])) as Record<Button, boolean>),
});

/** A stick axis with the dead zone taken out, rescaled so just past it is just over 0 and full tilt is 1. */
const tilt = (v: number): number => {
  const a = Math.abs(v);
  if (!(a > PAD_DEAD_ZONE)) return 0; // NaN too
  return Math.sign(v) * Math.min(1, (a - PAD_DEAD_ZONE) / (1 - PAD_DEAD_ZONE));
};
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/**
 * What a fighter steered by this pad wants this step. `pad` is the controller now, `prev` as it was when the last
 * intent was made, and `out` that last intent (reused: pass the same object every step). A button wants its move from
 * the step it is pressed (an edge from `prev` to `pad`) for as long as it stays down; a button that was down before
 * (`prev`) only carries on what it wanted then. The fighters make their own press edges from these held wants, so a
 * held A is one jump. The left stick (`lx`, `ly` raw as the browser gives them, down-positive; this one dead zone)
 * and the d-pad move: `mx` right, `my` up, never past full.
 */
export function padIntent(prev: Readonly<PadState>, pad: Readonly<PadState>, out?: Intent): Intent {
  const o = out ?? { mx: 0, my: 0, jump: false, attack: false, special: false, grab: false, item: false, dodge: false };
  o.mx = clamp1(tilt(pad.lx) + (pad.right ? 1 : 0) - (pad.left ? 1 : 0));
  o.my = clamp1(-tilt(pad.ly) + (pad.up ? 1 : 0) - (pad.down ? 1 : 0));
  for (const [want, buttons] of PRESSES) {
    let on = false;
    for (const b of buttons) if (pad[b] && (!prev[b] || o[want])) on = true;
    o[want] = on;
  }
  return o;
}
