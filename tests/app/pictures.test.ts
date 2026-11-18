import { describe, expect, test } from 'vitest';
import { CreaturePictures, DrawAhead, PICTURE_AHEAD_S } from '../../src/app/pictures';

describe('CreaturePictures: each creature drawn once, one at a time', () => {
  test('drawn once and kept; drawn one after another, never two at once', async () => {
    let running = 0, most = 0;
    const drawn: string[] = [];
    const pics = new CreaturePictures(async (id) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 2));
      drawn.push(id);
      running--;
      return `data:image/png;base64,${id}`;
    });
    expect(pics.idle).toBe(true);
    const all = await Promise.all(['a', 'b', 'a', 'c'].map((id) => pics.get(id)));
    expect(all).toEqual(['data:image/png;base64,a', 'data:image/png;base64,b', 'data:image/png;base64,a', 'data:image/png;base64,c']);
    expect(drawn).toEqual(['a', 'b', 'c']);
    expect(most).toBe(1);
    expect(await pics.get('b')).toBe('data:image/png;base64,b');
    expect(drawn).toHaveLength(3);
    expect(pics.idle).toBe(true);
  });

  test('no body (null) or a failed drawing is not kept: tried again next time; a failure does not stop the next one', async () => {
    let body = false, fail = true;
    const pics = new CreaturePictures(async (id) => {
      if (id === 'x' && fail) throw new Error('lost the GPU');
      return id === 'y' && !body ? null : `url-${id}`;
    });
    await expect(pics.get('x')).rejects.toThrow();
    expect(await pics.get('y')).toBeNull();
    await Promise.resolve();
    expect(pics.has('x')).toBe(false);
    expect(pics.has('y')).toBe(false);
    fail = false;
    body = true;
    expect(await pics.get('x')).toBe('url-x');
    expect(await pics.get('y')).toBe('url-y');
    expect(pics.has('y')).toBe(true);
  });

  test('keeps at most `max`, the oldest going first', async () => {
    const pics = new CreaturePictures(async (id) => `u-${id}`, 2);
    for (const id of ['a', 'b', 'c']) await pics.get(id);
    expect(pics.has('a')).toBe(false);
    expect(pics.has('b')).toBe(true);
    expect(pics.has('c')).toBe(true);
  });
});

describe('DrawAhead: pictures drawn ahead for the pickers, only where they are needed (final review #4)', () => {
  /** A picture store that records what it was asked to draw. */
  function store() {
    const drawn: string[] = [];
    const pictures = new CreaturePictures(async (id) => {
      drawn.push(id);
      return `u-${id}`;
    });
    return { pictures, drawn };
  }
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  test('never draws a creature that has a roster picture; draws one with none (a dev fixture), one at a time, only with a pad plugged in', async () => {
    const { pictures, drawn } = store();
    let reads = 0;
    const ahead = new DrawAhead(pictures, async () => {
      reads++;
      return [{ id: 'kid1', thumb: 'data:thumb' }, { id: 'kid2', thumb: 'data:thumb' }, { id: 'old', thumb: null }, { id: 'kid3', thumb: 'data:thumb' }];
    });
    const inPlay = ['kid1', 'dev-fists-1', 'kid2', 'old'];
    ahead.tick(1, inPlay, false); // no controller: nothing
    await flush();
    expect(reads).toBe(0);
    for (let i = 0; i < 20; i++) {
      ahead.tick(PICTURE_AHEAD_S, inPlay, true);
      await flush();
    }
    expect(drawn.sort()).toEqual(['dev-fists-1', 'old']);
    expect(reads).toBe(1); // the roster is read once for creatures it had not seen
    // a newcomer with a roster picture: read once more, never drawn
    for (let i = 0; i < 5; i++) {
      ahead.tick(PICTURE_AHEAD_S, [...inPlay, 'kid3'], true);
      await flush();
    }
    expect(reads).toBe(2);
    expect(drawn.sort()).toEqual(['dev-fists-1', 'old']);
  });

  test('a roster that cannot be read draws nothing and is tried again later', async () => {
    const { pictures, drawn } = store();
    let fail = true;
    const warn = console.warn;
    console.warn = () => {};
    try {
      const ahead = new DrawAhead(pictures, async () => {
        if (fail) throw new Error('no database');
        return [];
      });
      ahead.tick(PICTURE_AHEAD_S, ['x'], true);
      await flush();
      expect(drawn).toEqual([]);
      fail = false;
      for (let i = 0; i < 3; i++) {
        ahead.tick(PICTURE_AHEAD_S, ['x'], true);
        await flush();
      }
      expect(drawn).toEqual(['x']);
    } finally {
      console.warn = warn;
    }
  });
});
