import type RAPIER from '@dimforge/rapier3d-compat';
import type { FeatureCue, RingFeatures } from '../arena/features';
import type { Fighter, FightCtx, Hit } from '../fight/fighter';
import type { SpecialCue } from '../fight/special';
import type { StuntCue } from '../fight/stunts';
import type { Tune } from '../fight/tune';
import { isOut, isUnderFloor, type Match, type MatchEvent } from '../match/match';
import type { Piece } from '../physics/ragdoll';
import { setFrozen } from '../show/entrance';
import type { SlowMo } from '../show/slowmo';

/** One physics step (s). */
export const DT = 1 / 60;
/** At most this many physics steps in one frame (a stalled frame drops the rest rather than spiral). */
export const MAX_STEPS = 4;
/**
 * The most ragdolls one world may hold: each takes one of Rapier's 16 collision-group bits (so its own pieces never
 * collide, Ruling in Task 6). Past 16 two creatures would share a bit and pass through each other.
 */
export const MAX_RAGDOLLS = 16;
/** A fallen fighter is let go this long (s) after it went out, or as soon as it is this far down (the ball pit). */
export const GONE_AFTER_S = 5, GONE_BELOW_Y = -11;
/** A fighter lifted out from under the floor has its lowest point put this high (m). */
export const RESCUE_Y = 0.05;
/** A floor rescue is logged at most this often (sim s) per fighter. */
const RESCUE_LOG_S = 5;
/** A fighter ruled out this soon (sim s) after its entrance, untouched, is put back at its landing spot (once). */
export const GRACE_S = 3;
/** A fresh random stream for the fight (the dev panel may reseed it). */
type Rng = () => number;

/** What the loop asks of an entrance: posing its walkers once per physics step, before anyone thinks. */
export type EntranceStep = { update(dt: number): void };

/**
 * The ring's fight loop (spec §3): fixed 1/60 s physics steps, at most four a frame, scaled by the slow-mo; the match
 * ticks every step (its events go to `onEvents` at once, so an entrance starts before the next step). While the match
 * is frozen for an entrance the fighting fighters are held mid-flail (`setFrozen`) and do not think; the world steps
 * only while someone is entering (the entrance poses them and their show-off limbs swing). Fighters that leave the ring
 * (`isOut`) are ruled out with the match, then let go 5 s later or once they reach the ball pit. A fighter held over
 * a thrower's head (grab and throw) is not ruled out until it is thrown.
 */
export class RingLoop {
  /** Called with the match's events, inside the step that made them. */
  onEvents: (events: MatchEvent[]) => void = () => {};
  /** A fighter was disposed (its ragdoll is gone): take its picture, stars and crown away. */
  onGone: (f: Fighter) => void = () => {};
  /** The crowned champion struts (boasts) and is never frozen; null before a crowning. */
  champion: Fighter | null = null;
  /** The dev panel's "freeze fight during entrances". */
  freeze = true;
  /** Physics seconds simulated so far (the fighters' brains read it). */
  sim = 0;
  /** Fighters lifted back out from under the floor so far (the dev HUD shows it). */
  rescues = 0;
  /** Limp-guard stand-ups by fighters already let go (`standUps` adds those still here). */
  private standUpsGone = 0;
  /** When (sim s) each fighter's floor rescue was last logged. */
  private readonly rescueLogged = new WeakMap<Fighter, number>();
  /** The fighters entering at the start of this step (scratch: whoever the entrance hands back has just landed). */
  private readonly walking: Fighter[] = [];
  private readonly world: RAPIER.World;
  private readonly match: Match;
  private readonly slowmo: SlowMo;
  private readonly tune: Tune;
  private readonly entrance: EntranceStep | null;
  private readonly fighters = new Map<string, Fighter>();
  /** When (real s) each fallen fighter went out. */
  private readonly outAt = new Map<Fighter, number>();
  private readonly tally = new Map<string, number>();
  /** Special cues not yet handed out by `step` (a fighter let go between frames ends its special here). */
  private readonly cues: SpecialCue[] = [];
  /** Stunt cues not yet handed out by `step` (every stunt's `start` is followed by its `end`, as a special's). */
  private readonly stuntCues: StuntCue[] = [];
  /** The wild ring's cues not yet handed out by `step`. */
  private readonly featureCues: FeatureCue[] = [];
  /**
   * The wild ring's pads and events (design 2026-11-14 §5.1), or null: updated every physics step the fight is not
   * frozen (a frozen fight's event waits), reset with Clear the ring (the show resets it at the crowning and Again!).
   */
  readonly features: RingFeatures | null;
  private acc = 0;
  private rng: Rng;
  private readonly ring: Fighter[] = [];
  private readonly ctx: FightCtx;
  private readonly boastCtx: FightCtx;

