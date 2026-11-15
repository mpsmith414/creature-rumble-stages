import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { buildBody, type BodyData } from '../../src/builder/build';
import type { Recipe } from '../../src/recipe/schema';
import { productionMesh } from './mesh';

/**
 * Built bodies kept on disk between test runs, for tests that use a body rather than test how one is built. Building
 * the cast is most of the suite's time, and the builder rarely changes: a body is stored under the builder's source
 * hash (`__BUILDER_HASH__`, every file in src/builder, src/recipe and src/util) and the recipe's whole JSON, so new
 * builder code or a changed recipe builds afresh. Tests of buildBody itself (determinism, LODs, timing) call it directly.
 */
const ROOT = join('node_modules', '.cache', 'rumble-bodies');
const DIR = join(ROOT, __BUILDER_HASH__);

let ready = false;
/** The cache folder for this builder, with older builders' folders cleared away. */
function dir(): string {
  if (ready) return DIR;
  mkdirSync(DIR, { recursive: true });
  for (const d of readdirSync(ROOT)) if (d !== __BUILDER_HASH__) rmSync(join(ROOT, d), { recursive: true, force: true });
  ready = true;
  return DIR;
}

/** Bytes read or made this run, by file: each call still gets its own copy (a test may change what it is given). */
const held = new Map<string, Buffer>();

function cached<T>(what: string, recipe: Recipe, extra: unknown, make: () => T): T {
  const name = `${what}-${createHash('sha1').update(JSON.stringify([recipe, extra])).digest('hex').slice(0, 16)}.bin`;
  let bytes = held.get(name);
  if (!bytes) {
    const file = join(dir(), name);
    try {
      bytes = readFileSync(file);
    } catch {
      bytes = serialize(make());
      // written aside, then renamed: test files building the same body at once never read half a file
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      try {
        renameSync(tmp, file);
      } catch {
        rmSync(tmp, { force: true }); // Windows: another file wrote it first and has it open; theirs is the same body
      }
    }
    held.set(name, bytes);
  }
  return deserialize(bytes) as T;
}

/** `buildBody(recipe, lods)`, from the cache when this builder has built it before. */
export const builtBody = (recipe: Recipe, lods: readonly number[] = [0, 1, 2]): BodyData =>
  cached('body', recipe, lods, () => buildBody(recipe, lods));

/** `productionMesh(recipe)` (the raw mesh at the production cell), from the cache when this builder has made it before. */
export const builtMesh = (recipe: Recipe): ReturnType<typeof productionMesh> => cached('mesh', recipe, null, () => productionMesh(recipe));
