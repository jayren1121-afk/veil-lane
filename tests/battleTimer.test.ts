import { describe, expect, it } from 'vitest';
import {
  autoRevealOnTimeout,
  BATTLE_TURN_SECONDS,
  createRevealState,
  createTurnDeadline,
  isTurnExpired,
  isTurnWarning,
  Lane,
  LANE_ORDER,
  pickRandomLane,
  Player,
  revealLane,
  turnSecondsLeft,
} from '../src/game/rules';

describe('battle turn timer', () => {
  it('uses a 20 second limit for each battle decision', () => {
    expect(BATTLE_TURN_SECONDS).toBe(20);
    expect(createTurnDeadline(1_000)).toBe(21_000);
    expect(createTurnDeadline(1_000, 4_000)).toBe(25_000);
  });

  it('counts down in whole seconds and turns red in the last 5 seconds', () => {
    const deadline = createTurnDeadline(0);
    expect(turnSecondsLeft(deadline, 0)).toBe(20);
    expect(turnSecondsLeft(deadline, 14_200)).toBe(6);
    expect(turnSecondsLeft(deadline, 25_000)).toBe(0);
    expect(isTurnWarning(6)).toBe(false);
    expect(isTurnWarning(5)).toBe(true);
    expect(isTurnExpired(deadline, 19_999)).toBe(false);
    expect(isTurnExpired(deadline, 20_000)).toBe(true);
  });

  it('does nothing before the deadline', () => {
    const state = createRevealState(Player.P1);
    expect(autoRevealOnTimeout(state, 20_000, 19_000)).toBeNull();
  });

  it('auto-opens a random unopened lane on timeout', () => {
    let state = createRevealState(Player.P2);
    state = revealLane(state, Lane.Mid)!;
    state = revealLane(state, Lane.Top)!;
    for (const roll of [0, 0.34, 0.67, 0.999]) {
      const result = autoRevealOnTimeout(state, 20_000, 20_000, () => roll)!;
      expect(result).not.toBeNull();
      expect([Lane.Jungle, Lane.Bot, Lane.Support]).toContain(result.lane);
      expect(result.state.revealOrder).toEqual([Lane.Mid, Lane.Top, result.lane]);
    }
  });

  it('never picks an opened lane and stops when every lane is open', () => {
    let state = createRevealState(Player.P1);
    for (let i = 0; i < LANE_ORDER.length; i++) {
      const lane = pickRandomLane(state, Math.random)!;
      expect(state.revealOrder).not.toContain(lane);
      state = revealLane(state, lane)!;
    }
    expect(pickRandomLane(state)).toBeNull();
    expect(autoRevealOnTimeout(state, 0, 1)).toBeNull();
  });
});
