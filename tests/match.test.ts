import { describe, it, expect } from 'vitest';
import {
  autoLanePick,
  bothPicked,
  cardById,
  createMatchState,
  createRoundPlay,
  currentPlayLane,
  dealLaneOffer,
  GamePhase,
  getScoreString,
  isMatchOver,
  isRoundPlayComplete,
  Lane,
  LANE_ORDER,
  offerSynergies,
  OFFERS_PER_LANE,
  Player,
  recordRoundResult,
  resolveCurrentLane,
  resolveRound,
  resolveRoundScores,
  submitLanePick,
  summarizeRound,
  usedCardIdsFor,
} from '../src/game/rules';
import { CARDS } from '../src/game/data/cards';

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

const noneUsed = () => ({ [Player.P1]: [] as string[], [Player.P2]: [] as string[] }) as Record<Player, string[]>;

/** Play a full local round, always taking the offer at `choice`. */
function playRound(state: ReturnType<typeof createMatchState>, random: () => number, choice = 0) {
  const play = createRoundPlay(state.currentRound, {
    [Player.P1]: state.p1UsedCardIds,
    [Player.P2]: state.p2UsedCardIds,
  } as Record<Player, Set<string>>, random);
  while (!isRoundPlayComplete(play)) {
    for (const player of [Player.P1, Player.P2]) {
      const offer = play.offers[player];
      expect(submitLanePick(play, player, offer[Math.min(choice, offer.length - 1)])).toBeNull();
    }
    expect(resolveCurrentLane(play, random)).not.toBeNull();
  }
  const result = summarizeRound(play.results);
  recordRoundResult(state, result);
  return { play, result };
}

describe('Match Engine', () => {
  it('creates an empty match state with no draft phase', () => {
    const state = createMatchState();
    expect(state.currentRound).toBe(1);
    expect(state.p1RoundWins).toBe(0);
    expect(state.p2RoundWins).toBe(0);
    expect(state.matchWinner).toBeNull();
    expect(state.phase).toBe(GamePhase.Place);
    expect(state.p1UsedCardIds.size).toBe(0);
  });

  it('getScoreString returns correct format', () => {
    const state = createMatchState();
    expect(getScoreString(state)).toBe('P1: 0 - P2: 0');
    state.p1RoundWins = 1;
    state.p2RoundWins = 1;
    expect(getScoreString(state)).toBe('P1: 1 - P2: 1');
  });

  it('treats a completed tied match as over', () => {
    const state = createMatchState(1);
    expect(isMatchOver(state)).toBe(false);
    state.currentRound = 3;
    state.phase = GamePhase.MatchEnd;
    state.matchWinner = null;
    expect(isMatchOver(state)).toBe(true);
  });
});

