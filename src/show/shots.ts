import { Vector3 } from 'three/webgpu';
import { POST_H, POST_RADIUS } from '../arena/features';
import { postAngles } from '../arena/geometry';

/**
 * The shot director's framing (wild ring design 2026-11-14 §6): where each shot puts the camera, what it looks at and
 * how wide it sees, worked out from the fighters' torsos. Pure: no scene, no clock of its own, no randomness (a shot's
 * own angle and side are chosen at its cut and handed in), so every shot can be checked headless frame by frame. Every
 * frame keeps the camera out of the fighters, the bumper, the ring's posts, the props and the stands, and its lines of
 * sight to the fighters' feet clear the bumper (`clearHeight`). `shot-picker.ts` chooses which shot; `CameraDirector`
 * eases the camera along it.
 */

export type ShotName = 'wide' | 'duel' | 'hero' | 'low' | 'top' | 'flier' | 'ringOut' | 'crane';
/** Every shot, in the order the dev key V steps through them. */
export const SHOT_NAMES: readonly ShotName[] = ['wide', 'duel', 'hero', 'low', 'top', 'flier', 'ringOut', 'crane'];
/** Where a shot puts the camera, what it looks at and its vertical field of view (degrees). */
export type ShotFrame = { pos: Vector3; look: Vector3; fov: number };
/** A fighter as a shot sees it: its torso (m) and how tall it stands (m). */
export type ShotBody = { x: number; y: number; z: number; h: number; vx?: number; vz?: number };
/** Something the camera keeps out of: a ball round `at`, `r` m. */
export type Sphere = { x: number; y: number; z: number; r: number };
/** The ring as the shots see it. */
export type ShotStage = { ringRadius: number; bumper: number };

/**
 * What a shot frames this frame: `all` (everyone fighting), its subjects `a` and `b` (who the shot is about, when it is
 * about someone), how long it has run (`t`, s), its own angle (rad, set at its cut by `shotAngle`) and side (±1), the
 * camera's shape (`aspect`) and the things the camera must keep out of (`keepOut`: the fighters, the props).
 */
export type ShotView = {
  all: readonly ShotBody[]; a?: ShotBody; b?: ShotBody; t: number; angle: number; side: number; aspect: number;
  keepOut: readonly Sphere[];
};

// ---------------- the shots' numbers (design §6) ----------------
/** wide: framed to the fighters' spread, 6–13 m away, orbiting at 0.12 rad/s, looking down as today's (7 m up at 11.5). */
export const WIDE_NEAR = 6, WIDE_FAR = 13, WIDE_ORBIT = 0.12, WIDE_FOV = 50, WIDE_PITCH = Math.atan2(7, 11.5);
/**
 * duel: side-on to an engaged pair, 1.4–2 m up, 3.5–7 m away (fitting both), fov 42°, swaying DUEL_SWAY rad either side
 * of side-on as sin(DUEL_SWAY_RATE t) (arcing slowly round them: at most about 0.09 rad/s).
 */
export const DUEL_LOW = 1.4, DUEL_HIGH = 2, DUEL_NEAR = 3.5, DUEL_FAR = 7, DUEL_FOV = 42, DUEL_SWAY = 0.35, DUEL_SWAY_RATE = 0.25;
/**
 * hero: a three-quarter chase on one fighter (HERO_TURN rad off straight behind it), fov 42°, near enough that it fills
 * HERO_FILL of the frame's height, never nearer than HERO_NEAR m, looking down HERO_PITCH rad, leading it by HERO_LEAD m.
 */
export const HERO_FOV = 42, HERO_TURN = Math.PI / 4, HERO_FILL = 0.28, HERO_NEAR = 3.2, HERO_PITCH = 0.3, HERO_LEAD = 0.8;
/**
 * low: just outside the bumper (LOW_OUT m past the ring's edge) 0.9 m up, looking across the floor at the action, fov
 * 60°; its place round the ring is the one about LOW_DIST m from the action (never nearer than LOW_MIN m).
 */
