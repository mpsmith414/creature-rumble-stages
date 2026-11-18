import { Color, Matrix4, Quaternion, Vector3, type PerspectiveCamera, type Scene } from 'three/webgpu';
import { animState, bodyInfo, PoseMemory, poseSegments, restPieces, type AnimState } from '../anim/pose';
import type { BodyData } from '../builder/build';
import { buildScenery, type LevelScenery } from '../levels/scenery';
import type { Recipe } from '../recipe/schema';
import { compileTogether, type Compiler } from '../render/compile';
import { driveBonesFrom } from '../render/drive';
import { createFighterObject, type FighterObject } from '../render/fighter-object';
import { DamageLook } from '../show/damage-look';
import { DropInLooks, type DropLook } from '../show/drop-in';
import { EdgeBubbles, type BubbleFighter } from '../show/edge-bubbles';
import { Finale, type CrownSpot } from '../show/finale';
import { ItemLooks, type ItemFighter } from '../show/item-looks';
import { exitSide, KoFx, koKind } from '../show/ko-fx';
import { PadArrows } from '../show/pad-arrows';
import { StageCamera, type View } from '../show/stage-camera';
import { trailColour, Trails } from '../show/trails';
import type { BodyStats } from '../stage/body';
import type { StageFighter } from '../stage/fighter';
import { PRESENT_SIZE, TIMED_ITEMS, type ItemCue } from '../stage/items';
import { platformsAt, topBelow, type Level, type Platform } from '../stage/level';
import type { MischiefCue } from '../stage/mischief';
import type { StageSim } from '../stage/sim';
import { DT, type V2 } from '../stage/types';
import type { StageLoop } from './stage-loop';

/**
 * The TV picture of a fight on the stage, shared by the Rumble and the dev page (`/?dev=stage`): the level's scenery
 * and the side camera (with its close-ups), each creature's body posed by the anim clips and drawn between two fight
 * steps, its damage look, the trail behind a launch, power-ups and presents, the edge bubbles of creatures beyond the
 * view, knockout effects, the drop-ins' parachutes and beams, and the crown and confetti. It draws; it never changes
 * the fight. The show around it (who comes and goes, what is said) is the caller's.
 */

/** What a creature looks like on the stage: its recipe and built body, its stage stats (posing uses their layout), its name. */
export type StageLook = { recipe: Recipe; body: BodyData; stats: BodyStats; name: string };

/**
 * What the caller changes about how a creature is drawn this frame (a drop-in lifts it and plays its landing and
 * show-off; the champion is carried up to the top). It may change `a` (where and how it is posed). Returns how open
 * its parachute is (0 … 1: a drop-in), `false` to hide it this frame (waiting above the view), or nothing.
 */
export type Adjust = (f: StageFighter, a: AnimState) => number | false | void;

/** What the frame needs besides the fight: this frame's mischief and power-up cues, and the caller's changes. */
export type DrawOptions = {
  mischief: readonly MischiefCue[];
  items: readonly ItemCue[];
  adjust?: Adjust;
  /** Draw the drop-ins' beams (the space ship) instead of parachutes. */
  beam?: boolean;
};

/** One creature as drawn: its body, its pose memory and what the bubbles, looks and camera need. */
type Shown = {
  id: string;
  /** The body it was made from (a creature coming back with the same body keeps its picture). */
  body: BodyData;
  stats: BodyStats;
  obj: FighterObject;
  pieces: Matrix4[];
  mem: PoseMemory;
  a: AnimState;
  bubble: BubbleFighter;
  look: ItemFighter;
  colour: Color;
  /** Steps it has been showing off alone (display). */
  showT: number;
  /** Whether it was drawn this frame (hidden while it waits above the view to drop in). */
  drawn: boolean;
};

