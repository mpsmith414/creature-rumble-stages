import type { MatchPhase } from '../bring/protocol';
import { LEVEL_ORDER, LEVELS } from '../levels';
import type { LevelId } from '../stage/level';
import { h } from '../shared/dom';
import { FocusRing } from '../shared/focus';
import type { Button } from '../shared/input';
import type { Menu } from './menu-control';

/**
 * The TV menu (spec §2.8–2.11; stages design §7.2): big buttons for the sofa, a focus ring the remote's arrows move,
 * Enter presses, Back goes back. Crown and Again! show only when they can happen. Level picks where the fight is (it
 * moves there at once). Fighters lists the roster to send back in; Clear the stage asks first.
 */

export type MenuState = { phase: MatchPhase; fighting: number; joinShown: boolean; volume: number; muted: boolean; level: LevelId };
export type MenuItem = { id: string; label: string; selected?: boolean; disabled?: boolean; aria?: string };
export type MenuRow = { id: 'fight' | 'level' | 'fighters' | 'join' | 'volume' | 'clear' | 'resume'; title?: string; items: MenuItem[]; level?: number; off?: boolean };

export const CROWN_LABEL = '👑 Crown the champion!';
export const CLEAR_ASK = 'Clear the stage? Everyone goes back to the Fighters.';
export const CLEAR_LABEL = 'Clear the stage';
/** On the Fighters page, a creature already fighting (or dropping in, or on deck). */
export const FIGHTING_NOW = 'Fighting now';
/** The level row's title. */
export const LEVEL_TITLE = 'Level';
export const NO_FIGHTERS = 'No fighters yet. Make one on a phone!';

/** The menu's rows for a state (pure: the page is drawn from it). */
export function menuModel(s: MenuState): MenuRow[] {
  const level = Math.round(s.volume * 10);
  const fight: MenuItem[] = [];
  if (s.phase === 'open' && s.fighting > 0) fight.push({ id: 'crown', label: CROWN_LABEL });
  if (s.phase === 'crowned') fight.push({ id: 'again', label: 'Again!' });
  return [
    ...(fight.length ? [{ id: 'fight' as const, items: fight }] : []),
    { id: 'level', title: LEVEL_TITLE, items: LEVEL_ORDER.map((id) => ({ id, label: LEVELS[id as keyof typeof LEVELS].name, selected: id === s.level })) },
    { id: 'fighters', items: [{ id: 'fighters', label: 'Fighters' }] },
    { id: 'join', items: [{ id: 'join', label: 'Show join code', selected: s.joinShown }] },
    { id: 'volume', title: 'Sound', level, off: s.muted, items: [
      { id: 'down', label: '−', aria: 'Quieter', disabled: level <= 0 },
      { id: 'up', label: '+', aria: 'Louder', disabled: level >= 10 },
      { id: 'mute', label: s.muted ? 'Sound on' : 'Sound off', selected: s.muted },
    ] },
    { id: 'clear', items: [{ id: 'clear', label: CLEAR_LABEL }] },
    { id: 'resume', items: [{ id: 'resume', label: 'Back to the fight' }] },
  ];
}

/** One roster creature on the Fighters page. */
export type FighterRow = { id: string; name: string; maker: string; crowns: number; thumb: string | null; inFight: boolean };

export type MenuHandlers = {
  crown(): void;
  again(): void;
  /** Move the fight to this level. */
  level(id: LevelId): void;
  fighters(): Promise<FighterRow[]>;
  sendBack(id: string): void;
  /** Show or hide the join card. */
  join(): void;
  volume(delta: number): void;
  mute(): void;
  clear(): void;
};

export type RumbleMenu = Menu & { el: HTMLElement; update(s: MenuState): void };

