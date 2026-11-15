import { CircleGeometry, Color, InstancedMesh, Mesh, MeshBasicNodeMaterial, Shape, ShapeGeometry, type Scene } from 'three/webgpu';
import { float, floor, sin, smoothstep, uniform, uv } from 'three/tsl';
import type { RingEventName } from '../arena/features';

/**
 * How the ring looks in each ring event (wild ring design §5.2): Bounce Party pulses the floor's rings; Moon Jump dims
 * the backdrop to night with stars (and the fighters' trails stay on: the show reads `trailsOn`); Pinball shows pinball
 * arrows on the floor; Beach Ball adds nothing. `EventLook` is the pure state: each look's level (0 … 1) eases toward
 * whether its event runs, and `reset` snaps them all off. `EventLooks` draws the levels.
 */

export type LookLevels = { pulse: number; night: number; arrows: number };
/** A look fades in or out over this long (s). */
export const LOOK_FADE_S = 0.6;

/** What each event turns on (1) and off (0). */
export function lookFor(name: RingEventName | null): LookLevels {
  return { pulse: name === 'bounceParty' ? 1 : 0, night: name === 'moonJump' ? 1 : 0, arrows: name === 'pinball' ? 1 : 0 };
}

/** Whether the fighters' trails stay on (Moon Jump). */
export const trailsOn = (name: RingEventName | null | undefined) => name === 'moonJump';

export class EventLook {
  readonly level: LookLevels = { pulse: 0, night: 0, arrows: 0 };

  /** Once a frame: each look eases toward what the event under way (or none) wants. */
  update(dt: number, name: RingEventName | null): LookLevels {
    const want = lookFor(name), step = Math.max(0, dt) / LOOK_FADE_S;
    for (const k of ['pulse', 'night', 'arrows'] as const) {
      const v = this.level[k];
      this.level[k] = want[k] > v ? Math.min(want[k], v + step) : Math.max(want[k], v - step);
    }
    return this.level;
  }

  /** The normal look at once (a new round, the ring cleared). */
  reset(): void {
    this.level.pulse = this.level.night = this.level.arrows = 0;
  }
}

/**
 * Bounce Party's floor pulse: the striped top's 12 rings glow hot pink in turn, outward, this fast (rad/s), at most this
 * strongly (opacity). (Painted, not added light: added light only washed the pale top out to white.)
 */
const PULSE_RINGS = 12, PULSE_SPEED = 9, PULSE_STEP = 0.85, PULSE_STRENGTH = 0.55, PULSE_COLOUR = 0xff3fa0;
/** Pinball's arrows: lanes of chevrons running out from the middle, lit in turn (s per chevron). */
const ARROW_OPACITY = 0.85;
const LANES = 3, CHEVRONS = 4, CHEVRON_FROM = 1.0, CHEVRON_EVERY = 0.95, CHEVRON_STEP_S = 0.12;
/** A lit chevron's colour and an unlit one's (painted on the floor: added light washed out to white on the pale top). */
const ARROW_LIT = 0xff2f7d, ARROW_DIM = 0xb26bff;
/** Overlays lie this far over the ring's top (m), under the pads. */
const OVERLAY_LIFT = 0.006;

/** A flat chevron (an arrow head) pointing along +x, ~0.7 m long, lying on the floor. */
function chevron(): ShapeGeometry {
  const s = new Shape();
  s.moveTo(0.35, 0);
  s.lineTo(-0.1, 0.42);
  s.lineTo(-0.35, 0.42);
  s.lineTo(0.08, 0);
  s.lineTo(-0.35, -0.42);
  s.lineTo(-0.1, -0.42);
  s.closePath();
  const g = new ShapeGeometry(s);
  g.rotateX(-Math.PI / 2); // flat: its shape's y is now −z
  return g;
}

const _c = new Color();

/**
 * The event looks drawn: the floor pulse (one see-through disc), the arrows (one instanced mesh of chevrons) and the night
 * (the arena's backdrop and its stars, through `setNight`). Each is hidden while its level is 0.
 */