export const LOW_OUT = 0.85, LOW_UP = 0.9, LOW_FOV = 60, LOW_DIST = 6.5, LOW_MIN = 4;
/** The low shot keeps this far (rad round the ring) from the ring's corner posts, so it never stands right by one. */
export const LOW_POST_GAP = 0.3;
/** top: straight down from 15 m (tipped TOP_TILT m off plumb, so it has an up), turning TOP_TURN rad/s; fov 50°. */
export const TOP_UP = 15, TOP_TURN = 0.06, TOP_TILT = 1.2, TOP_FOV = 50;
/** flier: beside a big launch's flight, FLIER_DIST m off it and FLIER_UP m above, a little behind it; fov 50°. */
export const FLIER_DIST = 6, FLIER_UP = 1.5, FLIER_BACK = 0.45, FLIER_FOV = 50;
/**
 * ringOut: from RINGOUT_IN m inside the ring's edge, RINGOUT_SWING rad round from where it flew out, RINGOUT_UP m up,
 * it watches the flier fall toward the pit (for 1.6 s: the picker's RINGOUT_S); fov 50°.
 */
export const RINGOUT_IN = 1.8, RINGOUT_SWING = 0.55, RINGOUT_UP = 3.5, RINGOUT_FOV = 50;
/** crane: a CRANE_S s rise from a low shot to a high wide shot, LOW_OUT past the edge on the far side of the action. */
export const CRANE_S = 5, CRANE_FAR = 0.6;

// ---------------- keeping out of things ----------------
/** The camera keeps this far (m) clear of the bumper and the stands' tops. */
export const KEEP = 0.25;
/** A fighter is kept out of as a ball round its torso: FIGHTER_R × its height plus FIGHTER_PAD m. */
export const FIGHTER_R = 0.6, FIGHTER_PAD = 0.35;
/** The bumper: its tube is BUMPER_HALF m either side of BUMPER_MID m past the ring's radius (the arena's torus). */
const BUMPER_HALF = 0.28, BUMPER_MID = 0.15;
/** Lines of sight pass this far (m) over the bumper; a fighter this near its band (m) is up on it, in sight. */
const BUMPER_CLEAR = 0.2, ON_BUMPER = 0.35;
/** The ring's corner posts (arena.ts): ROPE_POST_OUT m past the edge, topped by a knob ROPE_POST_TOP m up. */
export const ROPE_POST_OUT = 0.6, ROPE_POST_TOP = 1.3, ROPE_POST_R = 0.35;
/**
 * The crowd's stands (crowd-stands.ts `CROWD_ROWS`): they start STANDS_IN m out and the crowd on them reaches STANDS_TOP
 * m up (the back row's seat, a blob, and a roar's jump).
 */
export const STANDS_IN = 14.25, STANDS_TOP = 1.5;
/** The camera never goes under this (m). */
const FLOOR_MIN = 0.5;
/** A torso sits this far up a fighter (× its height): its feet are this much under it. */
const TORSO_AT = 0.55;