  constructor(o: {
    world: RAPIER.World; match: Match; slowmo: SlowMo; tune: Tune; entrance?: EntranceStep | null; rng?: Rng; features?: RingFeatures | null;
  }) {
    this.world = o.world;
    this.match = o.match;
    this.slowmo = o.slowmo;
    this.tune = o.tune;
    this.entrance = o.entrance ?? null;
    this.features = o.features ?? null;
    this.rng = o.rng ?? Math.random;
    this.ctx = { others: this.ring, boast: false, tune: this.tune, rng: (() => this.rng()) };
    this.boastCtx = { ...this.ctx, boast: true };
  }

  /** How many fighters (ragdolls) it holds, fallen ones included. */
  get size(): number {
    return this.fighters.size;
  }

  /** Times the limp guard stood a fighter up, all told (`Fighter.standUps`, the dev HUD shows it). */
  get standUps(): number {
    let n = this.standUpsGone;
    for (const f of this.fighters.values()) n += f.standUps;
    return n;
  }

  get(id: string): Fighter | undefined {
    return this.fighters.get(id);
  }

  all(): Fighter[] {
    return [...this.fighters.values()];
  }

  /**
   * Is there room for one more ragdoll? When the world is full the earliest fallen fighters are let go now to make it.
   * False only when every ragdoll is still in play (never with at most 8 in the ring).
   */
  makeRoom(): boolean {
    if (this.fighters.size < MAX_RAGDOLLS) return true;
    const fallen = [...this.fighters.values()].filter((f) => f.state === 'out' || f.state === 'gone')
      .sort((a, b) => (this.outAt.get(a) ?? -Infinity) - (this.outAt.get(b) ?? -Infinity));
    for (const f of fallen) {
      this.let(f);
      if (this.fighters.size < MAX_RAGDOLLS) return true;
    }
    return false;
  }

  /** Takes a fighter into the ring loop (made just now, for its entrance). Throws past MAX_RAGDOLLS: call `makeRoom` first. */
  add(f: Fighter): void {
    if (this.fighters.get(f.id) === f) return;
    const old = this.fighters.get(f.id);
    if (old) this.let(old);
    if (this.fighters.size >= MAX_RAGDOLLS) throw new Error(`too many ragdolls in one world (${MAX_RAGDOLLS} at most)`);
    this.fighters.set(f.id, f);
  }

  /** Lets a fighter go now: its ragdoll leaves the world. */
  remove(id: string): void {
    const f = this.fighters.get(id);
    if (f) this.let(f);
  }

  /** Lets every fighter go (Clear the ring). */
  clear(): void {
    for (const f of [...this.fighters.values()]) this.let(f);
    this.champion = null;
    this.tally.clear();
    this.acc = 0;
    this.features?.reset();
  }

  /** Hits landed this round, by fighter id (fallen fighters' too), for `Match.crown`. */
  hits(): Map<string, number> {
    return new Map(this.tally);
  }

  /** A new round: nobody has landed anything yet. */
  resetHits(): void {
    this.tally.clear();
    for (const f of this.fighters.values()) f.hits = 0;
  }

  /**
   * One frame of `realDt` s at real time `now` (s): the hits landed and the fighters ruled out, with the match's events,
   * and the special-attack cues in order (every special's `charge` is followed by its `end`, even when its fighter is
   * ruled out or let go mid-special), and the stunt cues in order (each `start` followed by its `end` the same way), and
   * the wild ring's cues.
   */
  step(realDt: number, now: number): {
    hits: Hit[]; outs: string[]; events: MatchEvent[]; specials: SpecialCue[]; stunts: StuntCue[]; features: FeatureCue[];
  } {
    const hits: Hit[] = [], outs: string[] = [], events: MatchEvent[] = [];
    this.acc += Math.max(0, realDt) * this.slowmo.timeScale(now);
    let n = 0;
    while (this.acc >= DT - 1e-9 && n < MAX_STEPS) {
      this.physicsStep(now, hits, outs, events);
      this.collectCues();
      this.acc -= DT;
      n++;
    }
    if (n === MAX_STEPS) this.acc = 0;
    this.dropFallen(now);
    this.collectCues();
    return { hits, outs, events, specials: this.cues.splice(0), stunts: this.stuntCues.splice(0), features: this.featureCues.splice(0) };
  }