export class EventLooks {
  readonly look = new EventLook();
  readonly pulse: Mesh;
  readonly arrows: InstancedMesh;
  private readonly time = uniform(0);
  private readonly pulseLevel = uniform(0);
  private readonly arrowLevel = uniform(0);
  private t = 0;

  /** `postsFrom`: the first pinball post's angle (the arrows' lanes run between the posts). */
  constructor(scene: Scene, ringRadius: number, postsFrom: number, private readonly setNight: (k: number) => void = () => {}) {
    // the floor pulse: which of the top's rings a point is on, lit by a wave running outward
    const pulseMat = new MeshBasicNodeMaterial({ color: PULSE_COLOUR, transparent: true, depthWrite: false });
    const ring = floor(uv().sub(0.5).length().mul(2 * PULSE_RINGS));
    const wave = sin(this.time.mul(PULSE_SPEED).sub(ring.mul(PULSE_STEP))).mul(0.5).add(0.5);
    pulseMat.opacityNode = float(PULSE_STRENGTH).mul(smoothstep(0.45, 1, wave)).mul(this.pulseLevel);
    pulseMat.toneMapped = false;
    this.pulse = new Mesh(new CircleGeometry(ringRadius - 0.02, 72), pulseMat);
    this.pulse.name = 'floor-pulse';
    this.pulse.rotation.x = -Math.PI / 2;
    this.pulse.position.y = OVERLAY_LIFT;
    this.pulse.renderOrder = 1;

    const arrowMat = new MeshBasicNodeMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
    arrowMat.opacityNode = this.arrowLevel;
    arrowMat.toneMapped = false;
    this.arrows = new InstancedMesh(chevron(), arrowMat, LANES * CHEVRONS);
    this.arrows.name = 'pinball-arrows';
    this.arrows.frustumCulled = false;
    this.arrows.renderOrder = 1;
    const m = this.arrows.instanceMatrix.array;
    for (let l = 0; l < LANES; l++) {
      const a = postsFrom + Math.PI / LANES + (l * Math.PI * 2) / LANES; // half way between two posts
      for (let k = 0; k < CHEVRONS; k++) {
        const i = l * CHEVRONS + k, o = i * 16, r = CHEVRON_FROM + k * CHEVRON_EVERY;
        // turned so its +x points out along the lane (a turn of −a about y takes +x to angle a)
        const c = Math.cos(a), s = Math.sin(a);
        m.fill(0, o, o + 16);
        m[o] = c; m[o + 2] = s; m[o + 5] = 1; m[o + 8] = -s; m[o + 10] = c; m[o + 15] = 1;
        m[o + 12] = Math.cos(a) * r; m[o + 13] = OVERLAY_LIFT * 2; m[o + 14] = Math.sin(a) * r;
        this.arrows.setColorAt(i, _c.setRGB(0, 0, 0));
      }
    }

    this.apply(this.look.level);
    scene.add(this.pulse, this.arrows);
  }

  /** Once a frame: each look eases toward the event under way (or none) and is drawn. */
  update(dt: number, name: RingEventName | null): void {
    this.t += Math.max(0, dt);
    this.apply(this.look.update(dt, name));
  }

  /** The normal look at once. */
  reset(): void {
    this.look.reset();
    this.apply(this.look.level);
  }

  private apply(l: LookLevels): void {
    this.time.value = this.t;
    this.pulseLevel.value = l.pulse;
    this.pulse.visible = l.pulse > 0;
    this.arrows.visible = l.arrows > 0;
    this.arrowLevel.value = l.arrows * ARROW_OPACITY;
    if (this.arrows.visible) {
      // the chevrons in each lane light one after another, outward, over and over
      const lit = Math.floor(this.t / CHEVRON_STEP_S) % (CHEVRONS + 1);
      for (let i = 0; i < LANES * CHEVRONS; i++) {
        this.arrows.setColorAt(i, _c.setHex(i % CHEVRONS <= lit ? ARROW_LIT : ARROW_DIM));
      }
      if (this.arrows.instanceColor) this.arrows.instanceColor.needsUpdate = true;
    }
    this.setNight(l.night);
  }
}
