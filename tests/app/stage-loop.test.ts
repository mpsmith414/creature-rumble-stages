import { describe, expect, test } from 'vitest';
import { StageLoop } from '../../src/app/stage-loop';
import { TEST_LEVEL } from '../../src/levels/test';
import { bodyStats, type BodyStats } from '../../src/stage/body';
import { StageSim } from '../../src/stage/sim';
import { DT, NO_INTENT, type Intent } from '../../src/stage/types';
import { mulberry32 } from '../../src/util/rng';
import { loadFixture } from '../fixtures/fighters';

const FISTS: BodyStats = bodyStats(loadFixture('fists'));
const LEGS: BodyStats = bodyStats(loadFixture('legs'));

/** A loop on the test level with two fighters: `a` in the middle, `b` 4 m to its left. */
function twoOnStage(brains = true) {
  const rng = mulberry32(7);
  const sim = new StageSim({ level: TEST_LEVEL, rng });
  sim.add('a', FISTS, { x: 0, y: 0 });
  sim.add('b', LEGS, { x: -4, y: 0 });
  return { sim, loop: new StageLoop({ sim, rng, brains }) };
}

describe('StageLoop: the fight steps at a fixed 60 Hz whatever the screen does', () => {
  test('steps at a fixed 60 Hz: frame(0.05) is 3 steps, the remainder carried', () => {
    const { sim, loop } = twoOnStage();
    expect(loop.frame(0.05)).toHaveLength(3);
    expect(sim.steps).toBe(3);
    // 0.01 s is less than a step: nothing yet, but it is kept, and the next 0.01 s makes one
    expect(loop.frame(0.01)).toHaveLength(0);
    expect(loop.alpha).toBeCloseTo(0.01 / DT, 6);
    expect(loop.frame(0.01)).toHaveLength(1);
    expect(sim.steps).toBe(4);
    // a minute of 60 Hz frames is 3600 steps exactly (no drift)
    for (let i = 0; i < 3600; i++) loop.frame(1 / 60);
    expect(sim.steps).toBe(3604);
  });

  test('at most 4 steps a frame: a long stall does not make the fight race to catch up', () => {
    const { sim, loop } = twoOnStage();
    expect(loop.frame(1)).toHaveLength(4);
    expect(sim.steps).toBe(4);
    // the stall's backlog is dropped, not carried into the next frames
    expect(loop.frame(0)).toHaveLength(0);
    expect(loop.frame(DT)).toHaveLength(1);
    // a broken frame time steps nothing
    for (const bad of [NaN, -1, Infinity]) expect(loop.frame(bad)).toHaveLength(0);
    expect(sim.steps).toBe(5);
  });

  test('timeScale 0.25 runs a quarter of the steps (slow motion)', () => {
    const { sim, loop } = twoOnStage();
    loop.timeScale = 0.25;
    for (let i = 0; i < 120; i++) loop.frame(1 / 60);
    expect(sim.steps).toBe(30);
    loop.timeScale = 0;
    for (let i = 0; i < 60; i++) loop.frame(1 / 60);
    expect(sim.steps).toBe(30);
  });

  test('a steered fighter follows its source, the others think', () => {
    const { sim, loop } = twoOnStage();
    let calls = 0;
    // `a` is told to run right, away from `b` (its brain would walk left to b)
    loop.steer('a', () => {
      calls++;
      return { ...NO_INTENT, mx: 1 };
    });
    for (let i = 0; i < 30; i++) loop.frame(1 / 60);
    expect(calls).toBe(30); // asked once per step
    const a = sim.get('a')!, b = sim.get('b')!;
    expect(a.mover.pos.x).toBeGreaterThan(1.5);
    expect(a.facing).toBe(1);
    // `b` thinks: it walks toward `a`
    expect(b.mover.pos.x).toBeGreaterThan(-3);
    // let go: `a` thinks again and turns back toward `b` (after which it may well roll away from `b`'s kick)
    loop.steer('a', null);
    let turned = false;
    for (let i = 0; i < 30; i++) {
      loop.frame(1 / 60);
      turned ||= a.facing === -1;
    }
    expect(calls).toBe(30);
    expect(turned).toBe(true);
  });

  test('a source that answers null lets the brain think for that step (a controller put down)', () => {
    const { sim, loop } = twoOnStage();
    let resting = false, asked = 0;
    loop.steer('a', () => {
      asked++;
      return resting ? null : { ...NO_INTENT, mx: 1 };
    });
    for (let i = 0; i < 30; i++) loop.frame(1 / 60);
    const a = sim.get('a')!;
    expect(a.facing).toBe(1);
    resting = true;
    let turned = false;
    for (let i = 0; i < 30; i++) {
      loop.frame(1 / 60);
      turned ||= a.facing === -1; // its brain turns it back toward b
    }
    expect(asked).toBe(60);
    expect(turned).toBe(true);
  });

  test('without brains the others stand still; a steered fighter still moves', () => {
    const { sim, loop } = twoOnStage(false);
    const jump: Intent = { ...NO_INTENT, jump: true };
    loop.steer('b', () => jump);
    for (let i = 0; i < 30; i++) loop.frame(1 / 60);
    expect(sim.get('a')!.mover.pos.x).toBeCloseTo(0, 6);
    expect(sim.get('b')!.mover.pos.y).toBeGreaterThan(0.5);
  });

  test('showingOff: a lone creature struts and poses (the show plays its show-off then); none before it thinks', () => {
    const rng = mulberry32(7);
    const sim = new StageSim({ level: TEST_LEVEL, rng });
    sim.add('a', FISTS, { x: 0, y: 0 });
    const loop = new StageLoop({ sim, rng });
    expect(loop.showingOff('a')).toBe(false);
    expect(loop.showingOff('nobody')).toBe(false);
    let posed = false;
    for (let i = 0; i < 60 * 20 && !posed; i++) {
      loop.frame(1 / 60);
      posed = loop.showingOff('a');
    }
    expect(posed).toBe(true);
  });

  test('forget drops the records kept for a fighter (a comeback starts afresh); its controller stays', () => {
    const { sim, loop } = twoOnStage();
    let asked = 0;
    loop.steer('a', () => {
      asked++;
      return NO_INTENT;
    });
    loop.frame(1 / 60);
    expect(loop.prev('a')).toBeDefined();
    expect(loop.prev('b')).toBeDefined();
    sim.remove('b');
    loop.forget('b');
    expect(loop.prev('b')).toBeUndefined();
    expect(loop.tracked()).toEqual(['a']);
    // back with the same id: nothing of the old one carries over, and it thinks again from its next step
    sim.add('b', LEGS, { x: -4, y: 0 });
    expect(loop.prev('b')).toBeUndefined();
    loop.frame(1 / 60);
    expect(loop.prev('b')).toBeDefined();
    expect(loop.tracked()).toEqual(['a', 'b']);
    // forgetting the steered one keeps its controller (the TV player keeps the pad through a comeback)
    sim.remove('a');
    loop.forget('a');
    sim.add('a', FISTS, { x: 0, y: 0 });
    loop.frame(1 / 60);
    expect(asked).toBe(3);
  });

  test('remembers where everyone was before the last step, for drawing between steps', () => {
    const { sim, loop } = twoOnStage();
    loop.steer('a', () => ({ ...NO_INTENT, mx: 1 }));
    for (let i = 0; i < 20; i++) loop.frame(1 / 60);
    const before = { ...sim.get('a')!.mover.pos };
    loop.frame(1 / 60);
    const prev = loop.prev('a')!;
    expect(prev.x).toBeCloseTo(before.x, 9);
    expect(prev.y).toBeCloseTo(before.y, 9);
    expect(prev.t).toBe(sim.get('a')!.actionT - 1);
    expect(loop.prevTime).toBeCloseTo(sim.t - DT, 9);
    expect(loop.prev('nobody')).toBeUndefined();
  });
});

describe('StageLoop: the crowning (Task 15)', () => {
  test('with thinking off nobody gets a brain’s wanting (they stand still); on again, they think again', () => {
    const { sim, loop } = twoOnStage();
    for (let i = 0; i < 30; i++) loop.frame(DT);
    loop.thinking = false;
    for (let i = 0; i < 120; i++) loop.frame(DT);
    const a = sim.get('a')!.mover.pos.x, b = sim.get('b')!.mover.pos.x;
    for (let i = 0; i < 60; i++) loop.frame(DT);
    expect(sim.get('a')!.mover.pos.x).toBeCloseTo(a, 6);
    expect(sim.get('b')!.mover.pos.x).toBeCloseTo(b, 6);
    loop.thinking = true;
    for (let i = 0; i < 60; i++) loop.frame(DT);
    expect(Math.abs(sim.get('a')!.mover.pos.x - a) + Math.abs(sim.get('b')!.mover.pos.x - b)).toBeGreaterThan(0.2);
  });
});
