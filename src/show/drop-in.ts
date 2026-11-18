import { AdditiveBlending, Group, Mesh, MeshBasicNodeMaterial, type BufferGeometry, type Material, type Object3D } from 'three/webgpu';
import { at, geometryOf, litMaterial } from '../levels/scenery/kit';
import { platformsAt, type Level, type Platform } from '../stage/level';
import type { V2 } from '../stage/types';

/**
 * Entrances on the stage (spec §9.2, §12): the fight freezes, the camera swoops to where the newcomer will land, it
 * drops in from above the view under a parachute (on the space ship: down a beam of light), lands with a squash, does
 * its show-off and is announced; then play resumes. About 5 s. Arrivals close together share one: each drops on its
 * own clock, a little after the one before. After Again! the whole cast drops in together, the champion last.
 *
 * The timeline and the choice of spots are pure (the fight never hears about them); `DropInLooks` draws the parachutes
 * and beams. A newcomer is in the fight (frozen) on its landing spot from the start: only its picture is lifted.
 */

/** A lone drop-in lasts this long (s), and a shared one (or the group after Again!). */
export const DROP_IN_S = 5, GROUP_DROP_IN_S = 5;

/** Where one creature's drop-in is. */
export type DropPhase = 'wait' | 'fall' | 'land' | 'showoff' | 'done';

export type DropAt = {
  phase: DropPhase;
  /** How far over its landing spot it is drawn (m). */
  lift: number;
  /** The landing squash: 1 at touch-down, easing to 0. */
  squash: number;
  /** Seconds into its show-off (0 before it). */
  show: number;
  /** How open its parachute (or how bright its beam) is: 0 … 1. */
  chute: number;
};

/** When each step of one creature's drop-in begins, from its own start (s), and when it is done. */
type Steps = { fall: number; land: number; show: number; showEnd: number; done: number };
/** A lone drop-in: the camera swoops in (0.6 s), it floats down (1.6 s), lands (0.4 s), shows off (2 s), settles. */
export const SOLO_STEPS: Readonly<Steps> = { fall: 0.6, land: 2.2, show: 2.6, showEnd: 4.6, done: DROP_IN_S };
/** In a group each one floats down for this long (s) and lands for this long (s); everyone shows off until GROUP_SHOW_END. */
const GROUP_FALL = 1.3, GROUP_LAND = 0.4;
/** The first of a group starts falling this soon (s); the others follow, the last of them (not the champion) by GROUP_LAST. */
const GROUP_FIRST = 0.3, GROUP_LAST = 1.5, GROUP_GAP = 0.3;
/** After Again! the champion starts falling this long after the last of the others (s): it lands last, on its own. */
const CHAMPION_GAP = 0.5;
/** Everyone in a group shows off until this long into it (s), and each for at least this long (s). */
const GROUP_SHOW_END = 4.6, GROUP_SHOW_MIN = 0.6;
/** The parachute opens over this long (s) as the fall starts, and folds away over this long once landed. */
const CHUTE_OPEN = 0.25, CHUTE_FOLD = 0.3;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * One creature's drop-in steps: a lone one, or the `i`th of a group's `others` (spread out, each a little after the one
 * before), or the group's `champion`, falling last after a gap (it lands on its own, the last one seen).
 */
export function dropSteps(group: boolean, i = 0, others = 1, champion = false): Steps {
  if (!group) return SOLO_STEPS;
  const gap = others > 1 ? Math.min(GROUP_GAP, (GROUP_LAST - GROUP_FIRST) / (others - 1)) : 0;
  const last = GROUP_FIRST + gap * Math.max(0, others - 1);
  const fall = champion ? (others > 0 ? last + CHAMPION_GAP : GROUP_FIRST) : GROUP_FIRST + gap * i;
  const land = fall + GROUP_FALL, show = land + GROUP_LAND;
  return { fall, land, show, showEnd: Math.max(show + GROUP_SHOW_MIN, GROUP_SHOW_END), done: Math.max(show + GROUP_SHOW_MIN, GROUP_DROP_IN_S) };
}

/**
 * Where a drop-in is `t` s into its own clock, starting `from` m over its landing spot: waiting (above the view), falling
 * (fast at first, gently at the end under its parachute), landing (a squash), showing off, done. Into `out` when given.
 */