  private collectCues(): void {
    for (const f of this.fighters.values()) {
      const cs = f.takeCues();
      if (cs.length) this.cues.push(...cs);
      const ss = f.takeStuntCues();
      if (ss.length) this.stuntCues.push(...ss);
    }
  }

  private emit(evs: MatchEvent[], into: MatchEvent[]): void {
    if (!evs.length) return;
    into.push(...evs);
    this.onEvents(evs);
  }

  private physicsStep(now: number, hits: Hit[], outs: string[], events: MatchEvent[]): void {
    this.emit(this.match.tick(DT), events);
    const ring = this.ring;
    ring.length = 0;
    for (const f of this.fighters.values()) if (f.state === 'fighting' || f.state === 'entering') ring.push(f);
    const frozen = this.freeze && this.match.frozen;
    const feats = this.features;
    feats?.hold(frozen);
    // the fighters' jumps read Moon Jump's gravity, and they see the pads and posts
    this.ctx.airTune = this.boastCtx.airTune = feats ? feats.fightTune(this.tune) : this.tune;
    this.ctx.gravityScale = this.boastCtx.gravityScale = feats && !frozen ? feats.gravityScale : 1;
    this.ctx.pads = this.boastCtx.pads = feats?.pads;
    let entering = false;
    for (const f of ring) {
      if (f.state === 'entering') entering = true;
      setFrozen([f], frozen && f.state === 'fighting' && f !== this.champion);
    }
    if (frozen && !entering) return; // nothing moves: the fight waits mid-flail
    const walking = this.walking;
    walking.length = 0;
    for (const f of ring) if (f.state === 'entering') walking.push(f);
    this.entrance?.update(DT);
    for (const f of walking) if (f.state === 'fighting') f.enteredAt = this.sim; // handed back: its grace starts
    const m = this.match;
    const fighting = ring.filter((f) => f.state === 'fighting');
    const alone = fighting.length === 1 && m.entering.length === 0 && m.onDeck.length === 0 && m.phase === 'open';
    let broken: Fighter[] | null = null;
    for (const f of ring) {
      if (frozen && f.state === 'fighting' && f !== this.champion) continue;
      const boast = f === this.champion || (alone && !this.champion && f.state === 'fighting');
      let landed: Hit[];
      try {
        landed = f.think(DT, this.sim, boast ? this.boastCtx : this.ctx);
      } catch (e) {
        console.error(`fighter ${f.id} failed to think: it leaves the ring`, e);
        (broken ??= []).push(f);
        continue;
      }
      for (const h of landed) {
        hits.push(h);
        this.tally.set(h.attacker.id, (this.tally.get(h.attacker.id) ?? 0) + 1);
      }
    }
    if (broken) this.dropBroken(broken, outs, events);
    if (feats && !frozen) {
      const canStart = fighting.length >= 2 && m.entering.length === 0 && m.phase === 'open' && !this.champion;
      const fs = feats.update(DT, ring.filter((f) => f.state === 'fighting'), canStart);
      if (fs.length) this.featureCues.push(...fs);
    }
    this.world.step();
    this.sim += DT;
    const R = this.tune.ringRadius;
    // (a fighter held over a thrower's head is placed there: never rescued, never ruled out until it is thrown)
    for (const f of ring) {
      if ((f.state === 'fighting' || f.state === 'entering') && f.ragdoll.pieces.length && !f.held) this.floorRescue(f, R);
    }
    const out: string[] = [];
    for (const f of ring) {
      if (f.state !== 'fighting' || f.held || !isOut(f.ragdoll.pos(), R)) continue;
      if (this.grace(f)) continue;
      f.state = 'out';
      this.outAt.set(f, now);
      if (f === this.champion) this.champion = null;
      out.push(f.id);
    }
    if (out.length) {
      outs.push(...out);
      this.emit(this.match.ringOut(out), events);
    }
  }

