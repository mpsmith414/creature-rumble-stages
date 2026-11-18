/** Controllers first (several at once), keyboard and mouse too: one stream of orbit/zoom/button events. */

export const BUTTONS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'start', 'select', 'up', 'down', 'left', 'right'] as const;
export type Button = (typeof BUTTONS)[number];
export type PadState = { lx: number; ly: number; rx: number; ry: number } & Record<Button, boolean>;

/**
 * A stick nearer the middle than this is at rest for the menus, the camera and noticing a touch (a resting stick drifts
 * a little). The fighters' own dead zone is `PAD_DEAD_ZONE` (src/stage/pad-intent.ts), taken from the same raw value.
 */
export const STICK_REST = 0.15;
/** An axis with the rest zone taken out, rescaled so just past it is just over 0 (menus and the camera). */
const dz = (v: number) => (Math.abs(v) < STICK_REST ? 0 : (v - Math.sign(v) * STICK_REST) / (1 - STICK_REST));
/** A raw axis as the browser gives it, held to −1 … 1 (a broken one is at rest). */
const axis = (v: number | undefined) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v!)) : 0);

export const EMPTY_PAD: PadState = { lx: 0, ly: 0, rx: 0, ry: 0, ...(Object.fromEntries(BUTTONS.map((b) => [b, false])) as Record<Button, boolean>) };

/**
 * Read a standard-mapping gamepad (Xbox / PlayStation layout) into a tidy state. The sticks are as the browser gives
 * them (held to −1 … 1): each use takes out its own dead zone (`stickMoved`, the menus' and camera's `STICK_REST`, the
 * fighters' `PAD_DEAD_ZONE`), so none is stacked on another.
 */
export function readPad(gp: GamepadLike | null): PadState {
  if (!gp) return { ...EMPTY_PAD };
  const b = (i: number) => !!gp.buttons[i]?.pressed;
  return {
    lx: axis(gp.axes[0]), ly: axis(gp.axes[1]), rx: axis(gp.axes[2]), ry: axis(gp.axes[3]),
    a: b(0), b: b(1), x: b(2), y: b(3), lb: b(4), rb: b(5), lt: b(6), rt: b(7),
    select: b(8), start: b(9), up: b(12), down: b(13), left: b(14), right: b(15),
  };
}

/**
 * The first connected controller in the browser's list (not simply index 0: a controller plugged in again may come
 * back at index 1 with a gap before it), or null.
 */
export function firstPad<T>(pads: readonly (T | null)[] | null | undefined): T | null {
  if (!pads) return null;
  for (const p of pads) if (p) return p;
  return null;
}

/** A gamepad as the browser gives it (what `readPad` reads). */
export type GamepadLike = { axes: readonly number[]; buttons: readonly { pressed: boolean }[]; connected?: boolean };

/**
 * Every controller in the browser's list, each at its own index (null where none is plugged in, or where the browser
 * keeps an unplugged one marked not connected).
 */
export function readPads(list: readonly (GamepadLike | null)[] | null | undefined): (PadState | null)[] {
  if (!list) return [];
  return Array.from(list, (gp) => (gp && gp.connected !== false ? readPad(gp) : null));
}

/** Whether either stick of `pad` is pushed past `STICK_REST` (a touch, not drift). */
export function stickMoved(pad: PadState): boolean {
  return Math.abs(pad.lx) > STICK_REST || Math.abs(pad.ly) > STICK_REST || Math.abs(pad.rx) > STICK_REST || Math.abs(pad.ry) > STICK_REST;
}

/** Buttons that went down between two states. */
export function edges(prev: PadState, next: PadState): Button[] {
  return BUTTONS.filter((k) => next[k] && !prev[k]);
}