export function dropAt(t: number, steps: Readonly<Steps>, from: number, out: DropAt = blankDrop()): DropAt {
  out.lift = 0;
  out.squash = 0;
  out.show = 0;
  out.chute = 0;
  if (!(t >= steps.fall)) { // (a broken t waits)
    out.phase = 'wait';
    out.lift = from;
  } else if (t < steps.land) {
    out.phase = 'fall';
    const k = (t - steps.fall) / (steps.land - steps.fall);
    out.lift = from * (1 - k) * (1 - k); // eases out: it touches down gently
    out.chute = clamp01((t - steps.fall) / CHUTE_OPEN);
  } else if (t < steps.show) {
    out.phase = 'land';
    out.squash = 1 - (t - steps.land) / (steps.show - steps.land);
    out.chute = clamp01(1 - (t - steps.land) / CHUTE_FOLD);
  } else if (t < steps.done) {
    out.phase = t < steps.showEnd ? 'showoff' : 'done';
    out.show = Math.min(t, steps.showEnd) - steps.show;
  } else out.phase = 'done';
  return out;
}

export const blankDrop = (): DropAt => ({ phase: 'done', lift: 0, squash: 0, show: 0, chute: 0 });

/** One creature dropping in: its landing spot, its steps, how high it starts, when it started (show clock, s). */
type Drop = { id: string; at: V2; from: number; start: number; steps: Steps; landed: boolean };

/**
 * The drop-ins under way. `start` adds creatures (a lone drop-in, a group, or newcomers joining one under way), each on
 * its own clock; `update` moves them on and says who just touched down; a creature is done once its steps are, and the
 * drop-in is `active` while anyone is still dropping in. Pure: the caller freezes the fight while it is active and draws
 * each creature where `state` says.
 */
export class DropIn {
  private readonly drops = new Map<string, Drop>();
  private now = 0;
  /** Whether the drop-in under way is a group's (no close-up then: the camera shows the whole level). */
  group = false;

  /**
   * Starts drop-ins at show time `now` for `who` (each landing on `at`, starting `from` m over it). A lone one has the
   * camera's close-up; several, or newcomers joining one under way, drop as a group, `champion` (if among them) last.
   */
  start(who: readonly { id: string; at: V2; from: number }[], now: number, o: { group?: boolean; champion?: string | null } = {}): void {
    const joining = this.active && who.some((w) => !this.drops.has(w.id));
    const group = o.group ?? (who.length > 1 || joining);
    this.group ||= group;
    const fresh = who.filter((w) => !this.drops.has(w.id));
    const champ = fresh.find((w) => w.id === o.champion);
    const others = fresh.filter((w) => w !== champ);
    others.forEach((w, i) => this.add(w, now, dropSteps(group, i, others.length)));
    if (champ) this.add(champ, now, dropSteps(group, 0, others.length, true));
    this.now = now;
  }

  /** Moves on to show time `now`. Returns the ids that touched down since the last update (each once). */
  update(now: number, landed: string[] = []): string[] {
    this.now = now;
    for (const d of this.drops.values()) {
      const t = now - d.start;
      if (!d.landed && t >= d.steps.land) {
        d.landed = true;
        landed.push(d.id);
      }
      if (t >= d.steps.done) this.drops.delete(d.id);
    }
    if (!this.drops.size) this.group = false;
    return landed;
  }

  /** Is anyone still dropping in? */
  get active(): boolean {
    return this.drops.size > 0;
  }

  /** Is this creature dropping in? */
  has(id: string): boolean {
    return this.drops.has(id);
  }

  /** The ids dropping in. */
  ids(): string[] {
    return [...this.drops.keys()];
  }

  /** Where `id`'s drop-in is now (null when it is not dropping in). */
  state(id: string, out?: DropAt): DropAt | null {
    const d = this.drops.get(id);
    return d ? dropAt(this.now - d.start, d.steps, d.from, out) : null;
  }

  /** The landing spot of a lone drop-in under way, for the camera's close-up (null for a group, or none). */
  focus(): V2 | null {
    if (this.group || this.drops.size !== 1) return null;
    for (const d of this.drops.values()) return d.at;
    return null;
  }

  /** Ends the drop-ins of `ids` (all when not given) at once: they stand where they landed. */
  cancel(ids?: readonly string[]): void {
    if (!ids) this.drops.clear();
    else for (const id of ids) this.drops.delete(id);
    if (!this.drops.size) this.group = false;
  }

