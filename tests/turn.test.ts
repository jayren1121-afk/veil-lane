import { describe, expect, it } from 'vitest';
import { coinFlip, createMatchState, getFirstPlayer, getFirstPlayerForRound, otherPlayer, Player } from '../src/game/rules';

describe('first-player rules', () => {
  it('coin flip is reproducible with a seed and can produce either player', () => {
    expect(coinFlip(42)).toBe(coinFlip(42));
    const results = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(seed => coinFlip(seed)));
    expect(results).toEqual(new Set([Player.P1, Player.P2]));
  });

  it('alternates first player for rounds one, two, and three', () => {
    for (const first of [Player.P1, Player.P2]) {
      expect(getFirstPlayerForRound(first, 1)).toBe(first);
      expect(getFirstPlayerForRound(first, 2)).toBe(otherPlayer(first));
      expect(getFirstPlayerForRound(first, 3)).toBe(first);
    }
  });

  it('stores the coin flip outcome on the match and resolves its current round', () => {
    const state = createMatchState(7);
    expect(state.round1FirstPlayer).toBe(coinFlip(7));
    expect(getFirstPlayer(state, 1)).toBe(state.round1FirstPlayer);
    state.currentRound = 2;
    expect(getFirstPlayer(state)).toBe(otherPlayer(state.round1FirstPlayer));
  });
});