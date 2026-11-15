import { Group, Scene, Vector3 } from 'three/webgpu';
import { describe, expect, test } from 'vitest';
import { BALL_R, POST_H } from '../../src/arena/features';
import {
  ballShadow, PAD_BOB, PAD_GLOW_HI, PAD_GLOW_LO, PAD_SPRING_S, PAD_SQUASH, padBob, padGlow, padSpring, POST_FLASH_S, postFlash, postLift,
  RingProps, type PropsView,
} from '../../src/arena/props';

const R = 6.5, DT = 1 / 60;

describe('the wild ring’s props: motion', () => {
  test('a firing pad squashes flat, springs past its height with a wobble, and settles', () => {
    expect(padSpring(0)).toBeCloseTo(PAD_SQUASH);
    let over = 1;
    for (let t = 0; t < PAD_SPRING_S; t += 0.005) over = Math.max(over, padSpring(t));
    expect(over).toBeGreaterThan(1.1);
    expect(padSpring(PAD_SPRING_S)).toBe(1);
    expect(padSpring(-Infinity)).toBe(1);
    expect(padSpring(Infinity)).toBe(1);
  });

  test('an armed pad glows and bobs; a recharging one lies still with a faint glow growing with its charge', () => {
    for (let t = 0; t < 3; t += 0.1) {
      const g = padGlow({ armed: true, charge: 1 }, t, 0), b = padBob({ armed: true }, t, 0);
      expect(g).toBeGreaterThanOrEqual(PAD_GLOW_LO - 1e-9);
      expect(g).toBeLessThanOrEqual(PAD_GLOW_HI + 1e-9);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(PAD_BOB + 1e-9);
    }
    expect(padBob({ armed: false }, 1, 0)).toBe(0);
    expect(padGlow({ armed: false, charge: 0 }, 1, 0)).toBe(0);
    expect(padGlow({ armed: false, charge: 0.9 }, 1, 0)).toBeLessThan(PAD_GLOW_LO);
    expect(padGlow({ armed: false, charge: 0.9 }, 1, 0)).toBeGreaterThan(padGlow({ armed: false, charge: 0.2 }, 1, 0));
  });

  test('a post rises from under the floor to stand on it; a ding’s flash fades; the ball’s shadow shrinks as it rises', () => {
    expect(postLift(0) + POST_H).toBeLessThan(0); // sunk: its top under the floor
    expect(postLift(1)).toBe(0);
    expect(postLift(0.5)).toBeCloseTo(postLift(0) / 2);
    expect(postFlash(0)).toBe(1);
    expect(postFlash(POST_FLASH_S / 2)).toBeLessThan(1);
    expect(postFlash(POST_FLASH_S)).toBe(0);
    expect(postFlash(-Infinity)).toBe(0);
    const low = ballShadow(0), high = ballShadow(8);
    expect(low.scale).toBe(1);
    expect(high.scale).toBeLessThan(low.scale);
    expect(high.opacity).toBeLessThan(low.opacity);
  });
});

function view(): PropsView & { pads: { at: Vector3; armed: boolean; charge: number }[]; posts: { at: Vector3; up: number }[]; ball: PropsView['ball'] } {
  return {
    pads: [0, 1, 2, 3].map((i) => ({ at: new Vector3(Math.cos(i) * 4.3, 0, Math.sin(i) * 4.3), armed: true, charge: 1 })),
    posts: [0, 1, 2].map((i) => ({ at: new Vector3(Math.cos(i * 2) * 2.3, 0, Math.sin(i * 2) * 2.3), up: 0 })),
    ball: null,
  };
}

describe('RingProps', () => {
  test('four pads on their spots; a pad that fires squashes; posts show only once risen; the ball and its shadow follow the ball', () => {
    const v = view(), props = new RingProps(new Scene(), v);
    const groups = props.group.children.filter((o) => o instanceof Group);
    expect(groups).toHaveLength(7); // 4 pads, 3 posts
    expect(groups[0].position.x).toBeCloseTo(v.pads[0].at.x);
    props.update(DT, v, R);
    const cushion = groups[0].children[1];
    expect(cushion.scale.y).toBe(1);
    v.pads[0].armed = false;
    v.pads[0].charge = 0;
    props.update(DT, v, R);
    expect(cushion.scale.y).toBeLessThan(0.5); // squashed as it fires
    for (let t = 0; t < PAD_SPRING_S + 0.1; t += DT) props.update(DT, v, R);
    expect(cushion.scale.y).toBe(1);

    const post = groups[4];
    expect(post.visible).toBe(false);
    v.posts[0].up = 0.5;
    props.update(DT, v, R);
    expect(post.visible).toBe(true);
    expect(post.position.y).toBeLessThan(0);
    v.posts[0].up = 1;
    props.update(DT, v, R);
    expect(post.position.y).toBe(0);

    expect(props.ball.visible).toBe(false);
    let at = { x: 1, y: 5, z: -1 };
    v.ball = { body: { translation: () => at, rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }) }, radius: BALL_R };
    props.update(DT, v, R);
    expect(props.ball.visible).toBe(true);
    expect(props.ball.position.y).toBe(5);
    expect(props.shadow.visible).toBe(true);
    expect(props.shadow.position.x).toBe(1);
    at = { x: R + 2, y: -3, z: 0 }; // off the ring, falling into the pit: no shadow on the floor
    props.update(DT, v, R);
    expect(props.shadow.visible).toBe(false);
    v.ball = null;
    props.update(DT, v, R);
    expect(props.ball.visible).toBe(false);
  });
});