  private add(w: { id: string; at: V2; from: number }, now: number, steps: Steps): void {
    this.drops.set(w.id, { id: w.id, at: { x: w.at.x, y: w.at.y }, from: Math.max(0, w.from), start: now, steps, landed: false });
  }
}

// ---------- where they land ----------

/** A spot's platform must hold the whole box with this much to spare each side (m). */
const SPOT_EDGE = 0.2;

/** Whether a platform is one to land on or crown on: it stays put (no path) and does not spring (not the bed). */
const steady = (p: Platform) => !p.path && !p.bounce;

/**
 * Where a creature `w` wide dropping in above `x` lands: on the highest platform its box would meet coming down (so it
 * never passes through one), moved along it if need be so the whole box stands on it, with the platforms as they are at
 * level time `t`. Null when that platform moves or springs (a lift, the bed: no spot for a landing), or nothing is under it.
 */
export function landingAt(level: Level, t: number, x: number, w: number): V2 | null {
  const plats = platformsAt(level, t);
  for (let tries = 0; tries < SPOT_TRIES; tries++) {
    let best: Platform | null = null;
    for (const p of plats) {
      if (Math.abs(x - p.x) >= p.w / 2 + w / 2 || p.y > level.camera.top) continue;
      if (!best || p.y > best.y) best = p;
    }
    if (!best || !steady(best)) return null;
    const room = best.w / 2 - w / 2 - SPOT_EDGE;
    if (room < 0) return null;
    const onX = Math.min(best.x + room, Math.max(best.x - room, x));
    if (onX === x) return { x, y: best.y };
    x = onX; // moved onto it: look again from there (something higher may be over its new spot)
  }
  return null;
}
/** A spot moved onto its platform is looked at again at most this many times. */
const SPOT_TRIES = 3;

/**
 * Where a newcomer `w` wide drops in: above the level entry furthest (sideways) from everyone in play and every spot
 * already taken, landing on the highest steady platform under it (`landingAt`). The first entry when nothing is there.
 */
export function dropSpot(level: Level, t: number, taken: readonly V2[], w: number): V2 {
  let best: V2 | null = null, bestD = -1;
  for (const e of level.entries) {
    const spot = landingAt(level, t, e.x, w);
    if (!spot) continue;
    let d = Infinity;
    for (const o of taken) d = Math.min(d, Math.abs(o.x - e.x) + (Math.abs(o.y - spot.y) > 1 ? 1 : 0));
    if (d > bestD) {
      bestD = d;
      best = spot;
    }
  }
  return best ?? { x: level.entries[0]?.x ?? 0, y: level.entries[0]?.y ?? 0 };
}

/**
 * The champion's spot (spec §9.2: the crowning happens on the top platform): the middle of the highest steady platform
 * within the camera's bounds (nearest the middle of the level on a tie).
 */
export function topSpot(level: Level): V2 {
  let best: Platform | null = null;
  for (const p of level.platforms) {
    if (!steady(p) || p.y > level.camera.top) continue;
    if (!best || p.y > best.y + 1e-6 || (Math.abs(p.y - best.y) <= 1e-6 && Math.abs(p.x) < Math.abs(best.x))) best = p;
  }
  return best ? { x: best.x, y: best.y } : { x: 0, y: 0 };
}

/** How far over its landing spot a newcomer starts (m): above the top of the view (`viewTop`), with room for its height `h`. */
export function dropHeight(landingY: number, viewTop: number, h: number): number {
  return Math.max(h, viewTop - landingY + h + DROP_ABOVE);
}
/** A newcomer starts this far above the top of the view (m), so it drops into sight. */
const DROP_ABOVE = 0.5;

// ---------- the looks ----------

/**
 * The parachute: its canopy radius (m) for a creature this tall (m); its strings end at this share of the creature's
 * height (its shoulders), the canopy a radius above them.
 */
const CHUTE_FOR = 1.4, CANOPY_R = 1, STRINGS_AT = 0.8;
/** The beam: its radius (× the box width) and how far above the view it reaches (m). */
const BEAM_R = 0.9, BEAM_OVER = 2;
/** The beam's colour and brightness. */
const BEAM_COLOUR = '#9fe8ff', BEAM_OPACITY = 0.35;
/** Parachutes and beams sit this far behind the play plane (m), so they never cover a creature. */
const LOOK_Z = -0.5;
/** Drawn at once (the most creatures on the stage). */
const MOST = 8;

