import {
  BoxGeometry, BufferAttribute, Color, CylinderGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial,
  MeshToonNodeMaterial, PlaneGeometry, Quaternion, SphereGeometry, Vector3, type Material,
} from 'three/webgpu';
import { toonGradient } from '../../render/toon';
import { platformsAt, type Level, type Platform } from '../../stage/level';
import { mulberry32 } from '../../util/rng';

/**
 * The practice level drawn plainly (a grey box with a little colour): every platform as a block in the stage's plane
 * z = 0, the main stage as a floating island, a sky behind, far hills and clouds, and a sea of clouds under the stage.
 * Fully zoomed out the TV shows more than the camera bounds (about 39 m across on a 16:9 screen against 32 m of
 * bounds), so everything round the edges reaches at least `SCENERY_REACH` past them (R22): no bare edge ever shows.
 */

/** How far past the level's camera bounds the scenery reaches at least (m): each side, and above and below. */
export const SCENERY_REACH = { side: 6, vertical: 3 };

/** How deep (toward and away from the camera, z) a block is (m): the main stage, a thin platform. */
const STAGE_DEPTH_Z = 6, THIN_DEPTH_Z = 3;
/** The main stage's front face sits this far toward the camera (m): fighters (z = 0) stand well on its top. */
const STAGE_FRONT = 1.6;
/** The coloured top every platform wears: how thick (m) and how far it overhangs each side (m). */
const LIP_H = 0.18, LIP_OUT = 0.08;
/** The island's rocky root under the main stage: how far it hangs (m) and its tip's width share. */
const ROOT_DROP = 5, ROOT_TIP = 0.15;
/** The sky backdrop: how far behind the stage (m) and its size (m), big enough for any view the camera allows. */
const SKY_Z = -60, SKY_W = 420, SKY_H = 240;
/** The cloud sea under the stage: its puffs' height (m below the camera bounds' bottom), depth range and spacing (m). */
const SEA_BELOW = 5, SEA_Z = [-2.5, -7] as const, SEA_STEP = 3.2, SEA_R = [2.4, 3.8] as const;
/** Far hills and sky clouds: how far back (m) and how many. */
const HILLS_Z = -38, HILLS = 9, CLOUDS_Z = [-26, -44] as const, CLOUDS = 14;
/** Clouds are drawn this many times brighter than their colour: the TV's tone mapping greys a plain white. */
const CLOUD_GLOW = 4;

const COLOURS = {
  skyTop: '#4aa8ec', skyBottom: '#d6f0ff',
  grass: '#7ed957', earth: '#c99a6b', root: '#9b7350',
  plank: '#e8a35e', plankTop: '#ffe2b0', mover: '#5fb8f5', moverTop: '#d9f1ff',
  cloud: '#ffffff', sea: '#f3f7ff', hill: '#8fd49c',
};

/** A level's scenery: its group (add it to the scene), `update(t)` to move the moving platforms to level time `t`. */
export type Scenery = { group: Group; update(t: number): void; dispose(): void };

const toon = (hex: string) => {
  const m = new MeshToonNodeMaterial({ color: new Color(hex) });
  m.gradientMap = toonGradient();
  return m;
};