/** Between two steps a fighter is drawn part way, unless it moved further than this in one step (m): a jump in place. */
const TELEPORT = 2;
/** A trail's ghosts sit this far behind the play plane (m), so a flier's trail never covers another creature. */
const TRAIL_Z = -0.6;
/** A pop shows this far over the spot it is for (m). */
const POP_UP = 0.4;
/** The camera's field of view on the stage (degrees): a flatter side view. */
export const STAGE_FOV = 30;
/** Confetti lies on a platform this far in front of and behind the play plane (m), or falls away. */
const CONFETTI_DEPTH = 1.5;

const _p = new Vector3(), _q = new Quaternion(), _s = new Vector3(), _m = new Matrix4(), _pop = new Vector3();

export class StageShow {
  level: Level;
  scenery: LevelScenery;
  camera: StageCamera;
  koFx: KoFx;
  readonly damage: DamageLook;
  readonly trails: Trails;
  readonly items: ItemLooks;
  readonly bubbles: EdgeBubbles;
  /** The arrows over the creatures controllers steer. */
  readonly arrows: PadArrows;
  readonly drops: DropInLooks;
  readonly finale: Finale;
  /** Who wears the crown (null: nobody). */
  crowned: string | null = null;
  private readonly shown = new Map<string, Shown>();
  /** Scratch, refilled every frame. */
  private readonly targets: { x: number; y: number; h: number }[] = [];
  private readonly giftSpots: { x: number; y: number; h: number }[] = [];
  private readonly list: BubbleFighter[] = [];
  private readonly looks: ItemFighter[] = [];
  private readonly dropLooks: DropLook[] = [];
  private readonly dropPool: DropLook[] = [];
  private readonly trailAt = new Vector3();
  /** Where a creature is drawn this frame (its box), for the arrows. */
  private readonly drawnBox = (id: string) => this.bubble(id);
  /** Level time of the frame drawn (for the platforms confetti lies on), and the show's own clock (s). */
  private levelT = 0;
  private time = 0;
  /** The platforms confetti lies on, placed at level time `confettiT` on `confettiLevel` (scratch, reused). */
  private readonly confettiPlats: Platform[] = [];
  private confettiT = NaN;
  private confettiLevel: Level | null = null;

  /**
   * `renderer`, when given, compiles each new level's shaders as soon as it is built (`useLevel`), so the first frames
   * on it do not stall while the GPU compiles (the dev page warms its own).
   */
  constructor(private readonly o: {
    scene: Scene; camera: PerspectiveCamera; ui: HTMLElement; level: Level;
    pops: { pop(at: Vector3, camera: PerspectiveCamera, word?: string, size?: number): void };
    renderer?: Compiler;
  }) {
    this.level = o.level;
    this.scenery = buildScenery(o.level);
    o.scene.add(this.scenery.root);
    this.camera = new StageCamera(o.camera, o.level);
    this.koFx = new KoFx(o.scene, this.camera.view, o.camera.fov);
    this.damage = new DamageLook(o.scene);
    this.trails = new Trails(o.scene);
    this.items = new ItemLooks(o.scene);
    this.bubbles = new EdgeBubbles(o.ui);
    this.arrows = new PadArrows(o.ui);
    this.drops = new DropInLooks(o.scene);
    this.finale = new Finale(o.scene, { floor: (x, y, z) => this.floorAt(x, y, z) });
  }

  /** Where the camera looks now (the edge bubbles and overlays place themselves by it). */
  get view(): View {
    return this.camera.view;
  }

  /**
   * Moves to level `level`: its scenery (its shaders warmed at once, given a renderer), its camera bounds and knockout
   * effects. Creatures drawn stay (the caller removes them).
   */
  useLevel(level: Level): void {
    this.scenery.dispose();
    this.level = level;
    this.scenery = buildScenery(level);
    this.o.scene.add(this.scenery.root);
    this.camera = new StageCamera(this.o.camera, level);
    this.koFx.dispose();
    this.koFx = new KoFx(this.o.scene, this.camera.view, this.o.camera.fov);
    this.drops.clear();
    // the new level's shaders compiled now, with the camera already placed on it (the first frame there never stalls)
    const r = this.o.renderer;
    if (r) {
      void compileTogether(r, this.scenery.root, this.o.camera, this.o.scene)
        .catch((e) => console.warn('could not warm the level’s shaders', e));
    }
  }

