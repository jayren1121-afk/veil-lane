import type { Lane, LaneRevealResult, Player, RoundResult } from '../rules/types';

export type OnlinePhase = 'waiting' | 'battle' | 'summary' | 'matchEnd';

export interface PublicSeat {
  name: string;
  connected: boolean;
  isGuest: boolean;
}

export interface BattleView {
  lead: Player;
  /** Index into LANE_ORDER of the lane being picked; 5 once the round is over. */
  laneIndex: number;
  currentLane: Lane | null;
  /** This player's own two offered card ids for the current lane (never the opponent's). */
  myOffer: string[];
  /** This player's locked pick for the current lane, if any. */
  myPick: string | null;
  /** Whether the opponent has locked a pick for the current lane (the card itself stays hidden). */
  opponentPicked: boolean;
  /** This player's own played cards this round (lane -> card id). */
  myCards: Partial<Record<Lane, string>>;
  /** Lanes already resolved, with both cards, synergy links and the duel result. */
  revealed: LaneRevealResult[];
  /** Picks for the current lane open at this time (after the reveal animation pause). */
  turnStartsAt: number | null;
  /** Server-enforced deadline; anyone who has not picked gets a random offered card. */
  turnDeadline: number | null;
}

export interface MatchView {
  you: Player;
  roomCode: string;
  phase: OnlinePhase;
  round: number;
  serverNow: number;
  round1FirstPlayer: Player;
  firstPlayer: Player;
  players: Partial<Record<Player, PublicSeat>>;
  score: Record<Player, number>;
  /** This player's Fearless list only (the opponent's used cards are not sent). */
  usedCardIds: string[];
  battle: BattleView | null;
  lastRound: RoundResult | null;
  lastRoundNumber: number;
  matchWinner: Player | null;
  ready: Player[];
  summaryDeadline: number | null;
}

export type ClientMessage =
  | { type: 'pick'; cardId: string }
  | { type: 'ready' }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'welcome'; you: Player; sessionToken: string; roomCode: string }
  | { type: 'state'; state: MatchView }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; serverNow: number };