/** Opens the menu in `root`. `close` shuts it (the buttons that act on the fight close it, so the TV shows what they did). */
export function openMenu(root: HTMLElement, state: MenuState, on: MenuHandlers, close: () => void): RumbleMenu {
  const main = h('section', { class: 'rm-panel', role: 'dialog', 'aria-label': 'Rumble menu' });
  const fighters = h('section', { class: 'rm-panel rm-fighters', role: 'dialog', 'aria-label': 'Fighters', hidden: true });
  const ask = h('section', { class: 'rm-panel rm-ask', role: 'dialog', 'aria-label': CLEAR_LABEL, hidden: true },
    h('p', { class: 'rm-empty' }, CLEAR_ASK),
    h('div', { class: 'rm-items' },
      h('button', { class: 'rm-btn', type: 'button', 'data-focus': true, 'data-key': 'clear:yes', onclick: () => { on.clear(); close(); } }, 'Yes, clear it'),
      h('button', { class: 'rm-btn', type: 'button', 'data-focus': true, 'data-key': 'clear:no', onclick: () => showPage(null) }, 'No')));
  const pages = { fighters, ask };
  let page: keyof typeof pages | null = null;
  const screen = h('div', { class: 'rm-menu' }, main, fighters, ask);
  root.append(screen);
  const ring = new FocusRing(() => (page ? pages[page] : main));
  screen.addEventListener('focusin', (e) => e.target instanceof HTMLElement && e.target.dataset.focus !== undefined && ring.focus(e.target));

  let current: MenuRow[] = [];
  const act = (row: MenuRow['id'], id: string) => {
    if (id === 'crown') { on.crown(); close(); }
    else if (id === 'again') { on.again(); close(); }
    else if (row === 'level') { on.level(id as LevelId); close(); }
    else if (id === 'fighters') showPage('fighters');
    else if (id === 'join') on.join();
    else if (row === 'volume') {
      if (id === 'mute') on.mute();
      else if (!current.find((r) => r.id === 'volume')?.items.find((i) => i.id === id)?.disabled) on.volume(id === 'up' ? 0.1 : -0.1);
    } else if (id === 'clear') showPage('ask');
    else if (id === 'resume') close();
  };

  const rowEl = (row: MenuRow) => {
    const buttons: HTMLElement[] = row.items.map((it) => h('button', {
      class: `rm-btn${it.selected ? ' on' : ''}${it.disabled ? ' dim' : ''}${row.id === 'fight' ? ' rm-big' : ''}`, type: 'button',
      'data-focus': true, 'data-key': `${row.id}:${it.id}`, 'aria-label': it.aria, 'aria-disabled': it.disabled ? 'true' : undefined,
      'aria-pressed': it.id === 'join' || it.id === 'mute' || row.id === 'level' ? String(!!it.selected) : undefined,
      onclick: () => act(row.id, it.id),
    }, it.label));
    if (row.level !== undefined) {
      const pips = h('span', { class: `rm-level${row.off ? ' off' : ''}`, role: 'img', 'aria-label': row.off ? 'Sound off' : `Volume ${row.level} of 10` },
        ...Array.from({ length: 10 }, (_, i) => h('i', { class: i < row.level! ? 'lit' : '', style: `height: ${1 + i * 0.22}em` })));
      buttons.splice(1, 0, pips);
    }
    return h('div', { class: `rm-row rm-row-${row.id}` }, row.title ? h('div', { class: 'rm-title' }, row.title) : null, h('div', { class: 'rm-items' }, ...buttons));
  };

  const draw = (s: MenuState) => {
    const was = main.querySelector<HTMLElement>('.focused')?.dataset.key;
    current = menuModel(s);
    main.replaceChildren(h('h2', { class: 'rm-heading' }, 'The Rumble'), ...current.map(rowEl));
    if (page) return;
    const keep = was && main.querySelector<HTMLElement>(`[data-key="${was}"]`);
    if (keep) ring.focus(keep);
    else if (was || !main.querySelector('.focused')) ring.reset();
  };

  /** The Fighters page: every roster creature with Send back in! (those already fighting say so). */
  let drawn = 0;
  const drawFighters = async () => {
    const mine = ++drawn;
    const back = h('button', { class: 'rm-btn rm-back', type: 'button', 'data-focus': true, 'data-key': 'back', onclick: () => showPage(null) }, 'Back');
    fighters.replaceChildren(h('h2', { class: 'rm-heading' }, 'Fighters'), h('p', { class: 'rm-empty' }, 'Loading…'), back);
    ring.focus(back);
    let rows: FighterRow[] = [];
    try {
      rows = await on.fighters();
    } catch (e) {
      console.warn('could not read the roster', e);
    }
    if (mine !== drawn || page !== 'fighters') return;
    const grid = h('ul', { class: 'rm-grid' }, ...rows.map((r) => h('li', { class: 'rm-fighter' },
      r.thumb ? h('img', { class: 'rm-thumb', src: r.thumb, alt: '' }) : h('span', { class: 'rm-thumb rm-nothumb', 'aria-hidden': 'true' }, '🥊'),
      h('b', { class: 'rm-name' }, r.name),
      h('small', { class: 'rm-maker' }, `by ${r.maker || 'a mystery maker'}${r.crowns ? `  👑×${r.crowns}` : ''}`),
      h('button', {
        class: `rm-btn${r.inFight ? ' dim' : ''}`, type: 'button', 'data-focus': true, 'data-key': `send:${r.id}`, 'aria-disabled': r.inFight ? 'true' : undefined,
        onclick: () => { if (!r.inFight) { on.sendBack(r.id); close(); } },
      }, r.inFight ? FIGHTING_NOW : 'Send back in!'))));
    fighters.replaceChildren(h('h2', { class: 'rm-heading' }, 'Fighters'), rows.length ? grid : h('p', { class: 'rm-empty' }, NO_FIGHTERS), back);
    ring.focus(fighters.querySelector<HTMLElement>('.rm-fighter [data-focus]:not(.dim)') ?? back);
  };

  const showPage = (next: keyof typeof pages | null) => {
    const was = page;
    page = next;
    fighters.hidden = next !== 'fighters';
    ask.hidden = next !== 'ask';
    main.hidden = next !== null;
    if (next === 'fighters') void drawFighters();
    else if (next === 'ask') ring.focus(ask.querySelector<HTMLElement>('[data-key="clear:no"]'));
    else ring.focus(main.querySelector<HTMLElement>(`[data-key="${was === 'fighters' ? 'fighters:fighters' : 'clear:clear'}"]`));
  };

  draw(state);
  ring.reset();
  return {
    el: screen,
    update: draw,
    press(b: Button, repeat = false) {
      if (b === 'up' || b === 'down' || b === 'left' || b === 'right') return ring.move(b);
      if (repeat) return;
      if (b === 'a') return ring.activate();
      if (b === 'b') return page ? showPage(null) : close();
    },
    close() {
      screen.classList.add('closing');
      setTimeout(() => screen.remove(), 250);
    },
  };
}