/**
 * One creature's drop-in look this frame: where it is drawn (bottom centre), its box, how open its chute is, and the
 * spot it lands on (`floor`: a beam shines down to it).
 */
export type DropLook = { x: number; y: number; w: number; h: number; chute: number; floor: number };

/**
 * How a drop-in looks: a striped parachute over each falling creature (it opens as the fall starts and folds away once
 * landed), or on the space ship a beam of light it slides down. Display only; pooled (eight of each), nothing made per frame.
 */
export class DropInLooks {
  readonly root = new Group();
  private readonly chutes: Mesh[] = [];
  private readonly beams: Mesh[] = [];
  private readonly beamMat: MeshBasicNodeMaterial;
  private readonly materials: Material[] = [];
  private readonly geos: BufferGeometry[] = [];

  constructor(parent: Object3D) {
    this.root.name = 'drop-in-looks';
    const lit = litMaterial();
    this.beamMat = new MeshBasicNodeMaterial({ color: BEAM_COLOUR, transparent: true, opacity: BEAM_OPACITY, blending: AdditiveBlending, depthWrite: false });
    this.materials.push(lit, this.beamMat);
    const chute = geometryOf('lit', (b, s) => {
      // a dome of puffs in two colours, strings down to the creature's shoulders (the canopy's own frame: radius 1, its strings' ends at y 0)
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        b.add(s.ball, at(Math.cos(a) * 0.62, 1, Math.sin(a) * 0.4, 0.42, 0.24, 0.3), k % 2 ? '#ffffff' : '#ffb23f');
      }
      b.add(s.ball, at(0, 1.08, 0, 0.8, 0.32, 0.55), '#ffb23f');
      for (const sx of [-1, 1]) b.add(s.cyl, at(sx * 0.45, 0.5, 0, 0.02, 1.05, 0.02, 0, 0, sx * 0.55), '#5b4a6b');
    });
    const beam = geometryOf('flat', (b, s) => b.add(s.cyl, at(0, 0.5, 0, 1, 1, 1), '#ffffff'));
    this.geos.push(chute, beam);
    for (let i = 0; i < MOST; i++) {
      this.chutes.push(this.mesh(chute, lit, `drop-chute-${i}`));
      this.beams.push(this.mesh(beam, this.beamMat, `drop-beam-${i}`));
    }
    parent.add(this.root);
  }

  /**
   * Draws this frame's drop-ins (`looks`, up to eight): a parachute over each, or a beam (`beam`: the space ship) from
   * above the view (`viewTop`) down to its landing spot. The rest are hidden. `time` (s) sways the parachutes.
   */
  update(looks: readonly DropLook[], beam: boolean, viewTop: number, time: number): void {
    for (let i = 0; i < MOST; i++) {
      const l = looks[i], c = this.chutes[i], b = this.beams[i];
      c.visible = !!l && !beam && l.chute > 0.01;
      b.visible = !!l && beam && l.chute > 0.01;
      if (!l) continue;
      if (c.visible) {
        const r = Math.max(l.w, l.h / CHUTE_FOR) * CANOPY_R * l.chute;
        c.position.set(l.x, l.y + l.h * STRINGS_AT, LOOK_Z);
        c.scale.set(r, Math.max(0.05, r * l.chute), r);
        c.rotation.z = Math.sin(time * 2.1 + i) * 0.1;
      }
      if (b.visible) {
        const top = Math.max(viewTop + BEAM_OVER, l.y + l.h + BEAM_OVER), r = l.w * BEAM_R, foot = Math.min(l.floor, l.y);
        b.position.set(l.x, foot, LOOK_Z);
        b.scale.set(r, top - foot, r);
      }
    }
    this.beamMat.opacity = BEAM_OPACITY;
  }

  /** Hides everything. */
  clear(): void {
    for (const m of [...this.chutes, ...this.beams]) m.visible = false;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.materials) m.dispose();
    this.root.removeFromParent();
  }

  private mesh(g: BufferGeometry, m: Material, name: string): Mesh {
    const mesh = new Mesh(g, m);
    mesh.name = name;
    mesh.visible = false;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    this.root.add(mesh);
    return mesh;
  }
}
