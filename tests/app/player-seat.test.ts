import { describe, expect, test } from 'vitest';
import { HAND_BACK, PlayerSeat } from '../../src/app/player-seat';

describe('PlayerSeat: the AI plays fighter 1 until someone touches the controls (R24)', () => {
  test('the AI drives at first; a touch hands it to the player at once', () => {
    const seat = new PlayerSeat();
    expect(seat.playing).toBe(false);
    expect(seat.update(false, 1)).toBe(false);
    expect(seat.update(true, 1 / 60)).toBe(true);
    expect(seat.playing).toBe(true);
  });

  test(`after ${HAND_BACK} s with no input the AI takes over again; any touch before that resets the wait`, () => {
    expect(HAND_BACK).toBe(10);
    const seat = new PlayerSeat();
    seat.update(true, 1 / 60);
    for (let i = 0; i < 9.5 * 60; i++) seat.update(false, 1 / 60);
    expect(seat.playing).toBe(true);
    seat.update(true, 1 / 60); // a touch: the wait starts again
    for (let i = 0; i < 9.5 * 60; i++) seat.update(false, 1 / 60);
    expect(seat.playing).toBe(true);
    for (let i = 0; i < 0.6 * 60; i++) seat.update(false, 1 / 60);
    expect(seat.playing).toBe(false);
    expect(seat.update(true, 1 / 60)).toBe(true);
  });

  test('held input counts as playing (a stick held still for a long run is not idle)', () => {
    const seat = new PlayerSeat();
    for (let i = 0; i < 20 * 60; i++) seat.update(true, 1 / 60);
    expect(seat.playing).toBe(true);
  });

  test('a broken frame time neither hands back nor throws', () => {
    const seat = new PlayerSeat();
    seat.update(true, 1 / 60);
    for (const bad of [NaN, Infinity, -5]) seat.update(false, bad);
    expect(seat.playing).toBe(true);
  });
});
