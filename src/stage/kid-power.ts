import type { MoveStats } from './move';

/**
 * Kid power (owner, 2026-11-20: "make the player controller guys extra powerful and way harder for the cpu to knock
 * around, so it's fun for a 4 and 6 year old"). A creature a child is steering with a controller (and not resting) is
 * kid-powered: the app sets `StageFighter.kid` before every step, so it is fight state and a bout still replays exactly.
 * Nobody is kid-powered unless the app says so, so the computer's own bouts (the balance tool) are unchanged.
 * - Against the computer it hits harder: its attacks, specials, throws and pies on a computer-driven creature have
 *   `dealPower` × the power and `dealDamage` × the damage.
 * - The computer barely knocks it about: a hit from a computer-driven creature or from mischief (the toy train) has
 *   `takeKnock` × the launch and `takeDamage` × the damage, and a computer's pie stuns it `pieStun` × as long. It still
 *   gets bumped, so a hit feels like a hit.
 * - Its special meter fills `meter` × as fast, so its big move comes often; its recovery leap is `recovery` × as strong,
 *   so it gets back on easily.
 * - Two kids fight on the plain numbers both ways, so brothers and sisters stay fair.
 * - The computer's brains go for it less: a kid-powered creature looks `cpuFocus` × as tempting a target (it is still
 *   attacked, just less ganged up on).
 */
export const KID_POWER = {
  dealPower: 1.6,
  dealDamage: 1.6,
  takeKnock: 0.45,
  takeDamage: 0.4,
  pieStun: 0.5,
  meter: 2,
  recovery: 1.25,
  cpuFocus: 0.5,
} as const;

/** A blow's shares of its power (launch), damage and stun, for who gave it and who took it. */
export type BlowShare = { power: number; damage: number; stun: number };

const PLAIN: BlowShare = { power: 1, damage: 1, stun: 1 };
const DEAL: BlowShare = { power: KID_POWER.dealPower, damage: KID_POWER.dealDamage, stun: 1 };
const TAKE: BlowShare = { power: KID_POWER.takeKnock, damage: KID_POWER.takeDamage, stun: KID_POWER.pieStun };

/**
 * The shares of a blow from a kid-powered creature (`byKid`; false for the computer and for mischief) on a kid-powered
 * one (`onKid`): a kid on the computer deals more, the computer on a kid less, and kid on kid or computer on computer
 * the plain numbers. The objects returned are shared: read, never change.
 */
export function kidShare(byKid: boolean, onKid: boolean): Readonly<BlowShare> {
  return byKid === onKid ? PLAIN : byKid ? DEAL : TAKE;
}

/** Each body's movement with the kid's stronger recovery leap, made once (a new object: ruling R27). */
const kidded = new WeakMap<MoveStats, MoveStats>();

/**
 * `moves` with a recovery leap KID_POWER.recovery × as strong: a new object, made once per `moves` and kept (the same
 * object every call), never `moves` changed in place (ruling R27: the brains' route graphs are cached by identity).
 */
export function kidMoves(moves: MoveStats): MoveStats {
  let k = kidded.get(moves);
  if (!k) kidded.set(moves, (k = { ...moves, recovery: moves.recovery * KID_POWER.recovery }));
  return k;
}
