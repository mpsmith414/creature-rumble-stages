import { Color, Group, InstancedMesh, Matrix4, Mesh, Vector3 } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { animState, poseSegments } from '../../src/anim/pose';
import { BEHIND, handSpot, holdPiece, ItemLooks, type ItemFighter } from '../../src/show/item-looks';
import { bodyStats } from '../../src/stage/body';
import { StageFighter } from '../../src/stage/fighter';
import type { ItemName, Pie, Present } from '../../src/stage/items';
import { KINDS, loadFixture } from '../fixtures/fighters';

const STATS = Object.fromEntries(KINDS.map((k) => [k, bodyStats(loadFixture(k))]));

/** A creature of `kind` standing at x = 1, posed, holding `item`. */
function creature(kind: string, item: ItemName | null, left = Infinity): ItemFighter {
  const s = STATS[kind], f = new StageFighter(kind, s, { x: 1, y: 0 });
  f.mover.ground = 'main';
  f.action = 'idle';
  const pieces = poseSegments(s.layout, animState(f), s.layout.segments.map(() => new Matrix4()));
  return { id: kind, item, left, x: 1, y: 0, w: s.w, h: s.h, facing: 1, move: s.move, colour: '#ff4f7b', layout: s.layout, pieces };
}

const named = (root: Group, prefix: string) => root.children.filter((o): o is Mesh => o instanceof Mesh && o.name.startsWith(prefix));
const shown = (root: Group, prefix: string) => named(root, prefix).filter((m) => m.visible);

/** The sparkles drawn (more than a speck), and their spots. */
function sparkles(root: Group): Vector3[] {
  const im = root.children.find((o): o is InstancedMesh => o instanceof InstancedMesh)!;
  const out: Vector3[] = [], m = new Matrix4(), s = new Vector3();
  for (let i = 0; i < im.count; i++) {
    im.getMatrixAt(i, m);
    s.setFromMatrixScale(m);
    if (s.x > 1e-3) out.push(new Vector3().setFromMatrixPosition(m));
  }
  return out;
}

