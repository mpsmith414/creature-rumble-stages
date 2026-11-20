// Dev only (`/?dev=stage`): the side-view stage on the TV. Real creatures, posed by the anim clips, fight on the
// themed levels (L goes to the next one: jungle, space ship, toy room, the practice level) under the zooming side
// camera, with the level's scenery, its mischief (N starts the next one now), presents and power-ups (P drops a present
// now, I gives fighter 1 the next power-up) and the knockout effects. Fighter 1 is the AI's until you touch the keyboard
// or a controller, then yours until 10 s pass with no input; the rest think with the simple brain. 1–7 add a creature
// of that kind (up to 8), F fills four, R starts again. `&level=<id>` starts on that level, `&mischief=<name>` starts
// that mischief 3 s in, `&item=<name>` gives fighter 1 that power-up at once and drops a present 4 s in, and `&shot=1`
// saves a frame 6 s into the fight as .shots/stage-<level>[-<mischief>][-<item>].png (the dev server's /__shot).
// The show (Task 14): damage shows on each creature (keeping its colours: a red glow, sweat, steam, spinning eyes; G
// adds 50 damage to everyone, `&looks=1` starts the four at each step), slow motion and a close-up for a knockout launch
// or a landed special (at most one every 10 s), the announcer's lines on the banner (spoken once the voice is up and a
// key was pressed), comic pops and sounds, trails behind a launch, a lone creature's show-off and the vine-hanging pose.
import { Color, PerspectiveCamera, Scene } from 'three/webgpu';
import { Announcer } from '../announcer/announcer';
import { VoiceClient } from '../announcer/voice';
import { gatedVoice } from '../app/wiring';
import { createCrowd } from '../audio/crowd';
import { createMixer, lazyAudio } from '../audio/mixer';
import { createSfx } from '../audio/sfx';
import { PlayerSeat } from '../app/player-seat';
import { StageLoop } from '../app/stage-loop';
import { STAGE_FOV, StageShow } from '../app/stage-show';
import { BuilderClient } from '../builder/client';
import type { BodyData } from '../builder/build';
import { LEVEL_ORDER, LEVELS } from '../levels';
import { TEST_LEVEL } from '../levels/test';
import type { Recipe } from '../recipe/schema';
import { createRenderer } from '../render/renderer';
import { BUTTONS, firstPad, readPad, stickMoved, type PadState } from '../shared/input';
import { padIntent } from '../stage/pad-intent';
import { Banner } from '../show/banner';
import type { BubbleFighter } from '../show/edge-bubbles';
import { Moments } from '../show/moments';
import { Pops } from '../show/pops';
import { performCall, StageCalls, type Call } from '../show/stage-calls';
import { addStageLights } from '../show/stage-lights';
import { bodyStats, type BodyStats } from '../stage/body';
import type { StageFighter } from '../stage/fighter';
import { STAGE_TUNE } from '../stage/damage';
import { ITEM_NAMES, type ItemCue, type ItemName } from '../stage/items';
import type { Level } from '../stage/level';
import type { MischiefCue, MischiefName } from '../stage/mischief';
import { StageSim } from '../stage/sim';
import { NO_INTENT, type Intent, type V2 } from '../stage/types';
import { mulberry32 } from '../util/rng';

/** The kinds on keys 1–7, in the spec's order. */
const KINDS = ['fists', 'legs', 'tiny', 'blob', 'wings', 'tail', 'horns'] as const;
type Kind = (typeof KINDS)[number];
/** Who starts: you (fighter 1) and three others. */
const START: readonly Kind[] = ['fists', 'legs', 'blob', 'tail'];
/** The most creatures on the stage at once, and how many F fills up to. */
const MAX_FIGHTERS = 8, FILL = 4;
/** Your fighter's id. */
const YOU = 'p1';
/** A newcomer drops in from this high above its entry (m). */
const DROP_IN = 8;
/** Knocked out, you come back after this long (s). */
const COMEBACK = 2;
/** A frame longer than this (s) counts as this: after a stall the camera and the eyes do not leap. */
const MAX_FRAME = 0.1;
/** The frame-time readout: averaged over the last second, rewritten this often (s). */
const READOUT_EVERY = 0.25;
/** Stick share counted as a press of up or down on the d-pad or keys. */
const FULL = 1;
/** Your marker floats this far over your head (m). */
const MARKER_ABOVE = 0.35;
/** The levels L goes through, in order. */
const CYCLE: readonly Level[] = [...LEVEL_ORDER.map((id) => LEVELS[id as keyof typeof LEVELS]), TEST_LEVEL];
/** With `&mischief=`, it starts this long into the fight (s); the shot is taken this long in (s). */
const MISCHIEF_AT = 3, SHOT_AT = 6;
/** With `&item=`, a present drops this long into the fight (s): still floating down at the shot. */
const PRESENT_AT = 4;
/**
 * G adds this much damage to everyone (not D: that moves you right); `&looks=1` starts the four at these (fresh, warm,
 * hot, about to fly).
 */