export function testScenery(level: Level): Scenery {
  const group = new Group();
  group.name = 'scenery:test';
  const mats: Material[] = [];
  const mat = (hex: string) => {
    const m = toon(hex);
    mats.push(m);
    return m;
  };
  const cam = level.camera;
  const rng = mulberry32(7); // the same puffs and hills every time

  // ---- the platforms ----
  const grass = mat(COLOURS.grass), earth = mat(COLOURS.earth), root = mat(COLOURS.root);
  const plank = mat(COLOURS.plank), plankTop = mat(COLOURS.plankTop), mover = mat(COLOURS.mover), moverTop = mat(COLOURS.moverTop);
  const blocks = new Map<string, Group>();
  for (const p of level.platforms) {
    const g = new Group();
    g.name = `platform:${p.id}`;
    const solid = p.kind === 'solid', moving = !!p.path;
    const depth = solid ? STAGE_DEPTH_Z : THIN_DEPTH_Z, front = solid ? STAGE_FRONT : depth / 2;
    const bodyMat = solid ? earth : moving ? mover : plank, topMat = solid ? grass : moving ? moverTop : plankTop;
    const body = new Mesh(new BoxGeometry(p.w, p.h - LIP_H, depth), bodyMat);
    body.position.set(0, -LIP_H - (p.h - LIP_H) / 2, front - depth / 2);
    const lip = new Mesh(new BoxGeometry(p.w + 2 * LIP_OUT, LIP_H, depth + 2 * LIP_OUT), topMat);
    lip.position.set(0, -LIP_H / 2, front - depth / 2);
    for (const m of [body, lip]) {
      m.receiveShadow = true;
      m.castShadow = true;
      g.add(m);
    }
    if (solid) {
      // a floating island: a rocky root tapering away under the block
      const r = new Mesh(new CylinderGeometry(0.5, ROOT_TIP / 2, 1, 7), root);
      r.scale.set(p.w, ROOT_DROP, depth);
      r.position.set(0, -p.h - ROOT_DROP / 2, front - depth / 2);
      g.add(r);
    }
    group.add(g);
    blocks.set(p.id, g);
  }

  // ---- the sky: a gradient backdrop far behind ----
  const skyGeo = new PlaneGeometry(SKY_W, SKY_H, 1, 8);
  const top = new Color(COLOURS.skyTop), bottom = new Color(COLOURS.skyBottom), c = new Color();
  const pos = skyGeo.getAttribute('position'), col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = Math.min(1, Math.max(0, (pos.getY(i) + SKY_H / 2 - SKY_H * 0.35) / (SKY_H * 0.3)));
    c.copy(bottom).lerp(top, k).toArray(col, i * 3);
  }
  skyGeo.setAttribute('color', new BufferAttribute(col, 3));
  const skyMat = new MeshBasicNodeMaterial({ vertexColors: true });
  skyMat.toneMapped = false;
  mats.push(skyMat);
  const sky = new Mesh(skyGeo, skyMat);
  sky.name = 'scenery:sky';
  sky.position.set((cam.left + cam.right) / 2, (cam.bottom + cam.top) / 2, SKY_Z);
  group.add(sky);

  // ---- puffs: the cloud sea under the stage, clouds in the sky, far hills (one draw call each) ----
  const ball = new SphereGeometry(1, 16, 10);
  const m4 = new Matrix4(), q = new Quaternion(), at = new Vector3(), size = new Vector3();
  const puffs = (name: string, material: Material, n: number, place: (i: number) => void) => {
    const im = new InstancedMesh(ball, material, n);
    im.name = name;
    for (let i = 0; i < n; i++) {
      place(i);
      im.setMatrixAt(i, m4.compose(at, q, size));
    }
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingBox();
    im.computeBoundingSphere();
    group.add(im);
    return im;
  };
  // clouds unlit (a lit white ball shades grey) and brighter than white, so they stay white through the tone mapping
  const flat = (hex: string) => {
    const m = new MeshBasicNodeMaterial({ color: new Color(hex).multiplyScalar(CLOUD_GLOW) });
    m.toneMapped = false;
    mats.push(m);
    return m;
  };
  const cloud = flat(COLOURS.cloud), sea = flat(COLOURS.sea), hill = mat(COLOURS.hill);
  const seaLeft = cam.left - SCENERY_REACH.side - SEA_R[1] * 2, seaRight = cam.right + SCENERY_REACH.side + SEA_R[1] * 2;
  const seaN = Math.ceil((seaRight - seaLeft) / SEA_STEP) + 1;
  puffs('scenery:cloud-sea', sea, seaN, (i) => {
    const r = SEA_R[0] + (SEA_R[1] - SEA_R[0]) * rng();
    at.set(seaLeft + i * SEA_STEP, cam.bottom - SEA_BELOW + rng() * 0.8, SEA_Z[0] + (SEA_Z[1] - SEA_Z[0]) * rng());
    size.set(r * 1.3, r * 0.8, r);
  });
  const skyLeft = cam.left - 40, skyRight = cam.right + 40;
  puffs('scenery:clouds', cloud, CLOUDS, (i) => {
    const r = 0.9 + rng() * 1.1;
    at.set(skyLeft + ((i + rng() * 0.6) / CLOUDS) * (skyRight - skyLeft), cam.top - 2 + rng() * 10,
      CLOUDS_Z[0] + (CLOUDS_Z[1] - CLOUDS_Z[0]) * rng());
    size.set(r * 2.2, r * 0.7, r);
  });
  puffs('scenery:hills', hill, HILLS, (i) => {
    const r = 14 + rng() * 10;
    at.set(skyLeft - 20 + ((i + 0.5) / HILLS) * (skyRight - skyLeft + 40), cam.bottom - 12 + rng() * 4, HILLS_Z - rng() * 8);
    size.set(r * 1.4, r, r * 0.5);
  });

  const now: Platform[] = [];
  const update = (t: number) => {
    platformsAt(level, Number.isFinite(t) ? t : 0, now);
    for (const p of now) blocks.get(p.id)?.position.set(p.x, p.y, 0);
  };
  update(0);

  return {
    group,
    update,
    dispose() {
      group.traverse((o) => {
        if (o instanceof Mesh) o.geometry.dispose();
      });
      for (const m of mats) m.dispose(); // toonGradient() is shared and kept
      group.removeFromParent();
    },
  };
}
