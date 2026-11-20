import { Color, Vector3 } from 'three/webgpu';
import { connectWorkshop, sendEnd, TRY_AGAIN, type Made } from '../bring/workshop';
import type { BodyData } from '../builder/build';
import { bodyCacheKey, loadBody } from '../builder/cache';
import { LEVEL_ORDER, LEVELS } from '../levels';
import { Match } from '../match/match';
import { createFighterObject } from '../render/fighter-object';
import { compileTogether } from '../render/compile';
import { renderView } from '../render/snapshot';
import type { View } from '../designer/types';
import type { Recipe } from '../recipe/schema';
import warmUpFighter from '../fixtures/fighters/fists.json';
import type { RosterItem } from '../roster/roster';
import { h } from '../shared/dom';
import { Input, type Button } from '../shared/input';
import { remember, stored } from '../shared/settings';
import { DROP_IN_S, GROUP_DROP_IN_S } from '../show/drop-in';
import { addStageLights } from '../show/stage-lights';
import { bodyStats } from '../stage/body';
import type { LevelId } from '../stage/level';
import type { Core } from './core';
import { menuControl } from './menu-control';
import { openMenu, openPicker, pickerChoices, withPictures, type FighterRow, type MenuState, type PadPicker, type PickChoice, type RumbleMenu } from './menu';
import { padColour, PadSeats, routePress, type SeatEvent } from './pad-seats';
import { CreaturePictures, DrawAhead } from './pictures';
import { RumbleShow, type Card } from './show';
import { STAGE_FOV, StageShow } from './stage-show';
import { handleCommand, joinKey, keepMade, kidPowerSwitch, MatchBroadcast, sendBack, startHint } from './wiring';

/** What the Rumble hands back (the dev panel and its shots drive it through this). */
export type RumbleApi = {
  show: RumbleShow; match: Match;
  /** The stage's picture (camera, scenery, looks). */
  view: StageShow;
  /** The fight on the level now (each new level or Again! makes a new one: read these again). */
  readonly loop: RumbleShow['loop'];
  readonly sim: RumbleShow['sim'];
  /** The level now, and the TV menu's pick. */
  level(): LevelId;
  setLevel(id: LevelId): void;
  /** Learn a creature and send it in (a drop-in follows). */
  enter(card: Card): void;
  /** Learn creatures and stand them on the stage at once (no drop-ins). */
  quickFill(cards: Card[]): void;
  crown(): boolean;
  again(): boolean;
  reset(): void;
  /** Is the TV menu open (the dev keys keep out of its way)? */
  menuOpen(): boolean;
  /** The controllers and the keyboard (dev checks stand in for pads through `padStubs`, or `keyPad`). */
  input: Input;
  /** Who steers which creature with a controller. */
  seats: PadSeats;
  /** Runs after every frame is drawn, in the same task (a page shot reads the canvas there). Returns the way to stop. */
  onFrame(fn: () => void): () => void;
};

/** Seconds of show clock; the frame is capped so a stalled tab does not leap. */
const MAX_FRAME = 0.05;
/** A failing frame is logged at most this often (s). */
const ERROR_LOG_S = 5;
/** Volume as the menu sets it (0 … 1) to the master gain (the mixer's own level). */
const MASTER = 0.9;
/** The stage camera's near and far planes (m). */
const NEAR = 0.5, FAR = 400;
/** The sky behind the scenery. */
const SKY = '#62b6f0';
/** The start screen's keys, and (a controller plugged in) how to play with it. */
const KEYS_HINT = 'Enter: menu · J: join code', PAD_HINT = ' · 🎮 A or Start: play · Select: menu';
/** A picker's picture of a creature with no roster picture: seen as on the phone's cards, this many pixels square. */
const PICTURE_VIEW: View = { angle: 'threeQuarter', facing: 'right' }, PICTURE_PX = 160;
/** The "coming soon" capsule sits by the top left of the view (shares of its width and height from the centre). */
const CAPSULE_AT = { x: -0.32, y: 0.3 };