const DAMAGE_KEY = 50;
const LOOKS: readonly number[] = [0, ...STAGE_TUNE.damageSteps];
/** The help line. */
const HELP = 'You are 1 (the AI plays it until you touch the keys or the pad; 10 s idle gives it back; you have kid power while you steer) · move ← → or A D (↑ ↓ / W S aim) · Space jump · J attack · K special · H grab · ; item · Shift dodge'
  + '  —  pad: stick, A jump, X attack, Y special, B grab, RB item, LB or RT dodge  —  1–7 add a creature · F fill to four · M fill every special meter · G +50 damage to all · P present now · I give 1 the next power-up · L next level · N mischief now · R reset';

/** The keys that steer fighter 1 (by their place on the keyboard): touching one hands it to you. */
const CONTROLS: ReadonlySet<string> = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space', 'KeyJ', 'KeyK', 'KeyH',
  'Semicolon', 'ShiftLeft', 'ShiftRight',
]);
/** The marker over fighter 1: yours, or the AI's. */
const MARK_YOU = '1', MARK_AI = '1 (AI)';

/** Each fixture recipe by its kind (file name). */
function recipes(): Record<Kind, Recipe> {
  const all = import.meta.glob<{ default: unknown }>('../fixtures/fighters/*.json', { eager: true });
  const out = {} as Record<Kind, Recipe>;
  for (const [path, m] of Object.entries(all)) {
    const name = path.replace(/^.*\/|\.json$/g, '') as Kind;
    if (KINDS.includes(name)) out[name] = structuredClone(m.default) as Recipe;
  }
  return out;
}