describe('lane dealing', () => {
  it('deals two distinct cards that are legal in the lane and not blocked', () => {
    const blocked = CARDS.filter(card => card.lanes.includes(Lane.Top)).slice(0, 5).map(card => card.id);
    for (let seed = 1; seed < 30; seed++) {
      const offer = dealLaneOffer(Lane.Top, blocked, seeded(seed));
      expect(offer).toHaveLength(OFFERS_PER_LANE);
      expect(new Set(offer).size).toBe(OFFERS_PER_LANE);
      for (const id of offer) {
        expect(cardById(id)!.lanes).toContain(Lane.Top);
        expect(blocked).not.toContain(id);
      }
    }
  });

  it('gives each player their own independent offers for the current lane', () => {
    let differed = false;
    for (let seed = 1; seed < 20; seed++) {
      const play = createRoundPlay(1, noneUsed(), seeded(seed));
      expect(currentPlayLane(play)).toBe(Lane.Top);
      expect(play.offers[Player.P1]).toHaveLength(2);
      expect(play.offers[Player.P2]).toHaveLength(2);
      if (play.offers[Player.P1].join() !== play.offers[Player.P2].join()) differed = true;
    }
    expect(differed).toBe(true);
  });

  it('only accepts one of the player\'s own offered cards, once per lane', () => {
    const play = createRoundPlay(1, noneUsed(), seeded(5));
    const foreign = CARDS.find(card => card.lanes.includes(Lane.Top) && !play.offers[Player.P1].includes(card.id))!;
    expect(submitLanePick(play, Player.P1, foreign.id)).toBe('INVALID_PICK');
    expect(submitLanePick(play, Player.P1, play.offers[Player.P1][0])).toBeNull();
    expect(submitLanePick(play, Player.P1, play.offers[Player.P1][1])).toBe('ALREADY_PICKED');
    expect(bothPicked(play)).toBe(false);
    expect(resolveCurrentLane(play)).toBeNull();
  });

  it('auto-picks one of the offered cards on timeout', () => {
    const play = createRoundPlay(1, noneUsed(), seeded(8));
    const picked = autoLanePick(play, Player.P2, () => 0.99);
    expect(picked).toBe(play.offers[Player.P2][1]);
    expect(autoLanePick(play, Player.P2)).toBeNull();
  });

  it('plays the five lanes in order and resolves each with order bonus and synergy', () => {
    const play = createRoundPlay(1, noneUsed(), seeded(11));
    const lanes: Lane[] = [];
    while (!isRoundPlayComplete(play)) {
      lanes.push(currentPlayLane(play)!);
      submitLanePick(play, Player.P1, play.offers[Player.P1][0]);
      submitLanePick(play, Player.P2, play.offers[Player.P2][1]);
      const result = resolveCurrentLane(play)!;
      expect(result.p1Total).toBeCloseTo(result.p1WinRate + result.orderBonus + result.p1Synergy.bonus, 10);
      expect(result.p2Total).toBeCloseTo(result.p2WinRate + result.orderBonus + result.p2Synergy.bonus, 10);
    }
    expect(lanes).toEqual(LANE_ORDER);
    expect(play.results.map(result => result.orderBonus)).toEqual([0.05, 0.04, 0.03, 0.02, 0.01]);
    // Live scoring matches recomputing the round from the final line-ups.
    const replay = resolveRoundScores(
      play.results.map(result => ({ card: result.p1Card, lane: result.lane })),
      play.results.map(result => ({ card: result.p2Card, lane: result.lane })),
    );
    expect(replay.p1WinRate).toBeCloseTo(summarizeRound(play.results).p1WinRate, 10);
  });

  it('shows an offer\'s synergy from the player\'s already-played cards only', () => {
    // Search seeds until an offer carries synergy, then check it against played cards.
    let found = false;
    for (let seed = 1; seed < 400 && !found; seed++) {
      const random = seeded(seed);
      const play = createRoundPlay(1, noneUsed(), random);
      while (!isRoundPlayComplete(play) && !found) {
        const synergies = offerSynergies(play, Player.P1);
        for (const synergy of Object.values(synergies)) {
          if (synergy.bonus <= 0) continue;
          found = true;
          for (const link of synergy.links) expect(play.played[Player.P1]).toContain(link.card.id);
          expect(synergy.bonus).toBeLessThanOrEqual(0.05 + 0.04 + 0.03 + 0.02 + 1e-9);
        }
        submitLanePick(play, Player.P1, play.offers[Player.P1][0]);
        submitLanePick(play, Player.P2, play.offers[Player.P2][0]);
        resolveCurrentLane(play, random);
      }
    }
    expect(found).toBe(true);
  });
});

describe('Fearless across the match', () => {
  it('never deals a card the player already played, across lanes and rounds', () => {
    const random = seeded(42);
    const state = createMatchState(3);
    const played: Record<Player, string[]> = { [Player.P1]: [], [Player.P2]: [] } as Record<Player, string[]>;
    for (let round = 1; round <= 3; round++) {
      const play = createRoundPlay(state.currentRound, {
        [Player.P1]: state.p1UsedCardIds,
        [Player.P2]: state.p2UsedCardIds,
      } as Record<Player, Set<string>>, random);
      while (!isRoundPlayComplete(play)) {
        for (const player of [Player.P1, Player.P2]) {
          for (const id of play.offers[player]) expect(played[player]).not.toContain(id);
          const pick = play.offers[player][0];
          played[player].push(pick);
          submitLanePick(play, player, pick);
        }
        resolveCurrentLane(play, random);
      }
      recordRoundResult(state, summarizeRound(play.results));
    }
    expect(new Set(played[Player.P1]).size).toBe(15);
    expect(new Set(played[Player.P2]).size).toBe(15);
    expect(usedCardIdsFor(state, Player.P1).size).toBe(15);
    expect(isMatchOver(state)).toBe(true);
    expect(state.roundResults).toHaveLength(3);
  });

  it('plays all 3 rounds even if one player wins early', () => {
    const state = createMatchState();
    const random = seeded(9);
    for (let round = 1; round <= 3; round++) {
      playRound(state, random, round % 2);
      if (round < 3) expect(isMatchOver(state)).toBe(false);
    }
    expect(isMatchOver(state)).toBe(true);
    expect(state.p1RoundWins + state.p2RoundWins).toBeLessThanOrEqual(3);
  });

  it('resolveRound records the round and marks played cards as used', () => {
    const state = createMatchState();
    const pick = (lane: Lane, offset: number) => CARDS.filter(card => card.lanes.includes(lane))[offset];
    const p1 = LANE_ORDER.map(lane => ({ card: pick(lane, 0), lane }));
    const p2 = LANE_ORDER.map(lane => ({ card: pick(lane, 1), lane }));
    const result = resolveRound(p1, p2, state);
    expect(state.roundResults).toEqual([result]);
    expect(state.currentRound).toBe(2);
    for (const item of p1) expect(state.p1UsedCardIds.has(item.card.id)).toBe(true);
    for (const item of p2) expect(state.p2UsedCardIds.has(item.card.id)).toBe(true);
  });
});
