import { describe, expect, it } from 'vitest';
import {
  computeShrinkageWinRate,
  Lane,
  Player,
  resolveLaneDuel,
  resolveRoundScores,
} from '../src/game/rules';
import { CARDS } from '../src/game/data/cards';

function cardFor(lane: Lane, offset = 0) {
  const list = CARDS.filter(c => c.lanes.includes(lane));
  return list[offset % list.length];
}

describe('same-card mirror matchups', () => {
  it('treats a mirrored lane as an even 50% duel', () => {
    const card = cardFor(Lane.Mid);
    const shrinkage = computeShrinkageWinRate(card, card, Lane.Mid);
    expect(shrinkage.winRate).toBe(0.5);
    expect(shrinkage.prior).toBe(0.5);

    const result = resolveLaneDuel(card, card, Lane.Mid, 0);
    expect(result.p1WinRate).toBe(0.5);
    expect(result.p2WinRate).toBe(0.5);
    expect(result.p1Total).toBeCloseTo(result.p2Total);
    expect(result.laneWinner).toBeNull();
  });

  it('still scores a full round when one lane is a mirror, without partners', () => {
    const p1 = [
      { card: cardFor(Lane.Top, 0), lane: Lane.Top },
      { card: cardFor(Lane.Jungle, 0), lane: Lane.Jungle },
      { card: cardFor(Lane.Mid, 0), lane: Lane.Mid },
      { card: cardFor(Lane.Bot, 0), lane: Lane.Bot },
      { card: cardFor(Lane.Support, 0), lane: Lane.Support },
    ];
    const p2 = [
      { card: p1[0].card, lane: Lane.Top }, // mirror Top
      { card: cardFor(Lane.Jungle, 1), lane: Lane.Jungle },
      { card: cardFor(Lane.Mid, 1), lane: Lane.Mid },
      { card: cardFor(Lane.Bot, 1), lane: Lane.Bot },
      { card: cardFor(Lane.Support, 1), lane: Lane.Support },
    ];
    const result = resolveRoundScores(p1, p2, [Lane.Top, Lane.Jungle, Lane.Mid, Lane.Bot, Lane.Support], Player.P1);
    expect(result.laneResults).toHaveLength(5);
    expect(result.laneResults[0].p1WinRate).toBe(0.5);
    expect(result.laneResults[0].p2WinRate).toBe(0.5);
    expect(result.p1WinRate).toBeGreaterThan(0);
    expect(result.p2WinRate).toBeGreaterThan(0);
    expect(Number.isFinite(result.p1SynergyAvg)).toBe(true);
    expect(Number.isFinite(result.p2SynergyAvg)).toBe(true);
    // Without chosen partners no lane gets synergy, mirrored or not.
    result.laneResults.forEach(lane => {
      expect(lane.p1Synergy.bonus).toBe(0);
      expect(lane.p2Synergy.bonus).toBe(0);
    });
  });
});