const smooth01 = (k: number) => {
  const x = Math.min(1, Math.max(0, k));
  return x * x * (3 - 2 * x);
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The sphere a fighter keeps the camera out of. */
export function fighterSphere(b: ShotBody, out: Sphere = { x: 0, y: 0, z: 0, r: 0 }): Sphere {
  out.x = b.x; out.y = b.y; out.z = b.z; out.r = FIGHTER_R * b.h + FIGHTER_PAD;
  return out;
}

/** The camera keeps this far (m) clear of the beach ball and a risen pinball post. */
export const PROP_PAD = 0.4;

/**
 * The wild ring's props as balls to keep out of (`RingFeatures`): the beach ball, and every pinball post risen out of
 * the floor. Writes into `out` (reusing its balls).
 */
export function propSpheres(f: {
  readonly posts: readonly { readonly at: { x: number; z: number }; readonly up: number }[];
  readonly ball: { readonly body: { translation(): { x: number; y: number; z: number } }; readonly radius: number } | null;
}, out: Sphere[]): Sphere[] {
  let n = 0;
  const next = () => out[n] ?? (out[n] = { x: 0, y: 0, z: 0, r: 0 });
  for (const p of f.posts) {
    if (!(p.up > 0.2)) continue;
    const s = next();
    n++;
    s.x = p.at.x; s.y = POST_H / 2; s.z = p.at.z; s.r = Math.hypot(POST_H / 2, POST_RADIUS + 0.17) + PROP_PAD;
  }
  if (f.ball) {
    const s = next(), t = f.ball.body.translation();
    n++;
    s.x = t.x; s.y = t.y; s.z = t.z; s.r = f.ball.radius + PROP_PAD;
  }
  out.length = n;
  return out;
}

/** The ring's corner posts as spheres to keep out of (one ball over each post's top half, knob and all). */
export function ropePosts(stage: ShotStage): Sphere[] {
  const r = stage.ringRadius + ROPE_POST_OUT;
  return postAngles().map((a) => ({ x: Math.cos(a) * r, y: ROPE_POST_TOP / 2, z: Math.sin(a) * r, r: ROPE_POST_TOP / 2 + ROPE_POST_R }));
}

/**
 * The lowest camera height at (px, pz) whose straight line to the point (fx, lift, fz) passes BUMPER_CLEAR over the
 * bumper wherever it crosses it (the bumper is a band BUMPER_HALF either side of ringRadius + BUMPER_MID). −Infinity
 * when the line never crosses it.
 */
export function clearHeight(fx: number, fz: number, lift: number, px: number, pz: number, stage: ShotStage): number {
  const mid = stage.ringRadius + BUMPER_MID, top = stage.bumper + BUMPER_CLEAR;
  let need = -Infinity;
  for (let i = 1; i <= 48; i++) {
    const u = i / 48, x = fx + (px - fx) * u, z = fz + (pz - fz) * u;
    if (Math.abs(Math.hypot(x, z) - mid) > BUMPER_HALF + 0.1) continue;
    need = Math.max(need, lift + (top - lift) / u); // the line's height there is lift + u × (y − lift)
  }
  return need;
}

/**
 * Keeps the camera at `pos` clear of everything: its line of sight to every one of `targets`' feet passes over the
 * bumper, it is over the bumper itself, over the stands' crowd and off the floor (it is lifted for these), and outside
 * every `keepOut` ball and the ring's posts. A shot's own frame is lifted out of a ball (only ever up, so its framing
 * barely moves); the eased camera (`push`) is pushed out of a ball to its nearest surface instead, which moves it
 * smoothly as a fighter walks into it. Writes into `pos`.
 */
export function keepClear(pos: Vector3, targets: readonly ShotBody[], keepOut: readonly Sphere[], posts: readonly Sphere[],
  stage: ShotStage, push = false): Vector3 {
  for (let pass = 0; pass < 2; pass++) {
    let y = Math.max(pos.y, FLOOR_MIN);
    for (const b of targets) {
      if (onBumper(b, stage)) continue; // up on the bumper (a rope spring): it is in sight over it already
      y = Math.max(y, clearHeight(b.x, b.z, feetOf(b, stage), pos.x, pos.z, stage));
    }
    const r = Math.hypot(pos.x, pos.z);
    if (Math.abs(r - (stage.ringRadius + BUMPER_MID)) < BUMPER_HALF + KEEP) y = Math.max(y, stage.bumper + KEEP);
    if (r > STANDS_IN - KEEP) y = Math.max(y, STANDS_TOP + KEEP);
    pos.y = y;
    // out of any ball it is in (a second time round, as getting out of one may put it into another, or under the bumper)
    outOf(pos, keepOut, push);
    outOf(pos, posts, push);
  }
  return pos;
}

/** Out of every ball in `balls` the camera at `pos` is in: lifted to its top, or (`push`) to its nearest side. */
function outOf(pos: Vector3, balls: readonly Sphere[], push: boolean): void {
  for (const s of balls) {
    const dx = pos.x - s.x, dy = pos.y - s.y, dz = pos.z - s.z, flat = dx * dx + dz * dz;
    if (flat + dy * dy >= s.r * s.r) continue;
    if (push) {
      const d = Math.sqrt(flat + dy * dy);
      if (d > 1e-6) pos.set(s.x + (dx / d) * (s.r + 0.01), s.y + (dy / d) * (s.r + 0.01), s.z + (dz / d) * (s.r + 0.01));
      else pos.y = s.y + s.r + 0.01;
    } else pos.y = s.y + Math.sqrt(s.r * s.r - flat) + 0.05;
  }
}

/** How high (m) a fighter's feet are: on the floor at the least, over the ring; falling past it they go on down. */
export function feetOf(b: ShotBody, stage: ShotStage): number {
  const feet = b.y - TORSO_AT * b.h;
  return Math.hypot(b.x, b.z) < stage.ringRadius ? Math.max(0, feet) : feet;
}

/** Is this fighter on or over the bumper (its feet within ON_BUMPER m of the bumper's band)? No line to it can pass over. */
export function onBumper(b: ShotBody, stage: ShotStage): boolean {
  return Math.abs(Math.hypot(b.x, b.z) - (stage.ringRadius + BUMPER_MID)) < BUMPER_HALF + ON_BUMPER;
}

/** The middle of `bs` (their torsos' mean), written into `out`; the ring's middle for nobody. */
function centreOf(bs: readonly ShotBody[], out: Vector3): Vector3 {
  out.set(0, 0, 0);
  if (!bs.length) return out.set(0, 1, 0);
  for (const b of bs) out.add(_v.set(b.x, b.y, b.z));
  return out.multiplyScalar(1 / bs.length);
}

/** How far (m) a camera must stand from a ball `r` m round for it to fill no more than 85% of the narrower half-view. */
function fitDist(r: number, fov: number, aspect: number): number {
  const halfV = (fov * Math.PI) / 360, halfH = Math.atan(Math.tan(halfV) * aspect);
  return r / Math.sin(0.85 * Math.min(halfV, halfH));
}

/**
 * The shot's subjects (`a`, `b`), or everyone fighting when it is about nobody: `view.all` itself, or `out` (cleared
 * and filled) holding the subjects. Allocates nothing.
 */
export function subjectsOf(view: ShotView, out: ShotBody[]): readonly ShotBody[] {
  out.length = 0;
  if (view.a) out.push(view.a);
  if (view.b) out.push(view.b);
  return out.length ? out : view.all;
}
/** Scratch for the shots' subjects (one shot is framed at a time). */
const _subj: ShotBody[] = [];

/**
 * The shot's own angle (rad), chosen at its cut: the wide shot, the top shot and the crane start from `pick` (0 … 1,
 * the picker's roll); the low shot and the crane stand on the far side of the action; the hero shot chases its fighter
 * the way it is heading; the flier and the ring-out shots go by its flight.
 */
export function shotAngle(name: ShotName, view: ShotView, pick: number, stage: ShotStage): number {
  const subj = subjectsOf(view, _subj), c = centreOf(subj, _c);
  if (name === 'low') return lowAngle(subj, c, pick, stage);
  if (name === 'crane') return Math.atan2(c.z, c.x) + Math.PI + (pick - 0.5) * 2 * CRANE_FAR;
  if (name === 'hero' && view.a) return headingOf(view.a, view.b ?? null);
  if (name === 'duel' && view.a && view.b) return duelBearing(view.a, view.b, pick * Math.PI * 2);
  if ((name === 'flier' || name === 'ringOut') && view.a) {
    const a = view.a, v = Math.hypot(a.vx ?? 0, a.vz ?? 0);
    return v > 1 ? Math.atan2(a.vz ?? 0, a.vx ?? 0) : Math.atan2(a.z, a.x);
  }
  return pick * Math.PI * 2;
}

/** Where a fighter is heading (rad round +y from +x, flat): its run when it runs, else toward `toward`, else the middle. */
function headingOf(a: ShotBody, toward: ShotBody | null): number {
  if (Math.hypot(a.vx ?? 0, a.vz ?? 0) > 1.5) return Math.atan2(a.vz ?? 0, a.vx ?? 0);
  if (toward && Math.hypot(toward.x - a.x, toward.z - a.z) > 0.3) return Math.atan2(toward.z - a.z, toward.x - a.x);
  return Math.hypot(a.x, a.z) > 0.3 ? Math.atan2(-a.z, -a.x) : 0;
}

/** The low shot's place round the ring: about LOW_DIST m from the action, not behind a post; `pick` breaks ties. */
function lowAngle(subj: readonly ShotBody[], c: Vector3, pick: number, stage: ShotStage): number {
  const r = stage.ringRadius + LOW_OUT, posts = postAngles();
  let best = 0, bestScore = Infinity;
  for (let i = 0; i < 48; i++) {
    const ang = (i / 48) * Math.PI * 2;
    if (posts.some((p) => Math.abs(Math.atan2(Math.sin(ang - p), Math.cos(ang - p))) < LOW_POST_GAP)) continue;
    const px = Math.cos(ang) * r, pz = Math.sin(ang) * r;
    let score = Math.abs(Math.hypot(c.x - px, c.z - pz) - LOW_DIST);
    for (const b of subj) if (Math.hypot(b.x - px, b.z - pz) < LOW_MIN) score += 10;
    const pref = pick * Math.PI * 2;
    score += 0.4 * Math.abs(Math.atan2(Math.sin(ang - pref), Math.cos(ang - pref)));
    if (score < bestScore) { bestScore = score; best = ang; }
  }
  return best;
}

/**
 * The frame of shot `name` over `view`: written into `out` and returned. The camera is always kept clear of things
 * (`keepClear`); `posts` are the ring's corner posts (`ropePosts`).
 */
export function shotFrame(name: ShotName, view: ShotView, stage: ShotStage, posts: readonly Sphere[], out: ShotFrame): ShotFrame {
  const subj = subjectsOf(view, _subj);
  switch (name) {
    case 'wide': wideFrame(view.all.length ? view.all : subj, view, view.angle + WIDE_ORBIT * view.t, out); break;
    case 'duel': duelFrame(view, subj, out); break;
    case 'hero': heroFrame(view, subj, out); break;
    case 'low': lowFrame(subj, view.angle, stage, out); break;
    case 'top': topFrame(view, subj, out); break;
    case 'flier': flierFrame(view, subj, out); break;
    case 'ringOut': ringOutFrame(view, subj, stage, out); break;
    case 'crane': craneFrame(view, subj, stage, posts, out); break;
  }
  keepClear(out.pos, subj, view.keepOut, posts, stage);
  return out;
}

/** The wide shot: round the action's middle at `angle`, as far as its spread needs (6–13 m), looking down WIDE_PITCH. */
function wideFrame(bs: readonly ShotBody[], view: ShotView, angle: number, out: ShotFrame): void {
  // the look: the middle of everyone, half-way up from the lowest torso to the highest (a high flier stays in)
  centreOf(bs, out.look);
  let lo = Infinity, hi = -Infinity;
  for (const b of bs) { lo = Math.min(lo, b.y); hi = Math.max(hi, b.y); }
  out.look.y = bs.length ? (lo + hi) / 2 : 1;
  let spread = 0;
  for (const b of bs) spread = Math.max(spread, Math.hypot(b.x - out.look.x, b.y - out.look.y, b.z - out.look.z) + 0.5 * b.h);
  const d = clamp(fitDist(spread + 0.5, WIDE_FOV, view.aspect), WIDE_NEAR, WIDE_FAR);
  const flat = Math.cos(WIDE_PITCH) * d;
  out.pos.set(out.look.x + Math.cos(angle) * flat, out.look.y + Math.sin(WIDE_PITCH) * d, out.look.z + Math.sin(angle) * flat);
  out.fov = WIDE_FOV;
}

/**
 * The duel: from `view.angle` round the pair's middle (the director keeps it side-on to them: `duelBearing`), swaying
 * slowly, as near as fits them both (3.5–7 m), 1.4–2 m up, looking at the middle of them.
 */
function duelFrame(view: ShotView, subj: readonly ShotBody[], out: ShotFrame): void {
  const a = view.a ?? subj[0], b = view.b ?? subj[1] ?? subj[0];
  if (!a) return wideFrame(view.all, view, view.angle, out);
  out.look.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  const ang = view.angle + view.side * DUEL_SWAY * Math.sin(DUEL_SWAY_RATE * view.t);
  const d = clamp(duelNeed(a, b, view.aspect), DUEL_NEAR, DUEL_FAR);
  out.pos.set(out.look.x + Math.cos(ang) * d, clamp(out.look.y + 0.7, DUEL_LOW, DUEL_HIGH), out.look.z + Math.sin(ang) * d);
  out.fov = DUEL_FOV;
}

/**
 * Side-on to a pair: of the two bearings square to the line between `a` and `b` (rad round +y from +x, from their
 * middle), the one nearer `from` (so the camera never swings across them). `from` itself while they stand together.
 */
export function duelBearing(a: ShotBody, b: ShotBody, from: number): number {
  const ax = b.x - a.x, az = b.z - a.z;
  if (Math.hypot(ax, az) < 0.2) return from;
  const square = Math.atan2(az, ax) + Math.PI / 2;
  return Math.cos(square - from) >= 0 ? square : square + Math.PI;
}

/** How far (m) the duel needs to stand back to fit `a` and `b`, uncapped (past DUEL_FAR the pair is no duel). */
export function duelNeed(a: ShotBody, b: ShotBody, aspect: number): number {
  const sep = Math.hypot(b.x - a.x, b.z - a.z), half = sep / 2 + 0.55 * Math.max(a.h, b.h);
  const tall = 0.6 * Math.max(a.h, b.h) + Math.abs(a.y - b.y) / 2;
  const halfV = (DUEL_FOV * Math.PI) / 360, halfH = Math.atan(Math.tan(halfV) * aspect);
  return Math.max(half / Math.tan(0.8 * halfH), tall / Math.tan(0.8 * halfV));
}

/** The hero shot: behind its fighter and HERO_TURN to the `side`, chasing it the way it was heading at the cut. */
function heroFrame(view: ShotView, subj: readonly ShotBody[], out: ShotFrame): void {
  const a = view.a ?? subj[0];
  if (!a) return wideFrame(view.all, view, view.angle, out);
  const halfV = (HERO_FOV * Math.PI) / 360;
  const d = Math.max(HERO_NEAR, a.h / (2 * HERO_FILL * Math.tan(halfV)));
  const back = view.angle + Math.PI + view.side * HERO_TURN, flat = Math.cos(HERO_PITCH) * d;
  out.look.set(a.x + Math.cos(view.angle) * HERO_LEAD, a.y, a.z + Math.sin(view.angle) * HERO_LEAD);
  out.pos.set(a.x + Math.cos(back) * flat, a.y + Math.sin(HERO_PITCH) * d, a.z + Math.sin(back) * flat);
  out.fov = HERO_FOV;
}

/** The low shot: just outside the bumper at `angle`, 0.9 m up (or as high as the bumper needs), looking at the action. */
function lowFrame(subj: readonly ShotBody[], angle: number, stage: ShotStage, out: ShotFrame): void {
  centreOf(subj, out.look);
  const r = stage.ringRadius + LOW_OUT;
  out.pos.set(Math.cos(angle) * r, LOW_UP, Math.sin(angle) * r);
  out.fov = LOW_FOV;
}

/** The top shot: straight down over the action from 15 m (higher when it is spread wider than that sees), turning. */
function topFrame(view: ShotView, subj: readonly ShotBody[], out: ShotFrame): void {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const b of subj) { x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x); z0 = Math.min(z0, b.z); z1 = Math.max(z1, b.z); }
  if (!subj.length) x0 = x1 = z0 = z1 = 0;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  let spread = 0;
  for (const b of subj) spread = Math.max(spread, Math.hypot(b.x - cx, b.z - cz) + 0.6 * b.h);
  const halfV = (TOP_FOV * Math.PI) / 360, half = Math.min(Math.tan(halfV), Math.tan(halfV) * view.aspect);
  let hi = 0;
  for (const b of subj) hi = Math.max(hi, b.y);
  const up = Math.max(TOP_UP, (spread + 0.8) / (0.85 * half), hi + 6);
  const turn = view.angle + TOP_TURN * view.t;
  out.look.set(cx, 0, cz);
  out.pos.set(cx + Math.cos(turn) * TOP_TILT, up, cz + Math.sin(turn) * TOP_TILT);
  out.fov = TOP_FOV;
}

