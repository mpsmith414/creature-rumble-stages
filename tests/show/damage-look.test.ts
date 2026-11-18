import { Color, Group, InstancedMesh, Object3D, Scene, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { HEAT_KEY, WARM_KEY, WARM_MAX, warmSkin } from '../../src/render/toon';
import { DAMAGE_LOOKS, DamageLook, STEAM_MAX, type HurtFighter, type HurtLook } from '../../src/show/damage-look';
import { STAGE_TUNE } from '../../src/stage/damage';

const [WARM, HOT, FLY] = STAGE_TUNE.damageSteps;
const FRAME = 1 / 60;

/** A fighter as the look sees it: its id, damage, tune and box. */
function fighter(damage: number, id = 'a'): HurtFighter {
  return { id, damage, tune: STAGE_TUNE, mover: { pos: { x: 2, y: 1 }, h: 1.5 } };
}

/** A body as the look sees it: the mesh it tints and two googly eyes on a head bone, pupils where the eyes left them. */
function body(): HurtLook & { pupils: Vector3[] } {
  const root = new Group(), head = new Object3D(), mesh = new Object3D();
  head.position.set(2, 2.2, 0);
  head.updateMatrix();
  root.add(head, mesh);
  root.updateMatrixWorld(true);
  const pupils: Vector3[] = [];
  const eyes = [-1, 1].map((side) => {
    const ball = new Object3D();
    ball.position.set(side * 0.1, 0, 0.2);
    ball.updateMatrix();
    head.add(ball);
    const pupil = { position: new Vector3(0.05, -0.02, 0.62) };
    pupils.push(pupil.position);
    return { pupil, ball, bone: 0 };
  });
  return { root, mesh, bones: [head], eyes, pupils };
}

/** Runs the look for `seconds` of frames. */
function run(look: DamageLook, f: HurtFighter, obj: HurtLook, seconds: number): void {
  for (let t = 0; t < seconds; t += FRAME) look.update(f, obj, FRAME);
}

const lookOf = (obj: HurtLook) => ({
  warm: (obj.mesh.userData[WARM_KEY] as number | undefined) ?? 0,
  heat: (obj.mesh.userData[HEAT_KEY] as number | undefined) ?? 0,
});
const hueOf = (c: Color) => c.getHSL({ h: 0, s: 0, l: 0 }).h;
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));

