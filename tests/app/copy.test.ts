import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Task 15: the ring is gone from what anyone reads on the TV or a phone. Every string of words (a literal with a space
 * in it: names such as a `crown-ring` class are code, not copy) in the TV's and the phones'
 * pages, menus and screens says nothing about a ring, ropes, a bumper or a ball pit.
 */
const FILES = [
  ...['src/phone', 'src/bring'].flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.ts')).map((f) => join(d, f))),
  'src/app/main.ts', 'src/app/rumble.ts', 'src/app/menu.ts', 'src/app/show.ts', 'src/app/stage-show.ts', 'src/app/wiring.ts',
  'src/app/dev.ts', 'src/show/pops.ts', 'src/show/banner.ts', 'src/show/capsule.ts', 'src/show/drop-in.ts', 'src/show/stage-calls.ts',
  'src/announcer/lines.ts', 'src/announcer/audition.ts', 'index.html', 'phone.html',
];
const RING = /\b(ring|rings|rope|ropes|bumper|ball pit)\b/i;

/** The source without its comments (block, line and HTML ones). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** Every string literal (quoted or a template) and every bit of HTML text with a space in it. */
function words(src: string, html: boolean): string[] {
  const out: string[] = [];
  const literal = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of code(src).matchAll(literal)) out.push(m[1] ?? m[2] ?? m[3]);
  if (html) for (const m of src.matchAll(/>([^<>]+)</g)) out.push(m[1]);
  return out.filter((w) => /\s/.test(w.trim()));
}

describe('no ring words on the TV or the phones (Task 15)', () => {
  test.each(FILES)('%s', (f) => {
    const found = words(readFileSync(f, 'utf8'), f.endsWith('.html')).filter((w) => RING.test(w));
    expect(found).toEqual([]);
  });

  test('the check would catch it', () => {
    const src = "const a = 'Send to the ring!'; // the ring\n/* ring */ const b = \"crown-ring\";";
    expect(words(src, false).filter((w) => RING.test(w))).toEqual(['Send to the ring!']);
  });
});
