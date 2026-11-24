import {
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
import { TOTAL_ROUNDS } from './constants';
import { coinFlip, getFirstPlayer } from './turn';

/**
 * Create a new match state.
 */
export function createMatchState(seed?: number): MatchState {
  return {
    p1UsedCardIds: new Set(),
    p2UsedCardIds: new Set(),
    currentRound: 1,
    round1FirstPlayer: coinFlip(seed),
    p1RoundWins: 0,
    p2RoundWins: 0,
    roundResults: [],
    matchWinner: null,
    phase: GamePhase.Place,
  };
}

/**
 * Resolve a full round from both line-ups (lanes played in `revealOrder`) and record it.
 */
export function resolveRound(
  p1Placements: Placement[],
  p2Placements: Placement[],
  state: MatchState,
  revealOrder: Lane[] = LANE_ORDER
): RoundResult {
  const result = resolveRoundScores(p1Placements, p2Placements, revealOrder, getFirstPlayer(state));
  recordRoundResult(state, result);
  return result;
}

/**
 * Record a finished round: mark every played card as used (Fearless for the rest of the
 * match), add the round win, and advance to the next round or end the match.
 */
export function recordRoundResult(state: MatchState, result: RoundResult): void {
  for (const lane of result.laneResults) {
    usedCardIdsFor(state, Player.P1).add(lane.p1Card.id);
    usedCardIdsFor(state, Player.P2).add(lane.p2Card.id);
  }
  if (result.roundWinner === Player.P1) state.p1RoundWins++;
  else if (result.roundWinner === Player.P2) state.p2RoundWins++;

  state.roundResults.push(result);

  // Always play all TOTAL_ROUNDS, then the side with more round wins takes the match.
  if (state.currentRound >= TOTAL_ROUNDS) {
    if (state.p1RoundWins > state.p2RoundWins) state.matchWinner = Player.P1;
    else if (state.p2RoundWins > state.p1RoundWins) state.matchWinner = Player.P2;
    else state.matchWinner = null;
    state.phase = GamePhase.MatchEnd;
  } else {
    state.currentRound++;
    state.phase = GamePhase.Place;
  }
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
