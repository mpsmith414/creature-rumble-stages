// Dev only (`/?dev`, left out of the build): a panel over the real TV. Add a fixture fighter by kind (keys 1–7, with
// its drop-in), quick-fill 4 without drop-ins (F), crown (C), Again! (A), reset (X), fill the next fighter's special
// meter (S), the next level (L), a present now (P), the level's next mischief now (N); H hides the panel; the frame
// time (averaged over the last second) shows on it, for checking 8 fighters at the widest zoom on the TV. G makes the
// keyboard a controller (for controller play with no pad: Enter Start, Backspace Select, arrows, Space A, J X, K Y, H B,
// ; RB, Shift LB) until G again; the dev keys rest meanwhile.
// `&shot=entrance|fight|crown|special|menu|start` plays a short script and saves that moment as .shots/<name>.png (the
// dev server's /__shot): a lone drop-in under its parachute, a busy fight, the champion crowned on the top platform, a
// special's blow, the TV menu with its level picker, the start screen.
import type { BodyData } from '../builder/build';
import { fixtures } from '../dev/pose';
import { nextLevel } from '../levels';
import type { Recipe } from '../recipe/schema';
import type { MischiefName } from '../stage/mischief';
import type { RumbleApi } from './rumble';
import { CARRY_S, type Card } from './show';

const KINDS = ['fists', 'legs', 'tiny', 'blob', 'wings', 'tail', 'horns'] as const;
const LABEL: Record<(typeof KINDS)[number], string> = {
  fists: '👊 Big fists', legs: '🦵 Long legs', tiny: '🐭 Tiny', blob: '🫧 Blob', wings: '🪽 Wings', tail: '🌀 Tail', horns: '🦏 Horns',
};
const MAKERS = ['Sam', 'Zig', 'Captain Doodle', null, 'Zag', 'Waffles', 'Pickle'];
/**
 * `&shot=special` fills a meter again this often (s) until a special lands, gives up after this long (s), and saves the
 * frame this long (ms) after the blow.
 */
const SPECIAL_RETRY_S = 5, SPECIAL_GIVE_UP_S = 40, SPECIAL_SHOT_MS = 150;
/** `&shot=entrance` saves the frame once the newcomer has floated down to this far over its spot (m): in view, chute open. */
const ENTRANCE_SHOT_LIFT = 2.2;
/** `&shot=crown` saves this long (s) after the champion reached the top (the confetti raining). */
const CROWN_SHOT_S = 0.8;
/** The word a special's blow pops (`IMPACT_POP`). */
const BLOW = 'KA-BOOM!';

/**
 * Dev: the next fighter on the stage (after `last`, in order) gets a full special meter, so it lets its special go as
 * soon as it can. Returns who, or null when nobody is on the stage.
 */
export function fillSpecial<F extends { id: string; meter: number }>(fighters: readonly F[], last: string | null): F | null {
  if (!fighters.length) return null;
  const i = fighters.findIndex((f) => f.id === last);
  const f = fighters[(i + 1) % fighters.length];
  f.meter = 1;
  return f;
}

/** The frame-time readout: averaged over this long (ms), rewritten this often (ms). */
const METER_SPAN = 1000, METER_EVERY = 250;

/**
 * The frame-time readout (as `/?dev=stage` has): the owner checks 8 fighters at the widest zoom on the TV with it.
 * `frame(now)` once a frame drawn (ms); every quarter second it gives the average frame time over the last second (ms),
 * else null.
 */
export class FrameMeter {
  private readonly times: number[] = [];
  private due = -Infinity;

  frame(now: number): number | null {
    const t = this.times;
    t.push(now);
    while (t.length > 1 && now - t[0] > METER_SPAN) t.shift();
    if (now < this.due) return null;
    this.due = now + METER_EVERY;
    return t.length > 1 ? (t[t.length - 1] - t[0]) / (t.length - 1) : null;
  }
}

const CSS = `
.rm-dev { position: fixed; left: 12px; bottom: 12px; width: 310px; z-index: 40; background: #1a1030e6; color: #fff; padding: 12px;
  border-radius: 14px; font: 13px system-ui, sans-serif; }
.rm-dev[hidden] { display: none; }
.rm-dev h3 { margin: 0 0 6px; font: 16px 'Lilita One', system-ui; letter-spacing: 1px; }
.rm-dev button { margin: 2px; padding: 6px 9px; border: 0; border-radius: 8px; background: #ff4f8b; color: #fff; font: 13px system-ui; font-weight: 700; cursor: pointer; }
.rm-dev button.alt { background: #3ec7ff; color: #14304a; } .rm-dev button.gold { background: #ffc933; color: #3a2400; }
.rm-dev .row { margin: 6px 0; } .rm-dev .hint { opacity: 0.65; font-size: 11px; margin-top: 6px; }
.rm-dev .hud { font-weight: 700; margin-bottom: 4px; }
`;