// ---------- the pad picker (stages design §10): a controller's Start picks a creature to steer ----------

export const PICK_TITLE = 'Pick your creature!';
export const PICK_NONE = 'No creatures yet. Make one on a phone!';
/** Under a creature already in the fight, and under one the pick sends in from the roster. */
export const PICK_IN = 'Fighting', PICK_SEND = 'Send in!';
/** The hint's words beside the coloured A and B buttons (for those who cannot read yet, the colours say it). */
export const PICK_PICK = 'pick', PICK_BACK = 'back';
/** Shown while the roster is read. */
const PICK_LOADING = 'Loading…';

/** One creature in a picker: in the fight now (`inPlay`), or in the roster (picking it sends it in). */
export type PickChoice = { id: string; name: string; thumb: string | null; inPlay: boolean };

/**
 * A picker's creatures (pure): those in play first (fighting, dropping in or waiting on deck; not one another pad
 * steers), with their roster picture when they have one, then the roster's others, which a pick sends in.
 */
export function pickerChoices(inPlay: readonly { id: string; name: string }[], roster: readonly { id: string; name: string; thumb: string | null }[],
  taken: (id: string) => boolean): PickChoice[] {
  const thumbs = new Map(roster.map((r) => [r.id, r.thumb]));
  const here = new Set(inPlay.map((c) => c.id));
  return [
    ...inPlay.filter((c) => !taken(c.id)).map((c) => ({ id: c.id, name: c.name, thumb: thumbs.get(c.id) ?? null, inPlay: true })),
    ...roster.filter((r) => !here.has(r.id) && !taken(r.id)).map((r) => ({ id: r.id, name: r.name, thumb: r.thumb, inPlay: false })),
  ];
}

/**
 * Every card gets its own creature's picture: one with no roster picture gets `picture(id)` (a picture of its body,
 * made once and kept by the caller). Only when there is no body, or the picture fails, does it keep none (the glove).
 */
