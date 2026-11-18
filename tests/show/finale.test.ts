import { InstancedMesh, Matrix4, Object3D, Scene, Vector3 } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { CONFETTI, Finale, type CrownSpot } from '../../src/show/finale';
import { mulberry32 } from '../../src/util/rng';

const named = (scene: Scene, name: string) => scene.getObjectByName(name)!;
/** A creature `height` m tall standing at `feet`, its head's top `height` above them. */
function spotAt(feet: Vector3, height: number, headR = 0.1): CrownSpot {
  return {
    height, headR,
    place: (pos) => (pos.set(feet.x, feet.y + height, feet.z), true),
    feet: (out) => (out.copy(feet), true),
  };
}

describe('Finale', () => {
  test('the crown is big enough to see: its band at least 14% of the champion’s height across, or its head’s size', () => {
    const scene = new Scene(), finale = new Finale(scene, { rng: mulberry32(2) });
    finale.crownOn(spotAt(new Vector3(), 1.2, 0.05));
    const crown = named(scene, 'crown');
    expect(crown.visible).toBe(true);
    expect(crown.scale.x * 0.35).toBeGreaterThanOrEqual(0.14 * 1.2 - 1e-9);
    finale.crownOn(spotAt(new Vector3(), 1.2, 0.5));
    expect(crown.scale.x * 0.35).toBeCloseTo(0.5, 9);
  });

  test('400 confetti pieces in one instanced mesh, never culled, raining over the champion then lying on its platform', () => {
    const scene = new Scene(), H = 0.9, feet = new Vector3(2, 0, 0);
    const floor = (x: number, y: number, z: number) => (Math.abs(x) < 9 && Math.abs(z) < 9 && y >= 0 ? 0 : null);
    const finale = new Finale(scene, { rng: mulberry32(3), floor });
    finale.crownOn(spotAt(feet, H));
    const confetti = named(scene, 'confetti') as InstancedMesh;
    expect(confetti).toBeInstanceOf(InstancedMesh);
    expect(confetti.count).toBe(CONFETTI);
    expect(CONFETTI).toBe(400);
    expect(confetti.visible).toBe(true);
    expect(confetti.frustumCulled).toBe(false);
    const m = new Matrix4(), p = new Vector3();
    const where = (i: number) => p.setFromMatrixPosition((confetti.getMatrixAt(i, m), m)).clone();
    for (let i = 0; i < CONFETTI; i++) {
      const q = where(i);
      expect(q.y).toBeGreaterThan(H); // starts over the champion's head
      expect(Math.hypot(q.x - feet.x, q.z - feet.z)).toBeLessThan(Math.max(1, 1.5 * H) + 1e-6);
    }
    // a second in, some is still in the air round the champion's height
    for (let t = 0; t < 1; t += 1 / 60) finale.update(1 / 60);
    let near = 0;
    for (let i = 0; i < CONFETTI; i++) if (where(i).y < 3 * H + 2) near++;
    expect(near).toBeGreaterThan(CONFETTI / 4);
    for (let t = 0; t < 9; t += 1 / 60) finale.update(1 / 60);
    let down = 0;
    for (let i = 0; i < CONFETTI; i++) {
      const q = where(i);
      expect(q.y).toBeGreaterThan(0); // never under the platform's top
      if (q.y < 0.05 && Math.hypot(q.x - feet.x, q.z - feet.z) < 4) down++;
    }
    expect(down).toBeGreaterThan(0.9 * CONFETTI);
    expect(confetti.visible).toBe(true); // it stays down
    expect(named(scene, 'podium-glow').visible).toBe(true);
  });

  test('dispose takes it all out of the scene', () => {
    const scene = new Scene(), finale = new Finale(scene);
    finale.crownOn(spotAt(new Vector3(), 1));
    finale.dispose();
    const left: Object3D[] = [];
    scene.traverse((o) => { if (o !== scene) left.push(o); });
    expect(left).toEqual([]);
  });
});