export function devPanel(ui: HTMLElement, canvas: HTMLCanvasElement, rumble: RumbleApi, o: { shot: string | null; build(r: Recipe): Promise<BodyData> }): void {
  const recipes = fixtures().slice(0, KINDS.length);
  const bodies = new Map<number, Promise<BodyData>>();
  const body = (i: number) => {
    let b = bodies.get(i);
    if (!b) bodies.set(i, (b = o.build(recipes[i])));
    return b;
  };
  recipes.forEach((_, i) => void body(i).catch(() => bodies.delete(i))); // built ahead, so a key press enters at once
  let n = 0;
  const cardFor = async (i: number): Promise<Card> => ({
    id: `dev-${KINDS[i]}-${++n}`, recipe: structuredClone(recipes[i]), body: await body(i), maker: MAKERS[i], name: recipes[i].name,
  });
  const add = async (i: number) => rumble.enter(await cardFor(i));
  const quickFill = async () => {
    const picks = [...KINDS.keys()].sort(() => Math.random() - 0.5).slice(0, 4);
    rumble.quickFill(await Promise.all(picks.map(cardFor)));
  };
  let charged: string | null = null;
  const special = () => {
    const f = fillSpecial(rumble.sim.fighters(), charged);
    charged = f?.id ?? null;
    if (f) console.info(`dev: ${rumble.show.card(f.id)?.name ?? f.id} has a full special meter`);
  };
  const level = () => rumble.setLevel(nextLevel(rumble.level()));
  const present = () => void rumble.sim.items.drop(rumble.sim.t, rumble.sim.level);
  const mischief = () => {
    const sim = rumble.sim, all = sim.level.mischief.map((m) => m.name);
    if (!all.length || rumble.match.phase !== 'open') return;
    sim.mischief.start(all[(all.indexOf(sim.mischief.active as MischiefName) + 1) % all.length], sim.t);
  };
  const fail = (e: unknown) => console.error('dev panel:', e);

  // ---------- the panel ----------
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const panel = document.createElement('div');
  panel.className = 'rm-dev';
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text = '', cls = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    e.textContent = text;
    if (cls) e.className = cls;
    parent.append(e);
    return e;
  };
  const button = (parent: HTMLElement, text: string, fn: () => unknown, cls = '') => {
    const b = el('button', parent, text, cls);
    b.type = 'button';
    b.tabIndex = -1; // never keeps the focus: Enter is the TV menu's
    b.onclick = () => { b.blur(); void Promise.resolve(fn()).catch(fail); };
  };
  el('h3', panel, 'RUMBLE DEV');
  const hud = el('div', panel, '', 'hud');
  const readout = el('div', panel, '', 'hud');
  const meter = new FrameMeter();
  const kinds = el('div', panel, '', 'row');
  KINDS.forEach((k, i) => button(kinds, `${i + 1} ${LABEL[k]}`, () => add(i)));
  const acts = el('div', panel, '', 'row');
  button(acts, 'Quick-fill 4 (F)', quickFill, 'alt');
  button(acts, '👑 Crown (C)', () => rumble.crown(), 'gold');
  button(acts, 'Again! (A)', () => rumble.again(), 'gold');
  button(acts, 'Reset (X)', () => rumble.reset(), 'alt');
  button(acts, '⚡ Special (S)', special, 'gold');
  button(acts, 'Next level (L)', level, 'alt');
  button(acts, '🎁 Present (P)', present, 'alt');
  button(acts, 'Mischief (N)', mischief, 'alt');
  const keyPad = () => {
    rumble.input.keyPad = !rumble.input.keyPad;
    console.info(`dev: the keyboard is ${rumble.input.keyPad ? 'a controller (G again to stop)' : 'the keyboard again'}`);
  };
  button(acts, '🎮 Keyboard pad (G)', keyPad, 'alt');
  el('div', panel, 'Keys 1–7 add a fighter of that kind (it drops in). S fills the next fighter’s special meter. L next level, P a present, N mischief now. H hides this panel. Enter opens the TV menu. G: the keyboard is a controller (Enter Start, Backspace Select: the TV menu, Space A: pick or jump, arrows, J, K, H, ;, Shift) until G again.', 'hint');
  ui.append(panel);

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase(), num = Number(e.key);
    if (k === 'g' && !e.repeat) return keyPad();
    if (rumble.menuOpen() || rumble.input.keyPad) return;
    if (num >= 1 && num <= KINDS.length) void add(num - 1).catch(fail);
    else if (k === 'f') void quickFill().catch(fail);
    else if (k === 'c') rumble.crown();
    else if (k === 'a') rumble.again();
    else if (k === 'x') rumble.reset();
    else if (k === 's') special();
    else if (k === 'l') level();
    else if (k === 'p') present();
    else if (k === 'n') mischief();
    else if (k === 'h') panel.hidden = !panel.hidden;
  });
  rumble.onFrame(() => {
    const ms = meter.frame(performance.now());
    if (ms !== null) readout.textContent = `${ms.toFixed(1)} ms a frame (${Math.round(1000 / ms)} fps) · ${rumble.sim.fighters().length} on the stage · view ${rumble.view.view.height.toFixed(1)} m tall`;
    const m = rumble.match, sim = rumble.sim, ev = sim.mischief.active;
    const pads = rumble.seats.seats().map((s) => `P${s.pad + 1} ${s.mode === 'picking' ? 'picking' : rumble.show.card(s.id ?? '')?.name ?? s.id}`);
    hud.textContent = `${rumble.input.keyPad ? '🎮 KEYBOARD PAD · ' : ''}${pads.length ? `${pads.join(', ')} · ` : ''}${sim.level.name} · fighting ${m.fighting.length} · dropping in ${m.entering.length} · on deck ${m.onDeck.length}` +
      `${rumble.show.drop.active ? ' · FROZEN' : ''}${m.phase === 'crowned' ? ' · CROWNED' : ''}${ev ? ` · ${ev}` : ''}`;
  });
  Object.assign(window, { __rumble: rumble });

  if (o.shot) {
    panel.hidden = true;
    void script(o.shot, rumble, ui, canvas, { add, quickFill, special }).catch(fail);
  }
}