/**
 * The Rumble on the TV (spec §2; stages design §9, §12): the level, the match, the fight on the stage, drop-ins, the
 * crowning and the TV menu, on the mode-neutral core. Phones send fighters in (release → roster → stage), crown
 * champions and call Again!; the menu does the same from the remote and picks the level. The start screen ("ADD A
 * CREATURE!" and the join card) shows while nobody is on the stage.
 */
export async function startRumble(core: Core): Promise<RumbleApi> {
  const { renderer, scene, camera, sfx, crowd, announcer, roster, bring, workshop, banner, pops, ui, capsule } = core;
  camera.fov = STAGE_FOV;
  camera.near = NEAR;
  camera.far = FAR;
  camera.updateProjectionMatrix();
  scene.background = new Color(SKY);
  addStageLights(scene);
  const match = new Match({ entrance: DROP_IN_S, group: GROUP_DROP_IN_S });
  const view = new StageShow({ scene, camera, ui, level: LEVELS[LEVEL_ORDER[0] as keyof typeof LEVELS], pops, renderer });
  // a crowning changes the roster (one more crown): the phones hear it once it is saved
  const showRoster = {
    fought: (ids: string[]) => roster.fought(ids),
    crowned: async (id: string) => {
      await roster.crowned(id);
      void broadcast.push();
    },
  };
  const show = new RumbleShow({ view, rng: Math.random, match, announcer, sfx, crowd, roster: showRoster, banner });
  // Kid power (the TV menu's switch, remembered across nights; on unless a grown-up turned it off)
  const kidPower = kidPowerSwitch({ stored, remember });
  show.kidPower = kidPower.on;

  // ---------- the phones: the fight on every phone, their commands, their creatures ----------
  const broadcast = new MatchBroadcast({
    state: () => ({ phase: match.phase, fighting: match.fighting.length }),
    roster: () => roster.summaries(),
    send: (phase, fighting, entries) => bring.sendMatch(phase, fighting, entries),
  });
  bring.onStatus((s, fresh) => {
    if (s === 'hosting' && fresh) void broadcast.push(false); // a new relay: the same fight and roster, sent again
  });
  const cardOf = (item: RosterItem, body: BodyData): Card => ({
    id: item.id, recipe: item.recipe, body, maker: item.maker.name || null, name: item.cards.name || item.recipe.name,
  });
  const sendBackIn = (id: string) => sendBack(id, {
    known: (i) => show.known(i), // already on the stage or on deck: no body is loaded or built
    get: (i) => roster.get(i),
    cached: (r) => loadBody(bodyCacheKey(r)),
    build: (r) => core.build(r),
    arrive(item, body) {
      if (show.known(item.id)) return; // already on the stage or on deck
      show.register(cardOf(item, body));
      show.arrive([item.id]);
    },
  });
  bring.onCommand((_token, cmd) => handleCommand(cmd, {
    phase: () => match.phase, fighting: () => match.fighting.length,
    crown: () => show.crown(), again: () => show.again(), sendBack: sendBackIn,
  }));

  type Outcome = 'released' | 'kept' | 'failed';
  /** Tell the phone how its turn ended (`failed` with Try again when nothing could be kept); once more if it did not go. */
  const tell = (token: string, o: Outcome) =>
    sendEnd((t, m) => bring.send(t, m), token, o === 'failed' ? { type: 'failed', message: TRY_AGAIN, retry: true } : { type: o });
  connectWorkshop(bring, workshop, {
    /** "Send to the fight!": kept in the roster, its intro fetched now, then onto the stage (a drop-in, or on deck). */
    async onRelease(made: Made) {
      let outcome: Outcome = 'failed';
      try {
        await keepMade(made, {
          check: (m) => void RumbleShow.check(m.recipe, m.body), // a creature that cannot fight is never kept broken
          add: (m) => roster.add(m, Date.now()),
          enter(item) {
            show.register(cardOf(item, made.body));
            show.arrive([item.id]);
          },
        });
        outcome = 'released';
        void broadcast.push();
      } catch (e) {
        console.error('release: the creature could not be kept', e);
        banner.show(TRY_AGAIN, '', 3);
      }
      await tell(made.token, outcome);
    },
    /** "Save for later" (or a turn closed some other way): into the roster only. */
    async onKept(made: Made) {
      let outcome: Outcome = 'kept';
      try {
        await keepMade(made, { check: (m) => void RumbleShow.check(m.recipe, m.body), add: (m) => roster.add(m, Date.now()) });
        void broadcast.push();
      } catch (e) {
        console.error('workshop: the creature could not be kept', e);
        outcome = 'failed';
      }
      await tell(made.token, outcome);
    },
  });

  // ---------- the TV menu (Enter or Menu opens it, Back or Esc closes it) ----------
  const vol = { volume: stored('rumble.volume', 0.8), muted: stored('rumble.muted', false) };
  const applyVolume = () => {
    core.mixer.master.gain.value = vol.muted ? 0 : MASTER * Math.min(1, Math.max(0, vol.volume));
  };
  applyVolume();
  const menuState = (): MenuState => ({
    phase: match.phase, fighting: match.fighting.length, joinShown: bring.cardShown, kidPower: kidPower.on, level: show.levelId, ...vol,
  });
  const fighters = async (): Promise<FighterRow[]> =>
    (await roster.summaries()).map((s) => ({ ...s, inFight: show.known(s.id) }));
  const control = menuControl({
    ui,
    waiting: () => false,
    open: (root, close) => openMenu(root, menuState(), {
      crown: () => void show.crown(),
      again: () => void show.again(),
      level: (id) => {
        show.setLevel(id);
        refreshMenu();
      },
      fighters,
      sendBack: (id) => void sendBackIn(id).catch((e) => console.warn('send back failed', e)),
      join: () => {
        bring.toggle();
        refreshMenu();
      },
      kidPower: () => {
        show.kidPower = kidPower.toggle();
        refreshMenu();
      },
      volume: (d) => {
        vol.volume = Math.round(Math.min(1, Math.max(0, vol.volume + d)) * 10) / 10;
        vol.muted = false;
        remember('rumble.volume', vol.volume);
        remember('rumble.muted', false);
        applyVolume();
        refreshMenu();
      },
      mute: () => {
        vol.muted = !vol.muted;
        remember('rumble.muted', vol.muted);
        applyVolume();
        refreshMenu();
      },
      clear: () => show.reset(),
    }, close),
  });
  let menuKey = '';
  const keyOf = (s: MenuState) => `${s.phase}|${s.fighting > 0}|${s.level}`;
  const refreshMenu = () => {
    const m = control.open as RumbleMenu | null;
    const s = menuState();
    menuKey = keyOf(s);
    m?.update(s);
  };
  // ---------- controller play (stages design §10) ----------
  // On a controller nobody is playing with: A or Start opens its picker (choose a creature to steer), Select opens the
  // TV menu (while the menu is up, the free controllers drive it and Start or Select shuts it); the remote and Enter open
  // the menu too. A free controller's A never reaches the menu, so a child pressing A to jump can never crown the
  // champion or call Again!. A controller playing: every button is its creature's; Start + Select gives the creature
  // back to the AI. Its creature going out frees it (A, after a second, or Start picks again: `routePress`, PadSeats).
  const seats = new PadSeats((id) => show.known(id));
  const pickers = new Map<number, PadPicker>();
  const pickerRoot = h('div', { class: 'rm-pickers' });
  ui.append(pickerRoot);
  /** The creatures in play (fighting, dropping in, on deck), with the names they are called. */
  const inPlay = () => [...match.fighting, ...match.entering, ...match.onDeck].map((id) => ({ id, name: show.card(id)?.name ?? id }));
  const shut = (pad: number) => {
    pickers.get(pad)?.close();
    pickers.delete(pad);
  };
  // every card shows its own creature: the roster's picture, else one of its body (drawn once with the TV's renderer,
  // which `renderView` puts back on the stage before the frame is shown)
  const pictures = new CreaturePictures(async (id) => {
    let body = show.card(id)?.body, recipe = show.card(id)?.recipe;
    if (!body) {
      const item = await roster.get(id);
      recipe = item?.recipe;
      body = item ? (await loadBody(bodyCacheKey(item.recipe))) ?? undefined : undefined;
    }
    if (!body || !recipe) return null;
    const img = await renderView({ renderer, scene, camera }, body, recipe, PICTURE_VIEW, PICTURE_PX);
    return `data:${img.mediaType};base64,${img.base64}`;
  });
  /** With a controller plugged in: a creature fighting with no roster picture gets one drawn, so a picker opens at once. */
  const ahead = new DrawAhead(pictures, () => roster.summaries());
  /** Pad `pad`'s arrow over creature `id` (dimmed and sleepy while the pad rests). */
  const markFor = (pad: number, id: string, resting = false) => view.mark(id, padColour(pad), String(pad + 1), resting);
  /** Creature `id` back to the AI, its arrow gone. */
  const letGo = (id: string) => {
    show.steer(id, null);
    view.mark(id, null);
  };
  /**
   * Pad `pad` picked `c`: it steers it. One not in play now (from the roster, or one that went out while the picker was
   * open, which is back in the roster) is sent in and held for the pad while it comes. Taken by another pad meanwhile:
   * the picker stays open and reads its creatures again.
   */
  const choose = (pad: number, c: PickChoice) => {
    const sending = !show.known(c.id);
    if (!seats.claim(pad, c.id, sending)) return pickers.get(pad)?.refresh();
    shut(pad);
    show.steer(c.id, seats.source(pad));
    markFor(pad, c.id);
    if (sending) {
      sendBackIn(c.id).catch((e) => {
        console.warn('could not send the picked creature in', e);
        if (seats.playing(pad) !== c.id) return;
        seats.release(pad);
        letGo(c.id);
      });
    }
  };
  const onSeat = (e: SeatEvent) => {
    if (e.type === 'pick') {
      shut(e.pad);
      pickers.set(e.pad, openPicker(pickerRoot, {
        colour: padColour(e.pad), player: e.pad + 1,
        choices: async () => withPictures(pickerChoices(inPlay(), await roster.summaries(), (id) => seats.steering(id) !== undefined), (id) => pictures.get(id)),
        pick: (c) => choose(e.pad, c),
        back: () => {
          seats.cancel(e.pad);
          shut(e.pad);
        },
      }));
    } else if (e.type === 'cancel') shut(e.pad);
    else if (e.type === 'rest' || e.type === 'wake') markFor(e.pad, e.id, e.type === 'rest'); // the AI drives while it rests
    else letGo(e.id);
  };

  const input = new Input();
  const routes = { seats, menu: control, picker: (pad: number, b: Button, repeat: boolean) => pickers.get(pad)?.press(b, repeat) };
  input.onPress = (b, repeat = false, pad) => routePress(b, repeat, pad, routes);
  window.addEventListener('keydown', (e) => {
    if (input.keyPad) return; // dev: the keyboard is a controller now
    // J shows or hides the join card (remembered, as the menu's "Show join code")
    if (joinKey(e, !!control.open || workshop.busy, () => bring.toggle())) return refreshMenu();
    if (e.repeat) return;
    if (e.key === 'ContextMenu') { // the remote's Menu key
      e.preventDefault();
      if (control.open) control.close();
      else control.show();
    } else if ((e.key === 'GoBack' || e.key === 'BrowserBack') && control.open) { // the remote's Back key
      e.preventDefault();
      control.press('b');
    }
  });

  // ---------- the start screen: "ADD A CREATURE!" (the join card shows beside it) ----------
  const soundHint = h('div', { class: 'rm-start-hint rm-start-sound' }, '🔊 Press any button for sound');
  // how to join: scan the card, or (the card hidden) how to show it
  const joinHint = h('div', { class: 'rm-start-hint' }, startHint(bring.cardShown));
  // the keys, and once a controller is plugged in, how to play with it
  const keysHint = h('div', { class: 'rm-start-keys' }, KEYS_HINT);
  const start = h('div', { class: 'rm-start', role: 'status' },
    h('div', { class: 'rm-start-title' }, 'ADD A CREATURE!'),
    joinHint,
    soundHint,
    keysHint);
  ui.append(start);

  // ---------- the frame ----------
  const hooks = new Set<() => void>();
  const capsuleAt = new Vector3();
  let clock = 0, last = performance.now(), loggedAt = -Infinity;
  await renderer.compileAsync(scene, camera);
  void warmFighterShaders(core);
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min(MAX_FRAME, Math.max(0, (now - last) / 1000));
    last = now;
    clock += dt;
    const menuWasOpen = !!control.open;
    input.poll(dt, (pad) => !!control.open || seats.picking(pad));
    // (a press that shut the menu this frame, or opened it, never opens a picker as well)
    for (const e of seats.update(input.pads(), dt, !menuWasOpen && !control.open && !workshop.busy)) onSeat(e);
    ahead.tick(dt, match.fighting, input.pads().some(Boolean));
    try {
      show.frame(dt, clock);
    } catch (e) {
      // the night goes on: the next frame tries again; the error is logged at most every 5 s
      if (clock - loggedAt >= ERROR_LOG_S) {
        loggedAt = clock;
        console.error('the fight failed this frame', e);
      }
    }
    broadcast.watch();
    if (control.open && keyOf(menuState()) !== menuKey) refreshMenu();
    const v = view.view;
    capsule.update(camera, capsuleAt.set(v.cx + CAPSULE_AT.x * v.height * v.aspect, v.cy + CAPSULE_AT.y * v.height, 0));
    start.hidden = !(match.phase === 'open' && !match.fighting.length && !match.entering.length && !match.onDeck.length && !workshop.busy);
    soundHint.hidden = core.audio.live();
    const hint = startHint(bring.cardShown);
    if (!start.hidden && joinHint.textContent !== hint) joinHint.textContent = hint;
    const keys = input.pads().some(Boolean) ? `${KEYS_HINT}${PAD_HINT}` : KEYS_HINT;
    if (!start.hidden && keysHint.textContent !== keys) keysHint.textContent = keys;
    renderer.render(scene, camera);
    for (const fn of hooks) fn();
  });

  return {
    show, match, view,
    get loop() { return show.loop; },
    get sim() { return show.sim; },
    level: () => show.levelId,
    setLevel: (id) => show.setLevel(id),
    enter(card) {
      show.register(card);
      show.arrive([card.id]);
    },
    quickFill(cards) {
      for (const c of cards) show.register(c);
      show.quickFill(cards.map((c) => c.id));
    },
    crown: () => show.crown(),
    again: () => show.again(),
    reset: () => show.reset(),
    menuOpen: () => !!control.open,
    input, seats,
    onFrame(fn) {
      hooks.add(fn);
      return () => void hooks.delete(fn);
    },
  };
}

/**
 * Compiles a fighter's shaders once at start-up (one fixture's body, laid out, compiled detached but lit by the scene,
 * then thrown away), so the first creature to drop in does not stall while the GPU compiles. In the background: nothing
 * waits for it, and a failure only means the first drop-in may hitch.
 */
async function warmFighterShaders(core: Core): Promise<void> {
  try {
    const recipe = structuredClone(warmUpFighter) as Recipe;
    const body = await core.build(recipe);
    const obj = createFighterObject(body, recipe, bodyStats(recipe, body.skeleton).layout);
    try {
      await compileTogether(core.renderer, obj.root, core.camera, core.scene);
    } finally {
      obj.dispose();
    }
  } catch (e) {
    console.warn('could not warm the fighter shaders', e);
  }
}