export async function withPictures(choices: readonly PickChoice[], picture: (id: string) => Promise<string | null>): Promise<PickChoice[]> {
  return Promise.all(choices.map(async (c) => {
    if (c.thumb) return c;
    try {
      return { ...c, thumb: await picture(c.id) };
    } catch (e) {
      console.warn(`no picture of ${c.id} for the picker`, e);
      return c;
    }
  }));
}

/** Where the picker's focus goes on a press (pure): along the row, right or down to the next, stopping at the ends. */
export function pickerMove(at: number, count: number, b: Button): number {
  if (count <= 0) return 0;
  if (b === 'right' || b === 'down') return Math.min(count - 1, at + 1);
  if (b === 'left' || b === 'up') return Math.max(0, at - 1);
  return Math.min(count - 1, Math.max(0, at));
}

/** An open picker, driven by its own controller. `refresh` reads its creatures again (one was just taken by another pad). */
export type PadPicker = { el: HTMLElement; press(b: Button, repeat?: boolean): void; refresh(): void; close(): void };

/**
 * Opens a controller's picker in `root` (the pickers' strip along the bottom of the TV): a big row of creatures in the
 * pad's colour, each with its own picture, read from the sofa. The pad's stick or d-pad moves along it, A picks
 * (`pick`), B goes back (`back`); the hint shows the green A and red B. The cards are made once per reading: moving
 * only moves the highlight.
 */
export function openPicker(root: HTMLElement, o: {
  colour: string; player: number; choices(): Promise<PickChoice[]>; pick(c: PickChoice): void; back(): void;
}): PadPicker {
  const row = h('ul', { class: 'rm-pick-row' }, h('li', { class: 'rm-empty' }, PICK_LOADING));
  const glyph = (b: 'a' | 'b', word: string) =>
    h('span', { class: 'rm-pick-key' }, h('span', { class: `rm-glyph rm-glyph-${b}`, 'aria-label': `${b.toUpperCase()} button` }, b.toUpperCase()), word);
  const el = h('section', { class: 'rm-picker', role: 'dialog', 'aria-label': `Player ${o.player}: ${PICK_TITLE}`, style: `--pad: ${o.colour}` },
    h('h2', { class: 'rm-pick-title' }, h('span', { class: 'rm-pick-player' }, String(o.player)), PICK_TITLE),
    row,
    h('div', { class: 'rm-pick-hint' }, glyph('a', PICK_PICK), glyph('b', PICK_BACK)));
  root.append(el);
  let choices: PickChoice[] = [], cards: HTMLElement[] = [], at = 0, open = true, reading = 0;
  const focus = (next: number) => {
    cards[at]?.classList.remove('on');
    at = next;
    cards[at]?.classList.add('on');
    cards[at]?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  };
  const build = () => {
    cards = choices.map((c) => h('li', { class: `rm-pick${c.inPlay ? '' : ' rm-pick-send'}` },
      c.thumb ? h('img', { class: 'rm-thumb', src: c.thumb, alt: '' }) : h('span', { class: 'rm-thumb rm-nothumb', 'aria-hidden': 'true' }, '🥊'),
      h('b', { class: 'rm-name' }, c.name),
      h('small', { class: 'rm-pick-tag' }, c.inPlay ? PICK_IN : PICK_SEND)));
    row.replaceChildren(...(cards.length ? cards : [h('li', { class: 'rm-empty' }, PICK_NONE)]));
    focus(Math.min(at, Math.max(0, cards.length - 1)));
  };
  /** Reads the creatures (again), keeping the highlight on the same one when it is still there. */
  const read = () => {
    const mine = ++reading, was = choices[at]?.id;
    void o.choices().then((c) => {
      if (!open || mine !== reading) return;
      choices = c;
      const keep = choices.findIndex((x) => x.id === was);
      at = keep >= 0 ? keep : Math.min(at, Math.max(0, choices.length - 1));
      build();
    }, (e) => {
      console.warn('the picker could not read the creatures', e);
      if (open && mine === reading) build();
    });
  };
  read();
  return {
    el,
    press(b) {
      if (!open) return;
      if (b === 'a') {
        const c = choices[at];
        if (c) o.pick(c);
      } else if (b === 'b') o.back();
      else {
        const next = pickerMove(at, choices.length, b);
        if (next !== at) focus(next);
      }
    },
    refresh: read,
    close() {
      open = false;
      el.remove();
    },
  };
}