  /**
   * Draws fighter `f` from now on, as `look`. A creature already drawn with the same body and stats (dropping into the
   * next level after Again!) keeps its picture, made fresh (its damage look, trail and power-up looks start again).
   */
  add(f: StageFighter, look: StageLook): void {
    const old = this.shown.get(f.id);
    if (old && old.body === look.body && old.stats === look.stats) {
      this.trails.remove(old);
      this.damage.forget(f.id);
      this.items.forget(f.id);
      old.mem = new PoseMemory();
      animState(f, old.a);
      old.showT = 0;
      old.bubble.name = look.name;
      return;
    }
    this.remove(f.id);
    const { recipe, stats } = look;
    const obj = createFighterObject(look.body, recipe, stats.layout);
    this.o.scene.add(obj.root);
    const colour = `#${trailColour(recipe).getHexString()}`;
    const pieces = stats.layout.segments.map(() => new Matrix4());
    this.shown.set(f.id, {
      id: f.id, body: look.body, stats, obj, pieces, mem: new PoseMemory(), a: animState(f),
      bubble: { id: f.id, x: 0, y: 0, h: stats.h, color: colour, name: look.name },
      look: { id: f.id, item: null, left: Infinity, x: 0, y: 0, w: stats.w, h: stats.h, facing: 1, move: stats.move, colour, layout: stats.layout, pieces },
      colour: new Color(colour), showT: 0, drawn: false,
    });
  }

  /** Stops drawing `id` (its body, damage look, trail and power-up looks go; the crown too if it wore it). */
  remove(id: string): void {
    const s = this.shown.get(id);
    if (!s) return;
    this.trails.remove(s);
    this.damage.forget(id);
    this.items.forget(id);
    if (this.crowned === id) this.uncrown();
    s.obj.root.removeFromParent();
    s.obj.dispose();
    this.shown.delete(id);
  }

  /** Stops drawing everyone. */
  clear(): void {
    for (const id of [...this.shown.keys()]) this.remove(id);
    this.trails.clear();
    this.drops.clear();
  }

  has(id: string): boolean {
    return this.shown.has(id);
  }

  /** The ids it draws. */
  ids(): string[] {
    return [...this.shown.keys()];
  }

  /** How many creatures it draws. */
  get count(): number {
    return this.shown.size;
  }

  /**
   * A controller steers creature `id`: a small arrow in its `colour` (with `label`, the player's number) floats over it
   * while it is on the screen, dimmed and sleepy while the pad `resting` (the AI drives meanwhile). A null colour takes
   * the arrow away.
   */
  mark(id: string, colour: string | null, label = '', resting = false): void {
    this.arrows.set(id, colour, label, resting);
  }

  /** The edge bubble of `id` as drawn this frame (where it is on the stage), for overlays such as the dev page's marker. */
  bubble(id: string): BubbleFighter | undefined {
    const s = this.shown.get(id);
    return s?.drawn ? s.bubble : undefined;
  }

  /** A close-up (a big moment, a drop-in, the champion) of a view `height` m tall on `at`, for `seconds` real s. */
  closeUp(at: V2, height: number, seconds: number): void {
    this.camera.closeUp(at, height, seconds);
  }

  /** The knockout effect for a creature that went out at `at` (themed by the level and the side it left by). */
  knockOut(at: V2): void {
    this.koFx.play(koKind(this.level.id, exitSide(this.level.bounds, at)), at);
  }

  /** A comic word popping up over `at` on the stage. */
  pop(at: V2, word?: string, size?: number): void {
    this.o.pops.pop(_pop.set(at.x, at.y + POP_UP, 0), this.o.camera, word, size);
  }