export async function showStage(canvas: HTMLCanvasElement, ui: HTMLElement,
  opts: { shot: boolean; level?: string | null; mischief?: string | null; item?: string | null; looks?: boolean }): Promise<void> {
  const { renderer } = await createRenderer(canvas, 'high');
  let level = CYCLE.find((l) => l.id === opts.level) ?? CYCLE[0];
  const scene = new Scene();
  scene.background = new Color('#62b6f0');
  const camera = new PerspectiveCamera(STAGE_FOV, 16 / 9, 0.5, 400);
  const fit = () => {
    let w = canvas.clientWidth, hh = canvas.clientHeight;
    if (!w || !hh) [w, hh] = [1280, 720];
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', fit);
  fit();

  // light: the stage's own (the show uses the same), a soft sky and one sun casting shadows onto the platforms
  addStageLights(scene);

  // the overlays: your marker, the help line and the frame-time readout (the edge bubbles are the show's)
  const marker = overlay(ui, 'stage-you', MARK_AI, {
    position: 'fixed', transform: 'translate(-50%, -100%)', font: '900 3.2vh Nunito, system-ui, sans-serif',
    color: '#fff', background: '#ff4f7b', borderRadius: '1.2vh', padding: '0.1vh 1.1vh', border: '0.35vh solid #fff', whiteSpace: 'nowrap',
    boxShadow: '0 0.4vh 0 rgba(0,0,0,0.25)', pointerEvents: 'none',
  });
  overlay(ui, 'stage-help', HELP, {
    position: 'fixed', left: '1.5vh', bottom: '1.5vh', right: '1.5vh', font: '700 1.7vh Nunito, system-ui, sans-serif',
    color: '#fff', background: 'rgba(20, 30, 60, 0.55)', borderRadius: '1vh', padding: '0.6vh 1.2vh', pointerEvents: 'none',
  });
  // the show: banner and announcer (words always; the voice once it is up and a key or click has let sound play), pops
  const audio = lazyAudio(), ctx = audio.ctx();
  const mixer = createMixer(ctx), sfx = createSfx(ctx, mixer.sfx), crowd = createCrowd(ctx, mixer.crowd);
  const live = () => ctx.state === 'running';
  for (const ev of ['keydown', 'pointerdown'] as const) addEventListener(ev, () => audio.unlock(), { capture: true });
  const banner = new Banner(ui), pops = new Pops(ui, Math.random, () => banner.band());
  const voice = new VoiceClient({ fetch: (...a) => fetch(...a), ctx, out: mixer.voice });
  void voice.check().then(() => console.info(`announcer voice: ${voice.available === 'yes' ? 'available' : 'resting (words only)'}`));
  const announcer = new Announcer({ voice: gatedVoice(voice, live), banner, mixer, sfx, crowd, rng: Math.random, now: () => performance.now() });
  // the picture of the fight: scenery, camera, bodies, looks (shared with the Rumble)
  const show = new StageShow({ scene, camera, ui, level, pops });
  const said: string[] = [];
  const readout = overlay(ui, 'stage-ms', '', {
    position: 'fixed', right: '1.5vh', top: '1.5vh', font: '800 1.8vh ui-monospace, monospace', color: '#fff',
    background: 'rgba(20, 30, 60, 0.55)', borderRadius: '1vh', padding: '0.4vh 1vh', pointerEvents: 'none', textAlign: 'right',
  });

  // the creatures: every kind built once (their bodies are shared by every copy)
  const byKind = recipes();
  const builder = new BuilderClient();
  const bodies = {} as Record<Kind, BodyData>, stats = {} as Record<Kind, BodyStats>;
  await Promise.all(KINDS.map(async (k) => {
    bodies[k] = await builder.build(byKind[k]);
    stats[k] = bodyStats(byKind[k]);
  }));

  // your controls: the keys held (by their place on the keyboard) and the first controller
  const held = new Set<string>();
  let pad: PadState = readPad(null);
  /** A steering key went down since the last frame (a tap shorter than a frame still counts as a touch). */
  let tapped = false;
  const seat = new PlayerSeat();
  const touched = () => {
    let any = tapped || stickMoved(pad) || BUTTONS.some((b) => pad[b]);
    for (const c of held) if (CONTROLS.has(c)) any = true;
    tapped = false;
    return any;
  };
  const you: Intent = { ...NO_INTENT }, fromPad: Intent = { ...NO_INTENT };
  /** The pad as it was at the last step (the controller's own mapping is the Rumble's: `padIntent`). */
  let padBefore: PadState = readPad(null);
  const key = (...codes: string[]) => codes.some((c) => held.has(c));
  const yourIntent = (): Intent => {
    padIntent(padBefore, pad, fromPad);
    padBefore = pad;
    const right = (key('ArrowRight', 'KeyD') ? FULL : 0) - (key('ArrowLeft', 'KeyA') ? FULL : 0);
    const up = (key('ArrowUp', 'KeyW') ? FULL : 0) - (key('ArrowDown', 'KeyS') ? FULL : 0);
    you.mx = clamp1(right + fromPad.mx);
    you.my = clamp1(up + fromPad.my);
    you.jump = key('Space') || fromPad.jump;
    you.attack = key('KeyJ') || fromPad.attack;
    you.special = key('KeyK') || fromPad.special;
    you.grab = key('KeyH') || fromPad.grab;
    you.item = key('Semicolon') || fromPad.item;
    you.dodge = key('ShiftLeft', 'ShiftRight') || fromPad.dodge;
    return you;
  };

  // ---- the fight ----
  let seed = 0, sim!: StageSim, loop!: StageLoop, next = 2, comeback = -1;
  let moments!: Moments, calls: StageCalls | undefined;
  /** Who is who: each creature's kind. */
  const kinds = new Map<string, Kind>();
  const nameOf = (id: string) => (id === YOU ? 'Player One' : byKind[kinds.get(id) ?? 'fists'].name);

  const draw = (f: StageFighter, kind: Kind) => {
    kinds.set(f.id, kind);
    show.add(f, { recipe: byKind[kind], body: bodies[kind], stats: stats[kind], name: f.id === YOU ? '1' : byKind[kind].name });
  };
  const unshow = (id: string) => {
    show.remove(id);
    kinds.delete(id);
    if (calls) perform(calls.forget(id)); // a warning still held for it is never said
  };
  let itemTurn = 0;
  /** Gives fighter 1 power-up `name` (default: the next one round). */
  const giveYou = (name?: ItemName) => {
    const f = sim.get(YOU);
    if (!f) return;
    f.giveItem(name ?? ITEM_NAMES[itemTurn++ % ITEM_NAMES.length], sim.t);
  };

  /** Adds a creature of `kind`: dropping in from above the entry furthest from everyone (or standing on `at`). */
  const add = (kind: Kind, id = `f${next++}`, at?: V2) => {
    if (sim.fighters().length >= MAX_FIGHTERS || sim.get(id)) return;
    const f = sim.add(id, stats[kind], at ?? dropSpot(sim));
    draw(f, kind);
  };

  const reset = () => {
    for (const id of [...kinds.keys()]) unshow(id);
    seed = (Math.random() * 2 ** 31) >>> 0; // dev page: a new fight each time (the seed is shown for a replay)
    const rng = mulberry32(seed);
    sim = new StageSim({ level, rng, items: true });
    loop = new StageLoop({ sim, rng });
    loop.kidPower = true; // you have kid power while you steer (as a child with a controller on the TV)
    moments = new Moments({ fighter: (id) => sim.get(id), level: () => sim.level, t: () => sim.t });
    calls = new StageCalls((id) => nameOf(id));
    next = 2;
    comeback = -1;
    START.forEach((k, i) => add(k, i === 0 ? YOU : undefined, level.entries[[0, 7, 2, 5][i]]));
    if (opts.looks) sim.fighters().forEach((f, i) => (f.damage = LOOKS[i % LOOKS.length]));
    loop.steer(YOU, seat.playing ? yourIntent : null);
  };
  reset();

  const fill = () => {
    while (sim.fighters().length < FILL) add(KINDS[Math.floor(Math.random() * KINDS.length)]);
  };

  addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent;
    held.add(e.code);
    if (CONTROLS.has(e.code)) tapped = true;
    if (/^(Arrow|Space$|ShiftLeft$|ShiftRight$|Semicolon$)/.test(e.code)) e.preventDefault();
    if (e.repeat) return;
    const digit = /^Digit([1-7])$/.exec(e.code);
    if (digit) add(KINDS[Number(digit[1]) - 1]);
    else if (e.code === 'KeyF') fill();
    else if (e.code === 'KeyM') for (const f of sim.fighters()) f.meter = 1;
    else if (e.code === 'KeyG') for (const f of sim.fighters()) f.damage += DAMAGE_KEY;
    else if (e.code === 'KeyR') reset();
    else if (e.code === 'KeyL') useLevel(CYCLE[(CYCLE.indexOf(level) + 1) % CYCLE.length]);
    else if (e.code === 'KeyN') nextMischief();
    else if (e.code === 'KeyP') sim.items.drop(sim.t, sim.level);
    else if (e.code === 'KeyI') giveYou();
  });
  addEventListener('keyup', (e) => held.delete((e as KeyboardEvent).code));
  addEventListener('blur', () => held.clear());

  const cues: MischiefCue[] = [];

  /** Moves to level `l`: its scenery, its camera bounds, a new fight on it. */
  const useLevel = (l: Level) => {
    level = l;
    show.useLevel(level);
    reset();
    void renderer.compileAsync(scene, camera);
  };
  /** Starts the level's next mischief now (after the one under way, or the first). */
  const nextMischief = (name?: MischiefName) => {
    const all = level.mischief.map((m) => m.name);
    if (!all.length) return;
    const pick = name && all.includes(name) ? name : all[(all.indexOf(sim.mischief.active as MischiefName) + 1) % all.length];
    sim.mischief.start(pick, sim.t);
  };
  let mischiefDue = !!opts.mischief;
  const asked = ITEM_NAMES.find((n) => n === opts.item);
  let itemDue = !!asked, presentDue = !!asked;
  const itemCues: ItemCue[] = [];
  const times: number[] = [];
  let last = -1, readoutIn = 0, fightTime = 0, shotTaken = !opts.shot, shootAs: string | null = null;
  const sinks = { announcer, sfx, said, pop: (at: V2, word: string, size: number) => show.pop(at, word, size) };
  /** Does what the show decided for a step: says, pops and plays. */
  const perform = (c: Call) => performCall(c, sinks);

  await renderer.compileAsync(scene, camera);
  /** One frame at time `now` (ms): the fight, the show and the drawing. */
  const tick = (now: number) => {
    const realDt = last < 0 ? 0 : Math.min(MAX_FRAME, (now - last) / 1000);
    last = now;
    pad = readPad(firstPad(navigator.getGamepads?.()));
    // who drives fighter 1: you once you touch the controls, the AI again after 10 s without
    const was = seat.playing;
    if (seat.update(touched(), realDt) !== was) {
      loop.steer(YOU, seat.playing ? yourIntent : null);
      marker.textContent = seat.playing ? MARK_YOU : MARK_AI;
    }

    // the fight: fixed steps, slowed for a big moment; the knocked out leave the stage (you come back)
    const clock = now / 1000;
    loop.timeScale = moments.timeScale(clock);
    cues.length = 0;
    itemCues.length = 0;
    for (const ev of loop.frame(realDt)) {
      cues.push(...ev.mischief);
      itemCues.push(...ev.items);
      const m = moments.moment(ev, clock);
      if (m) show.closeUp(m.at, m.height, m.seconds); // real seconds: the close-up lasts as long as the slow motion
      for (const c of calls!.calls(ev, sim.fighters())) perform(c);
      for (const id of ev.outs) {
        const gone = sim.get(id)?.mover.pos;
        if (gone) show.knockOut(gone);
        sim.remove(id);
        loop.forget(id);
        unshow(id);
        if (id === YOU) comeback = COMEBACK;
      }
    }
    if (comeback >= 0 && (comeback -= realDt) < 0) {
      add(START[0], YOU);
      comeback = sim.get(YOU) ? -1 : COMEBACK; // a full stage: try again in a moment
    }
    fightTime += realDt;
    if (mischiefDue && fightTime > MISCHIEF_AT) {
      mischiefDue = false;
      nextMischief(opts.mischief as MischiefName);
    }
    if (itemDue && sim.get(YOU)) {
      itemDue = false;
      giveYou(asked);
    }
    if (presentDue && fightTime > PRESENT_AT) {
      presentDue = false;
      sim.items.drop(sim.t, sim.level);
    }

    // draw: part way between the last two steps, so it is smooth at any frame rate
    show.draw(sim, loop, realDt, { mischief: cues, items: itemCues });
    placeMarker(marker, show.bubble(YOU), show.view);

    renderer.render(scene, camera);
    if (shootAs) {
      const name = shootAs;
      shootAs = null;
      void fetch(`/__shot?name=${name}`, { method: 'POST', body: canvas.toDataURL('image/png') }).then(() => console.info(`saved .shots/${name}.png`));
    }
    if (!shotTaken && fightTime > SHOT_AT) {
      shotTaken = true;
      const name = `stage-${level.id}${opts.mischief ? `-${opts.mischief}` : ''}${asked ? `-${asked}` : ''}`;
      void fetch(`/__shot?name=${name}`, { method: 'POST', body: canvas.toDataURL('image/png') }) // the same task as the render
        .then(() => console.info(`saved .shots/${name}.png`));
    }

    // the frame time, averaged over the last second
    times.push(now);
    while (times.length > 1 && now - times[0] > 1000) times.shift();
    if ((readoutIn -= realDt) <= 0) {
      readoutIn = READOUT_EVERY;
      const ms = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) : 0;
      readout.textContent = `${level.name} · ${ms.toFixed(1)} ms · ${sim.fighters().length} on · seed ${seed}`;
    }
  };
  renderer.setAnimationLoop(tick);
  Object.assign(window, {
    __stage: { scene, camera, renderer, show, get sim() { return sim; }, get loop() { return loop; }, get scenery() { return show.scenery; }, get koFx() { return show.koFx; }, useLevel, nextMischief, itemLooks: show.items, giveYou,
      get moments() { return moments; }, damageLook: show.damage, said, banner, stageCam: () => show.camera,
      /** Saves the next frame drawn as .shots/<name>.png. */
      shoot: (name: string) => void (shootAs = name.replace(/[^\w-]/g, '')),
      /** Runs `seconds` of 60 Hz frames at once (a hidden pane draws none of its own): for checks and screenshots. */
      advance: (seconds: number) => {
        let t = last < 0 ? performance.now() : last;
        for (let k = 0; k < Math.round(seconds * 60); k++) tick((t += 1000 / 60));
      } },
  });
}

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/** The level entry furthest from everyone in play, high above it (a newcomer drops in). */
function dropSpot(sim: StageSim): V2 {
  let best = sim.level.entries[0] ?? { x: 0, y: 0 }, bestD = -1;
  for (const e of sim.level.entries) {
    let d = Infinity;
    for (const f of sim.fighters()) d = Math.min(d, Math.abs(f.mover.pos.x - e.x));
    if (d > bestD) {
      bestD = d;
      best = e;
    }
  }
  return { x: best.x, y: best.y + DROP_IN };
}

/** A plain DOM box on the overlay. */
function overlay(ui: HTMLElement, cls: string, text: string, style: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  Object.assign(el.style, style);
  ui.append(el);
  return el;
}

/** Your marker over your head on the screen (hidden while you are off it: your bubble shows you then). */
function placeMarker(el: HTMLElement, b: BubbleFighter | undefined, v: { cx: number; cy: number; height: number; aspect: number }): void {
  if (!b) {
    el.hidden = true;
    return;
  }
  const sx = 0.5 + (b.x - v.cx) / (v.height * v.aspect), sy = 0.5 - (b.y + b.h + MARKER_ABOVE - v.cy) / v.height;
  el.hidden = !(sx >= 0 && sx <= 1 && sy >= 0.05 && sy <= 1);
  el.style.left = `${sx * 100}%`;
  el.style.top = `${sy * 100}%`;
}
