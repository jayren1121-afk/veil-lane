import { describe, it, expect } from 'vitest';
import {
  createMatchState,
  runDraft,
  placeCards,
  resolveRound,
  canPlaceCard,
  getAvailableCards,
  isMatchOver,
  getScoreString,
  GamePhase,
  Placement,
  Player,
  Lane,
} from '../src/game/rules';

describe('Match Engine', () => {
  it('creates empty match state', () => {
    const state = createMatchState();
    expect(state.p1Hand).toEqual([]);
    expect(state.p2Hand).toEqual([]);
    expect(state.currentRound).toBe(1);
    expect(state.p1RoundWins).toBe(0);
    expect(state.p2RoundWins).toBe(0);
    expect(state.matchWinner).toBeNull();
  });

  it('draft deals cards to both players', () => {
    const state = createMatchState();
    runDraft(state);

    expect(state.p1Hand.length).toBeGreaterThan(0);
    expect(state.p2Hand.length).toBeGreaterThan(0);
    // No duplicate cards between players
    const p1Ids = new Set(state.p1Hand.map((c) => c.id));
    const p2Ids = new Set(state.p2Hand.map((c) => c.id));
    for (const id of p1Ids) {
      expect(p2Ids.has(id)).toBe(false);
    }
  });

  it('Fearless blocks used cards', () => {
    const state = createMatchState();
    runDraft(state);

    const card = state.p1Hand[0];
    state.p1UsedCardIds.add(card.id);

    expect(canPlaceCard(card, card.lanes[0], state, Player.P1)).toBe(false);
    expect(canPlaceCard(card, card.lanes[0], state, Player.P2)).toBe(true);
  });

  it('placeCards validates lane coverage', () => {
    const state = createMatchState();
    runDraft(state);

    const placements: Placement[] = [];
    for (let i = 0; i < 4 && i < state.p1Hand.length; i++) {
      const lane = [Lane.Top, Lane.Jungle, Lane.Mid, Lane.Bot][i];
      const card = state.p1Hand.find((c) => c.lanes.includes(lane));
      if (card) placements.push({ card, lane });
    }

    const error = placeCards(Player.P1, placements, state);
    expect(error).toContain('Must place exactly 5');
  });

  it('placeCards validates one card per lane', () => {
    const state = createMatchState();
    runDraft(state);

    const placements: Placement[] = [];
    const topCards = state.p1Hand.filter((c) => c.lanes.includes(Lane.Top));
    if (topCards.length >= 2) {
      placements.push({ card: topCards[0], lane: Lane.Top });
      placements.push({ card: topCards[1], lane: Lane.Top });
    }
    while (placements.length < 5) {
      placements.push({ card: state.p1Hand[0], lane: Lane.Mid });
    }

    const error = placeCards(Player.P1, placements, state);
    expect(error).toContain('exactly 1 card');
  });

  it('placeCards removes cards from hand (Fearless)', () => {
    const state = createMatchState();
    runDraft(state);

    const handSizeBefore = state.p1Hand.length;

    const placements: Placement[] = [];
    const usedCardIds = new Set<string>();
    const lanes = [Lane.Top, Lane.Jungle, Lane.Mid, Lane.Bot, Lane.Support];
    for (const lane of lanes) {
      const card = state.p1Hand.find((c) => c.lanes.includes(lane) && !usedCardIds.has(c.id));
      if (card) {
        placements.push({ card, lane });
        usedCardIds.add(card.id);
      }
    }

    if (placements.length === 5) {
      const error = placeCards(Player.P1, placements, state);
      if (!error) {
        expect(state.p1Hand.length).toBe(handSizeBefore - placements.length);
        for (const p of placements) {
          expect(state.p1UsedCardIds.has(p.card.id)).toBe(true);
          expect(state.p2UsedCardIds.has(p.card.id)).toBe(false);
        }
      }
    }
  });

  it('resolveRound includes both teams\' matchup, order and synergy components', () => {
    const state = createMatchState();
    runDraft(state);

    // Build valid placements for both players
    const lanes = [Lane.Top, Lane.Jungle, Lane.Mid, Lane.Bot, Lane.Support];
    const p1Placements: Placement[] = [];
    const p2Placements: Placement[] = [];

    for (const lane of lanes) {
      const p1Card = state.p1Hand.find((c) => c.lanes.includes(lane));
      const p2Card = state.p2Hand.find((c) => c.lanes.includes(lane));
      if (p1Card) p1Placements.push({ card: p1Card, lane });
      if (p2Card) p2Placements.push({ card: p2Card, lane });
    }

    if (p1Placements.length === 5 && p2Placements.length === 5) {
      const result = resolveRound(p1Placements, p2Placements, state);
      expect(result.p1MatchupAvg + result.p2MatchupAvg).toBeCloseTo(1, 5);
      expect(result.p1WinRate).toBeCloseTo(result.p1MatchupAvg + result.orderBonusAvg + result.p1Synergy.bonus, 10);
      expect(result.p2WinRate).toBeCloseTo(result.p2MatchupAvg + result.orderBonusAvg + result.p2Synergy.bonus, 10);
      expect(result.p1WinRate).toBeGreaterThan(0);
      expect(result.p2WinRate).toBeGreaterThan(0);
    }
  });

  it('resolveRound updates match state', () => {
    const state = createMatchState();
    runDraft(state);

    const lanes = [Lane.Top, Lane.Jungle, Lane.Mid, Lane.Bot, Lane.Support];
    const p1Placements: Placement[] = [];
    const p2Placements: Placement[] = [];

    for (const lane of lanes) {
      const p1Card = state.p1Hand.find((c) => c.lanes.includes(lane));
      const p2Card = state.p2Hand.find((c) => c.lanes.includes(lane));
      if (p1Card) p1Placements.push({ card: p1Card, lane });
      if (p2Card) p2Placements.push({ card: p2Card, lane });
    }

    if (p1Placements.length === 5 && p2Placements.length === 5) {
      resolveRound(p1Placements, p2Placements, state);
      expect(state.roundResults.length).toBe(1);
      expect(state.p1RoundWins + state.p2RoundWins).toBe(1);
    }
  });

  it('getScoreString returns correct format', () => {
    const state = createMatchState();
    expect(getScoreString(state)).toBe('P1: 0 - P2: 0');

    state.p1RoundWins = 1;
    state.p2RoundWins = 1;
    expect(getScoreString(state)).toBe('P1: 1 - P2: 1');
  });

  it('isMatchOver returns false initially', () => {
    const state = createMatchState();
    expect(isMatchOver(state)).toBe(false);
  });

  it('isMatchOver returns true after all 3 rounds played', () => {
    const state = createMatchState();
    state.p1RoundWins = 2;
    state.p2RoundWins = 1;
    state.currentRound = 3;
    state.matchWinner = Player.P1;
    state.phase = GamePhase.MatchEnd;
    expect(isMatchOver(state)).toBe(true);
  });

  it('treats a completed tied match as over', () => {
    const state = createMatchState(1);
    state.currentRound = 3;
    state.phase = GamePhase.MatchEnd;
    state.matchWinner = null;
    expect(isMatchOver(state)).toBe(true);
  });

  it('match plays all 3 rounds even if one player wins early', () => {
    const state = createMatchState();
    runDraft(state);

    // Simulate 3 rounds - P1 wins all
    const lanes = [Lane.Top, Lane.Jungle, Lane.Mid, Lane.Bot, Lane.Support];
    for (let round = 1; round <= 3; round++) {
      const p1Placements: Placement[] = [];
      const p2Placements: Placement[] = [];

      for (const lane of lanes) {
        const p1Card = state.p1Hand.find((c) => c.lanes.includes(lane));
        const p2Card = state.p2Hand.find((c) => c.lanes.includes(lane));
        if (p1Card) p1Placements.push({ card: p1Card, lane });
        if (p2Card) p2Placements.push({ card: p2Card, lane });
      }

      if (p1Placements.length === 5 && p2Placements.length === 5) {
        resolveRound(p1Placements, p2Placements, state);
      }

      // After round 1 and 2, match should NOT be over
      if (round < 3) {
        expect(isMatchOver(state)).toBe(false);
      }
    }
    // After round 3, match should be over
    expect(isMatchOver(state)).toBe(true);
    expect(state.roundResults.length).toBe(3);
  });

  it('getAvailableCards filters by lane validity', () => {
    const state = createMatchState();
    runDraft(state);

    const available = getAvailableCards(Player.P1, Lane.Top, state);
    for (const card of available) {
      expect(card.lanes.includes(Lane.Top)).toBe(true);
    }
  });
});
