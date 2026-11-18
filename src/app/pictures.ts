/** At most this many creatures' pictures are kept (each is a small data URL); the oldest go first. */
export const PICTURES_KEPT = 64;

/**
 * Pictures of creatures' bodies for the controllers' pickers (a creature with no roster picture: one in play, a dev
 * fixture). Each is drawn once, one at a time (they share the TV's renderer), and kept. No picture (no body yet) or a
 * failed one is not kept, so it is tried again next time. Pure apart from `draw`.
 */
export class CreaturePictures {
  private readonly kept = new Map<string, Promise<string | null>>();
  /** The drawing under way (pictures are drawn one after another). */
  private queue: Promise<unknown> = Promise.resolve();
  private drawing = 0;

  constructor(private readonly draw: (id: string) => Promise<string | null>, private readonly max = PICTURES_KEPT) {}

  /** Creature `id`'s picture (a data URL), drawn now if it has none yet; null when it has no body to draw. */
  get(id: string): Promise<string | null> {
    const had = this.kept.get(id);
    if (had) return had;
    this.drawing++;
    const p = this.queue.then(() => this.draw(id)).finally(() => this.drawing--);
    this.queue = p.catch(() => {});
    this.kept.set(id, p);
    p.then((url) => {
      if (!url) this.forget(id, p);
    }, () => this.forget(id, p));
    while (this.kept.size > this.max) this.kept.delete(this.kept.keys().next().value!);
    return p;
  }

  /** Whether `id` has a picture drawn or on its way. */
  has(id: string): boolean {
    return this.kept.has(id);
  }

  /** Whether nothing is being drawn just now (a picture may be drawn ahead without holding anything up). */
  get idle(): boolean {
    return this.drawing === 0;
  }

  private forget(id: string, p: Promise<string | null>): void {
    if (this.kept.get(id) === p) this.kept.delete(id);
  }
}

/** With a controller plugged in, a creature in play gets its picker picture drawn ahead, at most this often (s). */
export const PICTURE_AHEAD_S = 0.5;

/**
 * Draws pickers' pictures ahead, so a picker opens with every card at once: while a controller is plugged in, now and
 * then (every PICTURE_AHEAD_S, when nothing is being drawn) the next creature in play with neither a roster picture nor
 * one drawn yet gets one. Nearly every real creature has its roster picture, so this is rare (a dev fixture, one kept
 * without a picture): drawing borrows the TV's renderer, which is never done for nothing. Whether a creature has a
 * roster picture is read from the roster once for each creature not seen before (a creature's picture never changes).
 */
export class DrawAhead {
  private wait = 0;
  /** Has each creature seen a roster picture? */
  private readonly thumbed = new Map<string, boolean>();
  private reading = false;

  constructor(
    private readonly pictures: Pick<CreaturePictures, 'get' | 'has' | 'idle'>,
    private readonly roster: () => Promise<readonly { id: string; thumb: string | null }[]>,
  ) {}

  /** One frame: `dt` real s, the creatures in play (in order), whether a controller is plugged in. */
  tick(dt: number, inPlay: readonly string[], plugged: boolean): void {
    if ((this.wait -= dt) > 0 || !plugged || this.reading || !this.pictures.idle) return;
    this.wait = PICTURE_AHEAD_S;
    if (inPlay.some((id) => !this.thumbed.has(id))) return this.read(inPlay);
    const id = inPlay.find((i) => this.thumbed.get(i) === false && !this.pictures.has(i));
    if (id) this.pictures.get(id).catch((e) => console.warn(`could not draw ${id} for the picker`, e));
  }

  /** Learns which creatures in play have a roster picture (those not in the roster have none); kept for those in play. */
  private read(inPlay: readonly string[]): void {
    this.reading = true;
    this.roster().then((list) => {
      const thumbs = new Map(list.map((s) => [s.id, !!s.thumb]));
      const keep = new Set(inPlay);
      for (const id of this.thumbed.keys()) if (!keep.has(id)) this.thumbed.delete(id);
      for (const id of inPlay) this.thumbed.set(id, thumbs.get(id) ?? false);
    }, (e) => console.warn('could not read the roster for the pickers', e)).finally(() => {
      this.reading = false;
    });
  }
}
