import {
  Card,
  Player,
  Lane,
  LANE_ORDER,
  MatchState,
  GamePhase,
  Placement,
  RoundResult,
  usedCardIdsFor,
} from './types';
import { resolveRoundScores } from './duel';
import { CARDS_PER_ROUND, DRAFT_PER_LANE, TOTAL_ROUNDS } from './constants';
import { coinFlip, getFirstPlayer } from './turn';
import { CARDS, shuffle } from '../data/cards';

/**
 * Create a new match state.
 */
export function createMatchState(seed?: number): MatchState {
  return {
    p1Hand: [],
    p2Hand: [],
    p1UsedCardIds: new Set(),
    p2UsedCardIds: new Set(),
    currentRound: 1,
    round1FirstPlayer: coinFlip(seed),
    p1RoundWins: 0,
    p2RoundWins: 0,
    roundResults: [],
    matchWinner: null,
    phase: GamePhase.Draft,
  };
}

/**
 * Run the draft phase: each player gets 15 cards.
 * Strategy: for each lane, pick DRAFT_PER_LANE cards for P1 and P2 from
 * the pool of cards valid for that lane, avoiding duplicates.
 * After all lanes are processed, if a player has fewer than 15 cards,
 * fill from remaining unused cards that are valid for any of their lanes.
 */
export function runDraft(state: MatchState): void {
  const p1Draft: Card[] = [];
  const p2Draft: Card[] = [];
  const usedIds = new Set<string>();

  // Phase 1: deal DRAFT_PER_LANE per lane
  for (const lane of LANE_ORDER) {
    const validCards = shuffle(
      CARDS.filter((c) => c.lanes.includes(lane) && !usedIds.has(c.id))
    );

    for (let i = 0; i < DRAFT_PER_LANE && i < validCards.length; i++) {
      p1Draft.push(validCards[i]);
      usedIds.add(validCards[i].id);
    }
    const remaining = validCards.filter((c) => !usedIds.has(c.id));
    for (let i = 0; i < DRAFT_PER_LANE && i < remaining.length; i++) {
      p2Draft.push(remaining[i]);
      usedIds.add(remaining[i].id);
    }
  }

  // Phase 2: fill up to 15 if short (shouldn't happen with 20 cards, but safe)
  const targetHand = LANE_ORDER.length * DRAFT_PER_LANE;
  const unused = CARDS.filter((c) => !usedIds.has(c.id));
  const shuffledUnused = shuffle(unused);

  let ui = 0;
  while (p1Draft.length < targetHand && ui < shuffledUnused.length) {
    p1Draft.push(shuffledUnused[ui]);
    usedIds.add(shuffledUnused[ui].id);
    ui++;
  }
  while (p2Draft.length < targetHand && ui < shuffledUnused.length) {
    p2Draft.push(shuffledUnused[ui]);
    usedIds.add(shuffledUnused[ui].id);
    ui++;
  }

  state.p1Hand = p1Draft;
  state.p2Hand = p2Draft;
  state.phase = GamePhase.Place;
}

/**
 * Check if a card can be placed in a lane (valid lane + not Fearless-blocked).
 */
export function canPlaceCard(card: Card, lane: Lane, state: MatchState, player: Player): boolean {
  if (!card.lanes.includes(lane)) return false;
  if (usedCardIdsFor(state, player).has(card.id)) return false;
  return true;
}

/**
 * Place cards for a player. Returns error message or null on success.
 */
export function placeCards(
  player: Player,
  placements: Placement[],
  state: MatchState
): string | null {
  if (placements.length !== CARDS_PER_ROUND) {
    return `Must place exactly ${CARDS_PER_ROUND} cards`;
  }

  // Each lane must have exactly one card
  const laneCounts = new Map<Lane, number>();
  for (const p of placements) {
    laneCounts.set(p.lane, (laneCounts.get(p.lane) || 0) + 1);
  }
  for (const lane of LANE_ORDER) {
    if (laneCounts.get(lane) !== 1) {
      return `Each lane must have exactly 1 card`;
    }
  }

  // Validate each placement
  const hand = player === Player.P1 ? state.p1Hand : state.p2Hand;
  for (const p of placements) {
    if (!hand.find((c) => c.id === p.card.id)) {
      return `Card ${p.card.name} is not in ${player}'s hand`;
    }
    if (!canPlaceCard(p.card, p.lane, state, player)) {
      return `Card ${p.card.name} cannot be placed in ${p.lane}`;
    }
  }

  // Apply placements — mark cards as used (Fearless)
  for (const p of placements) {
    usedCardIdsFor(state, player).add(p.card.id);
    const idx = hand.findIndex((c) => c.id === p.card.id);
    if (idx >= 0) hand.splice(idx, 1);
  }

  return null;
}

/**
 * Resolve a full round: compute team win rates and determine winner.
 * Updates match state with the result.
 */
export function resolveRound(
  p1Placements: Placement[],
  p2Placements: Placement[],
  state: MatchState,
  revealOrder: Lane[] = LANE_ORDER
): RoundResult {
  const result = resolveRoundScores(p1Placements, p2Placements, revealOrder, getFirstPlayer(state));

  // Update match state
  if (result.roundWinner === Player.P1) state.p1RoundWins++;
  else if (result.roundWinner === Player.P2) state.p2RoundWins++;

  state.roundResults.push(result);

  // Check match end: always play all TOTAL_ROUNDS
  if (state.currentRound >= TOTAL_ROUNDS) {
    // All rounds played — determine winner by round wins
    if (state.p1RoundWins > state.p2RoundWins) {
      state.matchWinner = Player.P1;
    } else if (state.p2RoundWins > state.p1RoundWins) {
      state.matchWinner = Player.P2;
    } else {
      // Tie after all rounds
      state.matchWinner = null;
    }
    state.phase = GamePhase.MatchEnd;
  } else {
    state.currentRound++;
    state.phase = GamePhase.Place;
  }

  return result;
}

/**
 * Get the list of cards available for a player to place in a given lane.
 */
export function getAvailableCards(player: Player, lane: Lane, state: MatchState): Card[] {
  const hand = player === Player.P1 ? state.p1Hand : state.p2Hand;
  return hand.filter((c) => canPlaceCard(c, lane, state, player));
}

/**
 * Check if match is over.
 */
export function isMatchOver(state: MatchState): boolean {
  return state.phase === GamePhase.MatchEnd;
}

/**
 * Get score string like "P1: 1 - P2: 0"
 */
export function getScoreString(state: MatchState): string {
  return `${Player.P1}: ${state.p1RoundWins} - ${Player.P2}: ${state.p2RoundWins}`;
}