const KEYS: Record<string, Button> = {
  Enter: 'a', ' ': 'a', Escape: 'b', Backspace: 'b', x: 'x', X: 'x', y: 'y', Y: 'y', '[': 'lb', ']': 'rb', n: 'start', N: 'start',
  '`': 'select', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

/** The keyboard as a controller (dev, `keyPad`): its index, after the browser's four. */
export const KEY_PAD = 4;
/**
 * The keyboard controller's buttons, by key (lower case): arrows the d-pad, Space A, J X, K Y, H B, ; RB, Shift LB,
 * Enter Start, Backspace Select.
 */
const KEY_PAD_KEYS: Partial<Record<Button, string>> = {
  up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', a: ' ', x: 'j', y: 'k', b: 'h', rb: ';', lb: 'shift',
  start: 'enter', select: 'backspace',
};
/** A held stick repeats as the d-pad in a menu this often (ms), once it is pushed past this share of full tilt. */
const REPEAT_MS = 220, REPEAT_TILT = 0.6;

/**
 * Polls every gamepad each frame and listens to the keyboard. Emits presses (repeating d-pad/stick moves for menus),
 * each with the index of the pad it came from (none for the keyboard), and continuous orbit/zoom.
 */
export class Input {
  /** Each pad's state at the last poll, by index (null: none there). */
  private states: (PadState | null)[] = [];
  private keys = new Set<string>();
  private last: PadState = { ...EMPTY_PAD };
  private mx = 0;
  private my = 0;
  /** When each pad's held stick may repeat next (ms). */
  private repeatAt: number[] = [];
  /** `repeat` is true for a held key's auto-repeat (keyboard only); `pad` is the controller's index (undefined: the keyboard). */
  onPress: (b: Button, repeat?: boolean, pad?: number) => void = () => {};
  /** Set by dev checks and tests to stand in for the controllers (by index; null: none there). */
  padStubs: (PadState | null)[] | null = null;
  /**
   * Dev: the keyboard plays as one more controller (at `KEY_PAD`, see `KEY_PAD_KEYS`) for checking controller play with
   * no pad; while it does, its keys press no menu buttons.
   */
  keyPad = false;
  /** Which the player used last: the controller (a button or a stick) or the keyboard (a key), for hints that name a button. */
  using: 'pad' | 'keys' = 'keys';

  constructor(target: EventTarget = window) {
    target.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent;
      const typing = typeof HTMLElement !== 'undefined' && (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement);
      if (typing && e.key !== 'Escape') return;
      this.keys.add(e.key.toLowerCase());
      this.using = 'keys';
      const b = KEYS[e.key];
      if (b && this.keyPad) e.preventDefault(); // a controller's button now: it reaches the game through `pads()`
      else if (b) {
        e.preventDefault();
        this.onPress(b, e.repeat);
      }
    });
    target.addEventListener('keyup', (e) => this.keys.delete((e as KeyboardEvent).key.toLowerCase()));
    target.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('mousemove', (ev) => {
      if (typeof document === 'undefined' || !document.pointerLockElement) return;
      const e = ev as MouseEvent;
      this.mx += e.movementX;
      this.my += e.movementY;
    });
  }

  /** The first connected gamepad's state from the last poll (all at rest with none). */
  pad(): PadState {
    return this.last;
  }

  /** Every controller's state from the last poll, by index (null where none is plugged in; the dev keyboard pad at `KEY_PAD`). */
  pads(): readonly (PadState | null)[] {
    return this.states;
  }

  /** Is this key down right now (case-insensitive)? */
  held(key: string): boolean {
    return this.keys.has(key.toLowerCase());
  }

  /** Mouse movement since the last call; only counts while the pointer is locked. */
  mouse(): { dx: number; dy: number } {
    const m = { dx: this.mx, dy: this.my };
    this.mx = this.my = 0;
    return m;
  }

  /**
   * Call once per frame; returns how far to orbit (radians) and zoom (factor change) this frame. `menu` says which pads
   * are in a menu (or a picker), where a held stick repeats as the d-pad: true for all, or per pad index.
   */
  poll(dt: number, menu: boolean | ((pad: number) => boolean)): { orbitX: number; orbitY: number; zoom: number } {
    const pads = this.padStubs ? [...this.padStubs] : readPads(typeof navigator === 'undefined' ? null : navigator.getGamepads?.());
    if (this.keyPad) pads[KEY_PAD] = this.keyPadState();
    const inMenu = typeof menu === 'function' ? menu : () => menu;
    const now = performance.now();
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad) continue;
      const pressed = edges(this.states[i] ?? EMPTY_PAD, pad);
      if (i !== KEY_PAD && (pressed.length || stickMoved(pad))) this.using = 'pad';
      for (const b of pressed) this.onPress(b, false, i);
      // a held stick in a menu repeats like a d-pad
      if (inMenu(i) && (Math.abs(pad.lx) > REPEAT_TILT || Math.abs(pad.ly) > REPEAT_TILT) && now > (this.repeatAt[i] ?? 0)) {
        this.repeatAt[i] = now + REPEAT_MS;
        this.onPress(Math.abs(pad.lx) > Math.abs(pad.ly) ? (pad.lx > 0 ? 'right' : 'left') : pad.ly > 0 ? 'down' : 'up', false, i);
      }
    }
    this.states = pads;
    const first = pads.findIndex((p) => !!p);
    const pad = first >= 0 ? pads[first]! : EMPTY_PAD;
    this.last = pad;
    const k = (key: string) => (this.keys.has(key) ? 1 : 0);
    const menuOpen = first >= 0 && inMenu(first);
    const stickX = menuOpen ? 0 : dz(pad.lx), stickY = menuOpen ? 0 : dz(pad.ly);
    return {
      orbitX: (stickX + k('d') - k('a')) * 1.8 * dt,
      orbitY: (stickY + k('s') - k('w')) * 1.2 * dt,
      zoom: (dz(pad.ry) + k('e') - k('q')) * 1.5 * dt,
    };
  }

  /** The keyboard as a controller: its buttons from the keys held. */
  private keyPadState(): PadState {
    const s = { ...EMPTY_PAD };
    for (const [b, key] of Object.entries(KEY_PAD_KEYS) as [Button, string][]) s[b] = this.keys.has(key);
    return s;
  }
}