/** The flier shot: beside the flight (square to the way it set off), a little behind and above it, looking at it. */
function flierFrame(view: ShotView, subj: readonly ShotBody[], out: ShotFrame): void {
  const a = view.a ?? subj[0];
  if (!a) return wideFrame(view.all, view, view.angle, out);
  const side = view.angle + view.side * Math.PI / 2, back = view.angle + Math.PI;
  out.look.set(a.x, a.y, a.z);
  out.pos.set(
    a.x + Math.cos(side) * FLIER_DIST + Math.cos(back) * FLIER_DIST * FLIER_BACK, a.y + FLIER_UP,
    a.z + Math.sin(side) * FLIER_DIST + Math.sin(back) * FLIER_DIST * FLIER_BACK);
  out.fov = FLIER_FOV;
}

/** The ring-out shot: from inside the ring near where it flew out, up high, watching it fall toward the pit. */
function ringOutFrame(view: ShotView, subj: readonly ShotBody[], stage: ShotStage, out: ShotFrame): void {
  const a = view.a ?? subj[0];
  if (!a) return wideFrame(view.all, view, view.angle, out);
  const out0 = Math.atan2(a.z, a.x) + view.side * RINGOUT_SWING, r = stage.ringRadius - RINGOUT_IN;
  out.look.set(a.x, a.y, a.z);
  out.pos.set(Math.cos(out0) * r, RINGOUT_UP, Math.sin(out0) * r);
  out.fov = RINGOUT_FOV;
}

/** The crane: from a low shot at the shot's angle, rising over CRANE_S s into a high wide shot from the same side. */
function craneFrame(view: ShotView, subj: readonly ShotBody[], stage: ShotStage, posts: readonly Sphere[], out: ShotFrame): void {
  lowFrame(subj, view.angle, stage, out);
  keepClear(out.pos, subj, view.keepOut, posts, stage); // the low end is kept clear too, before it is blended
  _lowPos.copy(out.pos);
  _lowLook.copy(out.look);
  const lowFov = out.fov;
  wideFrame(view.all.length ? view.all : subj, view, view.angle, out);
  // the high end: the wide shot from the side the crane started on, a little higher
  out.pos.sub(out.look).multiplyScalar(1.1).add(out.look);
  const k = smooth01(view.t / CRANE_S);
  out.pos.lerpVectors(_lowPos, out.pos, k);
  out.look.lerpVectors(_lowLook, out.look, k);
  out.fov = lowFov + (out.fov - lowFov) * k;
}

const _v = new Vector3(), _c = new Vector3(), _lowPos = new Vector3(), _lowLook = new Vector3();
