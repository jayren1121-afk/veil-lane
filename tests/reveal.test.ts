import { describe, expect, it } from 'vitest';
import {
  Card, CardRole, createRevealState, getOrderBonus, getRemainingLanes, getRevealOrder,
  isRevealComplete, Lane, LANE_ORDER, ORDER_BONUS, Player, revealLane, resolveLaneDuel,
  resolveRoundScores,
} from '../src/game/rules';
import { Placement } from '../src/game/rules/types';

function makeCard(id: string, lane: Lane): Card {
  return {
    id,
    name: id,
    role: CardRole.Fighter,
    lanes: [lane],
    laneWinRate: 0.5,
    laneGames: 20,
    color: '#ffffff',
  };
}

describe('lane reveal rules', () => {
  it('applies ORDER_BONUS by the actual reveal index to both players', () => {
    const first = makeCard('unknown_p1', Lane.Top);
    const second = makeCard('unknown_p2', Lane.Top);
    ORDER_BONUS.forEach((bonus, orderIndex) => {
      const result = resolveLaneDuel(first, second, Lane.Top, orderIndex);
      expect(result.orderBonus).toBe(bonus / 100);
      expect(result.p1Total - result.p1WinRate).toBeCloseTo(bonus / 100, 10);
      expect(result.p2Total - result.p2WinRate).toBeCloseTo(bonus / 100, 10);
      expect(result.p1Total - result.p1WinRate).toBeCloseTo(result.p2Total - result.p2WinRate, 10);
    });
  });

  it('records chosen lanes in order and rejects a repeated lane', () => {
    let state = createRevealState(Player.P2);
    state = revealLane(state, Lane.Mid)!;
    state = revealLane(state, Lane.Top)!;
    expect(getRevealOrder(state)).toEqual([Lane.Mid, Lane.Top]);
    expect(getOrderBonus(0)).toBe(5);
    expect(getOrderBonus(1)).toBe(4);
    expect(getRemainingLanes(state)).toEqual(LANE_ORDER.filter(lane => lane !== Lane.Mid && lane !== Lane.Top));
    expect(revealLane(state, Lane.Mid)).toBeNull();
    expect(isRevealComplete(state)).toBe(false);
  });

  it('resolves the round in the submitted reveal order and records first player', () => {
    const p1: Placement[] = LANE_ORDER.map(lane => ({ card: makeCard(`p1_${lane}`, lane), lane }));
    const p2: Placement[] = LANE_ORDER.map(lane => ({ card: makeCard(`p2_${lane}`, lane), lane }));
    const order = [Lane.Support, Lane.Bot, Lane.Mid, Lane.Jungle, Lane.Top];
    const result = resolveRoundScores(p1, p2, order, Player.P2);
    expect(result.firstPlayer).toBe(Player.P2);
    expect(result.revealOrder).toEqual(order);
    expect(result.laneResults.map(lane => lane.orderBonus)).toEqual(ORDER_BONUS.map(bonus => bonus / 100));
  });

  it('returns a tie when both teams have identical lane results and synergy', () => {
    const sameTeam: Placement[] = LANE_ORDER.map(lane => ({ card: makeCard(`same_${lane}`, lane), lane }));
    const result = resolveRoundScores(sameTeam, sameTeam, LANE_ORDER, Player.P1);
    expect(result.p1WinRate).toBeCloseTo(result.p2WinRate, 12);
    expect(result.roundWinner).toBeNull();
  });
});