/** The shot scripts: set the moment up, then save the frame right after it is drawn. */
async function script(name: string, rumble: RumbleApi, ui: HTMLElement, canvas: HTMLCanvasElement,
  a: { add(i: number): Promise<void>; quickFill(): Promise<void>; special(): void }): Promise<void> {
  const wait = (s: number) => new Promise((go) => setTimeout(go, s * 1000));
  const at = (moment: () => boolean) => new Promise<void>((go) => {
    const stop = rumble.onFrame(() => {
      if (!moment()) return;
      stop();
      void saveShot(name, canvas.toDataURL('image/png'), ui, canvas).finally(go); // read in the same task as the render
    });
  });
  if (name === 'start') {
    await wait(2);
    return at(() => true);
  }
  if (name === 'entrance') {
    // a lone drop-in: four already fighting, the newcomer floating down under its parachute
    await a.quickFill();
    await wait(3);
    await a.add(KINDS.indexOf('horns'));
    return at(() => {
      const id = rumble.match.entering[0];
      const d = id ? rumble.show.drop.state(id) : null;
      return !!d && d.phase === 'fall' && d.lift < ENTRANCE_SHOT_LIFT;
    });
  }
  if (name === 'fight') {
    await a.quickFill();
    await wait(7);
    return at(() => rumble.match.fighting.length >= 2);
  }
  if (name === 'crown') {
    await a.quickFill();
    await wait(6);
    rumble.crown();
    await wait(CARRY_S + CROWN_SHOT_S);
    return at(() => true);
  }
  if (name === 'menu') {
    // the TV menu with its level picker, over a fight
    await a.quickFill();
    await wait(3);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu' }));
    await wait(0.6);
    return at(() => rumble.menuOpen());
  }
  if (name === 'special') {
    // saved a moment after a special's blow: its big word up
    let landedAt = -1;
    const stop = rumble.onFrame(() => {
      if (landedAt < 0 && [...document.querySelectorAll('.show-pop.go')].some((p) => p.textContent === BLOW)) landedAt = performance.now();
    });
    const shot = at(() => landedAt >= 0 && performance.now() - landedAt >= SPECIAL_SHOT_MS);
    await a.quickFill();
    await wait(3);
    for (let t = 0; landedAt < 0; t += SPECIAL_RETRY_S) {
      if (t >= SPECIAL_GIVE_UP_S) {
        console.warn('shot "special": no special landed');
        stop();
        return;
      }
      a.special();
      await wait(SPECIAL_RETRY_S);
    }
    stop();
    return shot;
  }
  console.warn(`unknown shot "${name}" (start, entrance, fight, crown, menu, special)`);
}

/** The frame with the page's words over it (banners, pops, the menu), posted to the dev server's /__shot. */
async function saveShot(name: string, frame: string, ui: HTMLElement, canvas: HTMLCanvasElement): Promise<void> {
  const { toCanvas } = await import('html-to-image');
  // the library waits on frames, which stall while the pane is hidden: stand in for them
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 0);
  let over: HTMLCanvasElement;
  try {
    over = await toCanvas(ui, { width: innerWidth, height: innerHeight, pixelRatio: canvas.width / Math.max(1, innerWidth), skipFonts: true });
  } finally { window.requestAnimationFrame = raf; }
  const img = new Image();
  await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = fail; img.src = frame; });
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const g = out.getContext('2d')!;
  g.drawImage(img, 0, 0);
  g.drawImage(over, 0, 0, out.width, out.height);
  await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: out.toDataURL('image/png') });
  console.info(`saved .shots/${name}.png`);
}