describe('item looks', () => {
  test('a present floats down under its parachute behind the play plane; landed, the parachute is gone', () => {
    const looks = new ItemLooks(new Group());
    const p: Present = { id: 0, item: 'icePop', x: 3, y: 9, on: null, dx: 0, landT: 0 };
    looks.update([p], [], [], [], 1 / 60);
    const [box] = shown(looks.root, 'present'), [chute] = shown(looks.root, 'parachute');
    expect(box.position.toArray()).toEqual([3, 9, BEHIND]);
    expect(chute).toBeDefined();
    expect(BEHIND).toBeLessThan(0);
    p.on = 'main';
    p.y = 0;
    looks.update([p], [], [], [], 1 / 60);
    expect(shown(looks.root, 'parachute')).toHaveLength(0);
    expect(shown(looks.root, 'present')).toHaveLength(1);
    looks.update([], [], [], [], 1 / 60);
    expect(shown(looks.root, 'present')).toHaveLength(0);
  });

  test('a held noodle or pie is in the hand; nothing held, nothing shown', () => {
    const looks = new ItemLooks(new Group());
    for (const k of KINDS) {
      for (const item of ['poolNoodle', 'custardPie'] as const) {
        const f = creature(k, item);
        looks.update([], [], [f], [], 1 / 60);
        const prefix = item === 'poolNoodle' ? 'noodle' : 'held-pie';
        const [m] = shown(looks.root, prefix);
        expect(m, `${k} ${item}`).toBeDefined();
        expect(m.position.distanceTo(handSpot(f, new Vector3())), `${k} ${item}`).toBeLessThan(1e-6);
        // the hand is somewhere on the body, not off in space
        expect(Math.abs(m.position.x - f.x), k).toBeLessThan(f.w / 2 + 1.2);
        expect(holdPiece(f.layout, f.move, 1).s).toBeLessThan(f.layout.segments.length);
      }
      looks.update([], [], [creature(k, null)], [], 1 / 60);
      expect(shown(looks.root, 'noodle').length + shown(looks.root, 'held-pie').length).toBe(0);
    }
  });

  test('a timed power-up sparkles round the creature behind it; a shield is a bubble behind it', () => {
    const looks = new ItemLooks(new Group());
    looks.update([], [], [creature('fists', 'zoomSneakers', 8)], [], 1 / 60);
    const sp = sparkles(looks.root);
    expect(sp.length).toBeGreaterThan(3);
    for (const v of sp) expect(v.z).toBeLessThan(0);
    looks.update([], [], [creature('fists', 'poolNoodle')], [], 1 / 60);
    expect(sparkles(looks.root)).toHaveLength(0);
    looks.update([], [], [creature('fists', 'bubbleShield')], [], 1 / 60);
    const [bubble] = shown(looks.root, 'bubble');
    expect(bubble.position.z).toBeLessThan(0);
  });

  test('kid power: a soft glow and twinkles in the pad’s colour behind the creature (never in front); none without it', () => {
    const looks = new ItemLooks(new Group());
    const kid = { ...creature('fists', null), kid: '#3ec7ff' };
    /** The instances of InstancedMesh `name` drawn (more than a speck): spot and colour. */
    const drawn = (name: string) => {
      const im = looks.root.children.find((o): o is InstancedMesh => o instanceof InstancedMesh && o.name === name)!;
      const out: { at: Vector3; colour: Color }[] = [], m = new Matrix4(), sc = new Vector3();
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m);
        sc.setFromMatrixScale(m);
        if (sc.x <= 1e-3) continue;
        const colour = new Color();
        im.getColorAt(i, colour);
        out.push({ at: new Vector3().setFromMatrixPosition(m), colour });
      }
      return out;
    };
    looks.update([], [], [kid], [], 1 / 60);
    const glow = drawn('kid-glow');
    expect(glow).toHaveLength(1);
    expect(glow[0].at.x).toBeCloseTo(kid.x, 6);
    expect(glow[0].at.y).toBeCloseTo(kid.y + kid.h / 2, 6);
    // the pad's colour as the TV shows it (blue: more blue than red)
    expect(glow[0].colour.b).toBeGreaterThan(glow[0].colour.r);
    const twinkles = drawn('kid-sparkles');
    expect(twinkles.length).toBeGreaterThan(1);
    for (const g of [...glow, ...twinkles]) expect(g.at.z).toBeLessThan(0);
    // a timed power-up's sparkle still shows beside it
    looks.update([], [], [{ ...kid, item: 'zoomSneakers', left: 8 }], [], 1 / 60);
    expect(sparkles(looks.root).length).toBeGreaterThan(3);
    expect(drawn('kid-glow')).toHaveLength(1);
    looks.update([], [], [creature('fists', null), { ...creature('blob', null), kid: null }], [], 1 / 60);
    expect(drawn('kid-glow')).toHaveLength(0);
    expect(drawn('kid-sparkles')).toHaveLength(0);
  });

  test('a pie flies; one that splats a creature leaves custard on its face for the stun, an ice pop shows a moment', () => {
    const looks = new ItemLooks(new Group());
    const pie: Pie = { from: 'a', x: 2, y: 1, vx: 10, vy: 0 };
    looks.update([], [pie], [], [], 1 / 60);
    expect(shown(looks.root, 'pie-')).toHaveLength(1);
    const f = creature('blob', null);
    looks.update([], [], [f], [{ phase: 'end', item: 'custardPie', id: 'a', target: 'blob', at: { x: 1, y: 1 } }], 1 / 60);
    expect(shown(looks.root, 'pie-')).toHaveLength(0);
    expect(shown(looks.root, 'splat')).toHaveLength(1);
    for (let k = 0; k < 80; k++) looks.update([], [], [f], [], 1 / 60);
    expect(shown(looks.root, 'splat')).toHaveLength(0);
    looks.update([], [], [f], [{ phase: 'use', item: 'icePop', id: 'blob', at: { x: 1, y: 1 } }], 1 / 60);
    expect(shown(looks.root, 'ice-pop')).toHaveLength(1);
  });

  test('a pie a shield stopped (an end cue with no target) leaves no custard', () => {
    const looks = new ItemLooks(new Group());
    const f = creature('blob', 'bubbleShield');
    looks.update([], [], [f], [{ phase: 'end', item: 'custardPie', id: 'a', at: { x: 1, y: 1 } }], 1 / 60);
    expect(shown(looks.root, 'splat')).toHaveLength(0);
  });

  test('dispose takes it out of the scene', () => {
    const scene = new Group(), looks = new ItemLooks(scene);
    expect(scene.children).toContain(looks.root);
    looks.dispose();
    expect(scene.children).not.toContain(looks.root);
  });
});