describe('Finale on the stage (Task 15)', () => {
  test('a stage creature’s crown goes where its head says, every frame; the confetti lies on its platform, the rest falls away', () => {
    const scene = new Scene();
    // a platform 4 m wide whose top is at y 7 (z within ±1.5), nothing else
    const floor = (x: number, y: number, z: number) => (Math.abs(x) < 2 && Math.abs(z) < 1.5 && y >= 7 ? 7 : null);
    const finale = new Finale(scene, { rng: mulberry32(4), floor });
    const head = new Vector3(0.2, 8.3, 0);
    const spot = {
      height: 1.4, headR: 0.3,
      place: (pos: Vector3) => (pos.copy(head), true),
      feet: (out: Vector3) => (out.set(0.2, 7, 0), true),
    };
    finale.crownOn(spot);
    const crown = named(scene, 'crown');
    expect(crown.visible).toBe(true);
    expect(crown.position.toArray()).toEqual([0.2, 8.3, 0]);
    head.set(0.5, 8.5, 0);
    finale.update(1 / 60);
    expect(crown.position.toArray()).toEqual([0.5, 8.5, 0]);
    expect(named(scene, 'podium-glow').position.y).toBeCloseTo(7.02, 6);
    for (let t = 0; t < 12; t += 1 / 60) finale.update(1 / 60);
    const confetti = named(scene, 'confetti') as InstancedMesh, m = new Matrix4(), p = new Vector3();
    let lying = 0, under = 0;
    for (let i = 0; i < CONFETTI; i++) {
      p.setFromMatrixPosition((confetti.getMatrixAt(i, m), m));
      if (Math.abs(p.y - 7) < 0.05) lying++;
      else if (p.y < 7 - 0.5) under++;
      else throw new Error(`confetti ${i} hangs in the air at ${p.y}`);
    }
    expect(lying).toBeGreaterThan(CONFETTI / 4);
    expect(lying + under).toBe(CONFETTI);
    // with no confetti (dropping in after Again!), only the crown
    const quiet = new Finale(new Scene(), { floor });
    quiet.crownOn(spot, false);
    expect(quiet.champion).toBe(spot);
    finale.clear();
    expect(crown.visible).toBe(false);
    expect(finale.champion).toBeNull();
  });
});

describe('Confetti and a moving platform (final review minor)', () => {
  /** Where each piece is. */
  function pieces(scene: Scene): Vector3[] {
    const confetti = named(scene, 'confetti') as InstancedMesh, m = new Matrix4();
    return Array.from({ length: CONFETTI }, (_, i) => new Vector3().setFromMatrixPosition((confetti.getMatrixAt(i, m), m)));
  }
  /** The ground (top 0, |x| < 20) and a branch 4 m wide whose top is at y 5, its middle at `branch.x`. */
  function level() {
    const branch = { x: 0 };
    const floor = (x: number, y: number, z: number) => {
      if (Math.abs(z) > 1.5) return null;
      if (Math.abs(x - branch.x) < 2 && y >= 5) return 5;
      return Math.abs(x) < 20 && y >= 0 ? 0 : null;
    };
    return { branch, floor };
  }

  test('pieces that land on a branch fall again to the ground once it slides away (none float in the air)', () => {
    const scene = new Scene(), { branch, floor } = level();
    const finale = new Finale(scene, { rng: mulberry32(5), floor });
    finale.crownOn(spotAt(new Vector3(0, 5, 0), 1.2));
    for (let t = 0; t < 10; t += 1 / 60) finale.update(1 / 60);
    const onBranch = pieces(scene).filter((p) => Math.abs(p.y - 5) < 0.05).length;
    expect(onBranch).toBeGreaterThan(CONFETTI / 4);
    branch.x = 50; // it slides away
    for (let t = 0; t < 10; t += 1 / 60) finale.update(1 / 60);
    for (const p of pieces(scene)) {
      const lying = Math.abs(p.y) < 0.05 && Math.abs(p.x) < 20 && Math.abs(p.z) <= 1.5;
      if (!lying && p.y > -13.9) throw new Error(`a piece hangs in the air at (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
    }
  });

  test('pieces falling under a branch that slides over them land on the ground, never fall through it', () => {
    const scene = new Scene(), { branch, floor } = level();
    branch.x = 50;
    const finale = new Finale(scene, { rng: mulberry32(6), floor });
    finale.crownOn(spotAt(new Vector3(0, 0, 0), 1.2));
    for (let t = 0; t < 0.3; t += 1 / 60) finale.update(1 / 60);
    branch.x = 0; // over them now, while they fall below it
    for (let t = 0; t < 10; t += 1 / 60) finale.update(1 / 60);
    let ground = 0;
    for (const p of pieces(scene)) {
      if (Math.abs(p.x) < 20 && Math.abs(p.z) <= 1.5) {
        expect(p.y).toBeGreaterThan(-0.01); // never through the ground
        if (Math.abs(p.y) < 0.05) ground++;
      }
    }
    expect(ground).toBeGreaterThan(CONFETTI / 4);
  });
});
