import type { Lane, LaneRevealResult, Player, RoundResult } from '../rules/types';

export type OnlinePhase = 'waiting' | 'draft' | 'battle' | 'summary' | 'matchEnd';

export interface PublicSeat {
  name: string;
  connected: boolean;
  isGuest: boolean;
}

export interface DraftView {
  currentIndex: number;
  totalSlots: number;
  currentPlayer: Player | null;
  currentLane: Lane | null;
  /** When the current player's chess clock hits zero (ms epoch). */
  deadline: number;
  /** Both banks in milliseconds, already adjusted for elapsed time at serverNow. */
  timeRemainingMs: Record<Player, number>;
  /** Only this player's own picks (lane -> card id). */
  myPicks: Partial<Record<Lane, string>>;
  /** Lanes where the opponent has already locked a card (contents hidden). */
  opponentLocked: Lane[];
  /** Valid card ids for the current slot; only sent to the player whose turn it is. */
  candidates: string[];
}

export interface BattleView {
  lead: Player;
  /** This player's own cards (lane -> card id). */
  myCards: Partial<Record<Lane, string>>;
  /** Lanes where the opponent's card is still face-down. */
  opponentHidden: Lane[];
  /** Lanes already opened, with both cards and the duel result. */
  revealed: LaneRevealResult[];
  /** The current decision cannot be made before this time (reveal animation pause). */
  turnStartsAt: number | null;
  /** Server-enforced deadline; a random lane is opened when it passes. */
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
  draft: DraftView | null;
  battle: BattleView | null;
  lastRound: RoundResult | null;
  lastRoundNumber: number;
  matchWinner: Player | null;
  ready: Player[];
  summaryDeadline: number | null;
}

export type ClientMessage =
  | { type: 'pick'; cardId: string }
  | { type: 'play'; lane: Lane }
  | { type: 'ready' }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'welcome'; you: Player; sessionToken: string; roomCode: string }
  | { type: 'state'; state: MatchView }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; serverNow: number };