  /**
   * Crowns `id`: the crown on its head (riding it every frame), and with `confetti` a confetti shower and a glow under
   * its feet. A creature not drawn is not crowned.
   */
  crown(id: string, confetti = true): void {
    const s = this.shown.get(id);
    if (!s) return;
    this.crowned = id;
    this.finale.crownOn(crownSpot(s), confetti);
  }

  /** The confetti and the glow stop; the champion keeps its crown (it drops in wearing it after Again!). */
  stopConfetti(): void {
    this.finale.stop();
  }

  /** The crown, confetti and glow all go. */
  uncrown(): void {
    this.crowned = null;
    this.finale.clear();
  }

  /**
   * Draws one frame of `sim` (stepped by `loop`) after `realDt` real seconds: everyone in play part way between the
   * last two steps, posed (a lone one showing off, a vine rider hanging), with the caller's changes (`o.adjust`); their
   * damage looks, trails, power-ups, presents, parachutes and beams; the scenery at that moment; the camera following
   * everyone drawn (and a present on its way down); the edge bubbles, knockout effects and the crown.
   */
  draw(sim: StageSim, loop: StageLoop, realDt: number, o: DrawOptions): void {
    const alpha = loop.alpha, steps = (realDt * loop.timeScale) / DT, level = this.level;
    this.time += realDt;
    this.levelT = loop.prevTime + (sim.t - loop.prevTime) * alpha;
    this.scenery.update(this.levelT, o.mischief, sim.mischief);
    const targets = this.targets, list = this.list, looks = this.looks, dropLooks = this.dropLooks;
    targets.length = list.length = looks.length = dropLooks.length = 0;
    for (const s of this.shown.values()) s.drawn = false;
    for (const f of sim.fighters()) {
      const s = this.shown.get(f.id);
      if (!s) continue;
      const before = loop.prev(f.id), action = f.action === 'frozen' ? f.frozenFrom : f.action;
      const t = before && before.action === action && f.actionT >= before.t ? before.t + (f.actionT - before.t) * alpha : f.actionT;
      const a = animState(f, s.a, t), p = f.mover.pos;
      // a lone creature posing shows off; one riding a vine hangs from it
      s.showT = loop.showingOff(f.id) && (a.action === 'idle' || a.action === 'run') ? s.showT + steps : 0;
      if (s.showT > 0) {
        a.action = 'showoff';
        a.t = s.showT;
      }
      a.hang = sim.mischief.riding(f.id) >= 0;
      if (before && Math.hypot(p.x - before.x, p.y - before.y) < TELEPORT) {
        a.pos.x = before.x + (p.x - before.x) * alpha;
        a.pos.y = before.y + (p.y - before.y) * alpha;
      }
      const chute = o.adjust?.(f, a);
      s.obj.root.visible = chute !== false;
      if (chute === false) continue;
      s.drawn = true;
      if (typeof chute === 'number' && chute > 0) {
        const d = (this.dropPool[dropLooks.length] ??= { x: 0, y: 0, w: 0, h: 0, chute: 0, floor: 0 });
        d.x = a.pos.x;
        d.y = a.pos.y;
        d.w = f.mover.w;
        d.h = f.mover.h;
        d.chute = chute;
        d.floor = p.y;
        dropLooks.push(d);
      }
      s.mem.elapse(steps);
      driveBonesFrom(s.obj, poseSegments(s.stats.layout, a, s.pieces, s.mem), realDt);
      this.damage.update(f, s.obj, realDt);
      this.trailAt.set(a.pos.x, a.pos.y + f.mover.h / 2, TRAIL_Z);
      this.trails.update(s, this.trailAt, f.mover.h, f.action === 'tumble', s.colour, realDt);
      s.bubble.x = a.pos.x;
      s.bubble.y = a.pos.y;
      s.bubble.h = f.mover.h;
      targets.push(s.bubble);
      list.push(s.bubble);
      const look = s.look;
      look.item = f.item;
      look.left = f.item && TIMED_ITEMS.has(f.item) ? f.itemUntil - sim.t : Infinity;
      look.x = a.pos.x;
      look.y = a.pos.y;
      look.w = f.mover.w;
      look.h = f.mover.h;
      look.facing = f.facing;
      looks.push(look);
    }
    // anyone drawn last frame and no longer in play (out, or taken off) is hidden until the caller removes it
    for (const s of this.shown.values()) if (!s.drawn) s.obj.root.visible = false;
    this.trails.flush();
    this.items.update(sim.items.presents, sim.items.pies, looks, o.items, realDt);
    // the camera keeps a present in shot once it floats down into the level's view (so everyone sees it coming)
    sim.items.presents.forEach((p, i) => {
      if (p.y > level.camera.top) return;
      const g = (this.giftSpots[i] ??= { x: 0, y: 0, h: PRESENT_SIZE });
      g.x = p.x;
      g.y = p.y;
      targets.push(g);
    });
    this.camera.update(targets, realDt);
    this.drops.update(dropLooks, !!o.beam, this.view.cy + this.view.height / 2, this.time);
    this.koFx.update(realDt);
    this.bubbles.update(list, this.view);
    this.arrows.update(this.drawnBox, this.view);
    this.finale.update(realDt);
  }