describe('DamageLook', () => {
  it('has a look for each damage step: the red glow grows step by step, the skin only a little warmer', () => {
    expect(DAMAGE_LOOKS).toHaveLength(4);
    expect(DAMAGE_LOOKS[0]).toEqual({ warm: 0, heat: 0 });
    for (let s = 1; s < 4; s++) {
      expect(DAMAGE_LOOKS[s].heat, `step ${s}`).toBeGreaterThan(DAMAGE_LOOKS[s - 1].heat);
      expect(DAMAGE_LOOKS[s].warm, `step ${s}`).toBeGreaterThan(DAMAGE_LOOKS[s - 1].warm);
      expect(DAMAGE_LOOKS[s].warm, `step ${s}`).toBeLessThanOrEqual(WARM_MAX);
    }
  });

  it('every step keeps the creature\'s own colours (cyan, green, pink stay themselves): kids find theirs by colour', () => {
    for (const hex of ['#3ec7e0', '#3fbf5f', '#ff7eb6']) {
      const c = new Color(hex);
      for (let step = 0; step < 4; step++) {
        const look = new DamageLook(new Scene()), obj = body();
        run(look, fighter([0, WARM, HOT, FLY][step]), obj, 2);
        const skin = warmSkin(c, lookOf(obj).warm);
        expect(hueGap(hueOf(c), hueOf(skin)), `${hex} step ${step}`).toBeLessThan(12 / 360);
        const gap = Math.hypot(skin.r - c.r, skin.g - c.g, skin.b - c.b);
        expect(gap, `${hex} step ${step}`).toBeLessThan(0.25 * Math.hypot(c.r, c.g, c.b));
      }
    }
  });

  it('fresh: no warmth, no glow, no sweat, no steam, the eyes left alone', () => {
    const look = new DamageLook(new Scene()), obj = body();
    run(look, fighter(WARM - 1), obj, 2);
    expect(lookOf(obj)).toEqual({ warm: 0, heat: 0 });
    expect(look.state('a')).toMatchObject({ step: 0, sweat: 0, steam: 0, spinning: false });
    expect(obj.pupils[0].toArray()).toEqual([0.05, -0.02, 0.62]);
  });

  it('warm: a faint glow, eased in, and nothing else', () => {
    const look = new DamageLook(new Scene()), obj = body();
    look.update(fighter(WARM), obj, FRAME);
    expect(lookOf(obj).heat).toBeGreaterThan(0);
    expect(lookOf(obj).heat).toBeLessThan(DAMAGE_LOOKS[1].heat); // easing in, not snapping
    run(look, fighter(WARM), obj, 2);
    expect(lookOf(obj).heat).toBeCloseTo(DAMAGE_LOOKS[1].heat, 2);
    expect(lookOf(obj).warm).toBeCloseTo(DAMAGE_LOOKS[1].warm, 2);
    expect(look.state('a')).toMatchObject({ step: 1, sweat: 0, steam: 0, spinning: false });
  });

  it('hot: a red glow with sweat drops flying off, no steam, the eyes still left alone', () => {
    const look = new DamageLook(new Scene()), obj = body();
    run(look, fighter(HOT), obj, 2);
    expect(lookOf(obj).heat).toBeCloseTo(DAMAGE_LOOKS[2].heat, 2);
    const s = look.state('a');
    expect(s.step).toBe(2);
    expect(s.sweat).toBeGreaterThan(0);
    expect(s.steam).toBe(0);
    expect(s.spinning).toBe(false);
    expect(obj.pupils[0].toArray()).toEqual([0.05, -0.02, 0.62]);
  });

  it('about to fly: the strongest glow, steam puffs, and only now the pupils spin round', () => {
    const look = new DamageLook(new Scene()), obj = body();
    run(look, fighter(FLY), obj, 2);
    expect(lookOf(obj).heat).toBeGreaterThan(DAMAGE_LOOKS[2].heat);
    const s = look.state('a');
    expect(s.step).toBe(3);
    expect(s.steam).toBeGreaterThan(0);
    expect(s.spinning).toBe(true);
    // the pupils go round a circle: always the same way off the middle, never in the same place twice running
    const seen: [number, number][] = [];
    for (let k = 0; k < 20; k++) {
      look.update(fighter(FLY), obj, FRAME);
      seen.push([obj.pupils[0].x, obj.pupils[0].y]);
      expect(Math.hypot(obj.pupils[0].x, obj.pupils[0].y)).toBeGreaterThan(0.2);
      expect(Math.hypot(obj.pupils[0].x, obj.pupils[0].y)).toBeLessThan(0.42);
      expect(obj.pupils[0].z).toBeCloseTo(0.62, 6); // still on the front of the eye
    }
    for (let k = 1; k < seen.length; k++) expect(seen[k]).not.toEqual(seen[k - 1]);
    const angles = seen.map(([x, y]) => Math.atan2(y, x));
    const spread = Math.max(...angles) - Math.min(...angles);
    expect(spread).toBeGreaterThan(1); // well round the circle in a third of a second
  });

  it('steam stays sparse with many about to fly: a budget shared by all, yet each one still puffs', () => {
    const look = new DamageLook(new Scene()), ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const bodies = ids.map(() => body());
    const puffed = new Set<string>();
    let most = 0;
    for (let t = 0; t < 6; t += FRAME) {
      ids.forEach((id, i) => look.update(fighter(FLY, id), bodies[i], FRAME));
      const live = ids.reduce((n, id) => n + look.state(id).steam, 0);
      most = Math.max(most, live);
      for (const id of ids) if (look.state(id).steam > 0) puffed.add(id);
    }
    expect(most).toBeLessThanOrEqual(STEAM_MAX);
    expect(STEAM_MAX).toBeLessThanOrEqual(8);
    expect(puffed.size).toBe(ids.length);
  });

  it('cooled to fresh (an Ice Pop): the look fades, the drops and puffs die away, the eyes are let go', () => {
    const look = new DamageLook(new Scene()), obj = body();
    run(look, fighter(FLY), obj, 2);
    run(look, fighter(0), obj, 3);
    expect(lookOf(obj)).toEqual({ warm: 0, heat: 0 });
    expect(look.state('a')).toMatchObject({ step: 0, sweat: 0, steam: 0, spinning: false });
    obj.pupils[0].set(0.01, 0.02, 0.62); // the googly eye moves it again
    look.update(fighter(0), obj, FRAME);
    expect(obj.pupils[0].toArray()).toEqual([0.01, 0.02, 0.62]);
  });

  it('forgetting a fighter (or disposing) puts its body back to fresh, so a reused body never starts glowing', () => {
    const look = new DamageLook(new Scene()), a = body(), b = body();
    run(look, fighter(FLY, 'a'), a, 1);
    run(look, fighter(HOT, 'b'), b, 1);
    look.forget('a');
    expect(lookOf(a)).toEqual({ warm: 0, heat: 0 });
    expect(lookOf(b).heat).toBeGreaterThan(0);
    look.dispose();
    expect(lookOf(b)).toEqual({ warm: 0, heat: 0 });
  });

  it('the drops and puffs sit at the head, and the steam behind the play plane (it never covers a creature)', () => {
    const scene = new Scene(), look = new DamageLook(scene), obj = body();
    run(look, fighter(FLY), obj, 0.2);
    const meshes = scene.children.filter((c): c is InstancedMesh => c instanceof InstancedMesh);
    const steam = meshes.find((m) => m.name === 'damage:steam')!;
    const m = new Object3D();
    let shown = 0;
    for (let i = 0; i < steam.count; i++) {
      steam.getMatrixAt(i, m.matrix);
      if (m.matrix.elements[0] === 0) continue; // a free slot (scaled to nothing)
      m.matrix.decompose(m.position, m.quaternion, m.scale);
      shown++;
      expect(m.position.z).toBeLessThanOrEqual(-0.5);
      expect(Math.abs(m.position.x - 2)).toBeLessThan(1);
      expect(m.position.y).toBeGreaterThan(1.8); // from the head (the eyes at 2.2), rising
    }
    expect(shown).toBeGreaterThan(0);
  });

  it('a body with no eyes still shows its look, from the top of its box', () => {
    const look = new DamageLook(new Scene()), obj = { ...body(), eyes: [] };
    run(look, fighter(HOT), obj, 1);
    expect(look.state('a').sweat).toBeGreaterThan(0);
  });

  it('forgets a fighter, and takes everything out of the scene when disposed', () => {
    const scene = new Scene(), look = new DamageLook(scene), obj = body();
    run(look, fighter(HOT), obj, 1);
    look.forget('a');
    expect(look.state('a')).toMatchObject({ step: 0, sweat: 0, steam: 0 });
    const n = scene.children.length;
    expect(n).toBeGreaterThan(0);
    look.dispose();
    expect(scene.children.length).toBe(0);
  });
});
