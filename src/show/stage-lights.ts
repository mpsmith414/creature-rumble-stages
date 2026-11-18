import { DirectionalLight, HemisphereLight, type Scene } from 'three/webgpu';

/**
 * The stage's lights, the same on the dev page and in the Rumble (Task 15 uses these): a soft sky and one sun from the
 * front left casting shadows onto the platforms. The levels' platform colours were tuned under exactly these
 * (`PLATFORM_LIGHT` in the scenery kit), so the show must not light them differently.
 */
export const STAGE_SKY = { top: '#fff6ff', ground: '#7a6aa8', intensity: 1.5 } as const;
export const STAGE_SUN = { colour: '#ffffff', intensity: 2.3, at: [-8, 24, 20] as const, shadow: 2048 } as const;
/** The sun's shadow box (m round the stage) and its bias. */
const SHADOW_BOX = { left: -26, right: 26, top: 22, bottom: -14, near: 1, far: 90 }, SHADOW_BIAS = -0.0005;

/** Adds the stage's sky light and sun (with its target) to `scene`; returns them. */
export function addStageLights(scene: Scene): { sky: HemisphereLight; sun: DirectionalLight } {
  const sky = new HemisphereLight(STAGE_SKY.top, STAGE_SKY.ground, STAGE_SKY.intensity);
  const sun = new DirectionalLight(STAGE_SUN.colour, STAGE_SUN.intensity);
  sun.position.set(...STAGE_SUN.at);
  sun.castShadow = true;
  sun.shadow.mapSize.set(STAGE_SUN.shadow, STAGE_SUN.shadow);
  sun.shadow.bias = SHADOW_BIAS;
  Object.assign(sun.shadow.camera, SHADOW_BOX);
  scene.add(sky, sun, sun.target);
  return { sky, sun };
}