  /** Takes everything out of the scene and the page. */
  dispose(): void {
    this.clear();
    this.scenery.dispose();
    this.koFx.dispose();
    this.damage.dispose();
    this.trails.dispose();
    this.items.dispose();
    this.bubbles.dispose();
    this.arrows.dispose();
    this.drops.dispose();
    this.finale.dispose();
  }

  /**
   * The platform top confetti at (x, y, z) lies on: the highest under it at or below y (never one over its head), or
   * null where it falls away. The platforms are placed once a frame (asked for ~400 pieces a frame: nothing allocated).
   */
  private floorAt(x: number, y: number, z: number): number | null {
    if (Math.abs(z) > CONFETTI_DEPTH) return null;
    if (this.confettiT !== this.levelT || this.confettiLevel !== this.level) {
      platformsAt(this.level, this.levelT, this.confettiPlats);
      this.confettiT = this.levelT;
      this.confettiLevel = this.level;
    }
    return topBelow(this.confettiPlats, x, y);
  }
}

/**
 * Where a crown sits on a creature as drawn: on top of its head piece, or of its torso when the head is sunk into a
 * fatter torso (a blob's), turned as that piece is now. The piece's world matrix now × its rest matrix⁻¹ carries any
 * point of the body at rest to where it is drawn (as the bones are driven).
 */
function crownSpot(s: Shown): CrownSpot {
  const layout = s.stats.layout, info = bodyInfo(layout), head = Math.max(0, info.joint.indexOf('head'));
  const top = (i: number) => {
    const g = layout.segments[i];
    return Math.max(g.a.y, g.b.y) + g.radius;
  };
  const on = top(0) > top(head) ? 0 : head, seg = layout.segments[on];
  const end = seg.a.y > seg.b.y ? seg.a : seg.b;
  const point = new Vector3(end.x, end.y + seg.radius * 1.05, end.z);
  const restInv = restPieces(layout)[on].invert(), restTurn = new Quaternion().setFromRotationMatrix(restPieces(layout)[on]).invert();
  return {
    height: layout.fightHeight,
    headR: layout.segments[head].radius,
    place(pos, turn) {
      if (!s.drawn) return false;
      _m.multiplyMatrices(s.pieces[on], restInv);
      pos.copy(point).applyMatrix4(_m);
      s.pieces[on].decompose(_p, _q, _s);
      turn.copy(_q).multiply(restTurn);
      return Number.isFinite(pos.x + pos.y + pos.z);
    },
    feet(out) {
      if (!s.drawn) return false;
      out.set(s.a.pos.x, s.a.pos.y, 0);
      return true;
    },
  };
}
