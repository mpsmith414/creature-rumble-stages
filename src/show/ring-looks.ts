import type { Object3D, Scene } from 'three/webgpu';
import { POST_FIRST, type FeatureCue, type RingEventName } from '../arena/features';
import { ENTRY_ANGLE, postAngles } from '../arena/geometry';
import { RingProps, type PropsView } from '../arena/props';
import { ConfettiCannons } from './confetti-cannons';
import { CrowdStands } from './crowd-stands';
import { EventLooks } from './event-look';
import { RimLights } from './rim-lights';
import { Spotlights } from './spotlights';

/**
 * The wild ring's looks together (design 2026-11-14 §5.2): the pads, posts and beach ball drawn from `RingFeatures`, the
 * bumper's rim lights, the sweeping spotlights, each event's look, the crowd and the confetti cannons. The show hands it
 * its moments (hits, roars, ring-outs, the crowning, a new round); everything else it reads from the features each
 * frame. It touches nothing in the physics or the fight.
 */

/** What the looks read from the features each frame. */
export type LooksView = PropsView & { readonly event: { readonly name: RingEventName } | null };

/** What the show tells the looks (a test hands in a counting fake). */
export type Looks = {
  /** Once a frame, from the features' state (null: no wild ring, just the lights and the crowd). */
  update(dt: number, features: LooksView | null): void;
  /** A feature's cue: a post's ding flashes it; an event's start is a roar. */
  cue(c: FeatureCue): void;
  /** A hit at `at`: the rim lights on its side flash; a big one flashes the whole rim and is a roar too. */
  hit(big: boolean, at: { x: number; z: number }): void;
  /** A roar (a special's impact): the crowd jumps. */
  cheer(): void;
  /** A ring-out where the fighter flew out: the confetti cannons on the two nearest posts fire; a roar. */
  ringOut(at: { x: number; z: number }): void;
  /** The crowning: the rim lights turn gold; a roar. */
  crown(): void;
  /** A new round or the ring cleared: the normal look at once. */
  reset(): void;
};

export class RingLooks implements Looks {
  readonly rim: RimLights;
  readonly spots: Spotlights;
  readonly crowd: CrowdStands;
  readonly confetti: ConfettiCannons;
  readonly events: EventLooks;
  readonly props: RingProps | null;
  private readonly ringRadius: number;
  private readonly bumper: () => number;
  /** What `prepare(true)` showed, to hide again. */
  private hidden: Object3D[] = [];

  /**
   * `features`: the ring's features (their props are drawn; without them only the lights, the crowd and the confetti).
   * `bumper()` reads the bumper's height live; `setNight` is the arena's (Moon Jump's backdrop).
   */
  constructor(scene: Scene, o: {
    ringRadius: number; bumper: () => number; features?: LooksView | null; setNight?: (k: number) => void; entry?: number;
  }) {
    const entry = o.entry ?? ENTRY_ANGLE;
    this.ringRadius = o.ringRadius;
    this.bumper = o.bumper;
    this.rim = new RimLights(scene, o.ringRadius);
    this.spots = new Spotlights(scene, o.ringRadius);
    this.crowd = new CrowdStands(scene, { entry });
    // the cannons sit on the corner posts (as the arena stands them, R + 0.6 out)
    this.confetti = new ConfettiCannons(scene, postAngles(entry), o.ringRadius + 0.6);
    this.events = new EventLooks(scene, o.ringRadius, entry + POST_FIRST, o.setNight);
    this.props = o.features ? new RingProps(scene, o.features) : null;
  }

  update(dt: number, features: LooksView | null): void {
    const event = features?.event?.name ?? null;
    this.rim.update(dt, event !== null, this.bumper());
    this.spots.update(dt, event !== null);
    this.events.update(dt, event);
    this.crowd.update(dt);
    this.confetti.update(dt);
    if (features && this.props) this.props.update(dt, features, this.ringRadius);
  }

  cue(c: FeatureCue): void {
    if (c.type === 'bump') this.props?.ding(c.post);
    else if (c.type === 'event' && c.phase === 'start') this.cheer();
  }

  hit(big: boolean, at: { x: number; z: number }): void {
    this.rim.state.hit(big ? null : Math.atan2(at.z, at.x));
    if (big) this.cheer();
  }

  cheer(): void { this.crowd.cheer(); }

  ringOut(at: { x: number; z: number }): void {
    this.confetti.ringOut(at);
    this.cheer();
  }

  crown(): void {
    this.rim.state.crown();
    this.cheer();
  }

  reset(): void {
    this.rim.state.reset();
    this.events.reset();
    this.crowd.reset();
    this.confetti.clear();
    this.props?.reset();
  }

  /**
   * Everything that is hidden until its moment (event looks, confetti, the ball, the posts) shown (`true`) for a shader
   * compile, so its first showing does not stall a frame; `false` puts them back as they were.
   */
  prepare(on: boolean): void {
    if (on) {
      this.hidden = this.hideable().filter((o) => !o.visible);
      for (const o of this.hidden) o.visible = true;
    } else {
      for (const o of this.hidden) o.visible = false;
      this.hidden = [];
    }
  }

  private hideable(): Object3D[] {
    const out: Object3D[] = [this.events.pulse, this.events.arrows, this.confetti.mesh];
    if (this.props) out.push(...this.props.group.children); // the pads, the posts, the ball and its shadow
    return out;
  }
}