  /**
   * The floor rescue: a fighter whose torso is under the floor inside the ring (`isUnderFloor`: it went through) is
   * lifted straight up until its lowest point is RESCUE_Y over the floor, and nothing of it keeps falling. Counted in
   * `rescues`; logged at most every RESCUE_LOG_S per fighter, naming it.
   */
  private floorRescue(f: Fighter, R: number): void {
    const t = f.ragdoll.torso.body.translation();
    if (!isUnderFloor(t, R)) return;
    let low = Infinity;
    for (const p of f.ragdoll.pieces) low = Math.min(low, lowestPoint(p));
    const up = RESCUE_Y - low;
    for (const p of f.ragdoll.pieces) {
      const at = p.body.translation(), v = p.body.linvel();
      p.body.setTranslation({ x: at.x, y: at.y + up, z: at.z }, true);
      if (v.y < 0) p.body.setLinvel({ x: v.x, y: 0, z: v.z }, true);
    }
    this.rescues++;
    const last = this.rescueLogged.get(f);
    if (last !== undefined && this.sim - last < RESCUE_LOG_S - 1e-9) return;
    this.rescueLogged.set(f, this.sim);
    // what kind of body went through: how heavy, and how thin its thinnest piece is (skinny legs are the suspect)
    let thinnest = Infinity;
    for (const p of f.ragdoll.pieces) thinnest = Math.min(thinnest, p.seg.radius);
    console.warn('floor rescue', {
      id: f.id, y: t.y, r: Math.hypot(t.x, t.z), pieces: f.ragdoll.pieces.length, mass: f.ragdoll.mass, thinnest,
    });
  }

  /**
   * The entrance grace: a fighter ruled out within GRACE_S of its entrance ending that nobody has touched (no wobble)
   * fell out on its own, which is never the show's fault to keep: it is put back standing at its landing spot, facing
   * the ring's middle. Once per entrance (its landing spot is spent). True when it was put back.
   */
  private grace(f: Fighter): boolean {
    const land = f.landing;
    if (!land || f.wobble > 0 || this.sim - f.enteredAt > GRACE_S + 1e-9) return false;
    f.landing = null;
    const was = f.ragdoll.pos();
    f.ragdoll.pose(land, Math.atan2(-land.x, -land.z));
    console.warn('entrance grace', { id: f.id, at: { x: was.x, y: was.y, z: was.z }, landing: { x: land.x, z: land.z } });
    return true;
  }

  /**
   * Fighters whose brain threw: one bad creature must never stop the night. Each is ruled out (as if it fell) and let
   * go at once, so the world keeps stepping for everyone else.
   */
  private dropBroken(broken: Fighter[], outs: string[], events: MatchEvent[]): void {
    const out = broken.filter((f) => f.state === 'fighting').map((f) => f.id);
    for (const f of broken) if (f.state === 'fighting') f.state = 'out';
    if (out.length) {
      outs.push(...out);
      this.emit(this.match.ringOut(out), events);
    }
    for (const f of broken) this.let(f);
  }

  /** Fallen fighters 5 s after they went out, or once in the pit, leave the world. */
  private dropFallen(now: number): void {
    for (const f of this.fighters.values()) {
      if (f.state === 'gone') { this.let(f); continue; }
      if (f.state !== 'out') continue;
      const at = this.outAt.get(f) ?? now;
      if (now - at >= GONE_AFTER_S - 1e-9 || !(f.ragdoll.pos().y > GONE_BELOW_Y)) this.let(f);
    }
  }

  private let(f: Fighter): void {
    if (this.fighters.get(f.id) === f) {
      this.fighters.delete(f.id);
      this.standUpsGone += f.standUps;
    }
    this.outAt.delete(f);
    if (this.champion === f) this.champion = null;
    const had = f.state !== 'gone' || f.ragdoll.pieces.length > 0;
    f.dispose();
    this.cues.push(...f.takeCues()); // a special cut short ends here
    this.stuntCues.push(...f.takeStuntCues()); // and a stunt
    if (had) this.onGone(f);
  }
}

/** The height of a piece's lowest point: its capsule's lower end (its axis is its local +y) less its radius. */
function lowestPoint(p: Piece): number {
  const t = p.body.translation(), q = p.body.rotation();
  const half = Math.hypot(p.seg.b.x - p.seg.a.x, p.seg.b.y - p.seg.a.y, p.seg.b.z - p.seg.a.z) / 2;
  const axisY = 1 - 2 * (q.x * q.x + q.z * q.z); // the local +y axis's height, turned
  return t.y - Math.abs(axisY) * half - p.seg.radius;
}
