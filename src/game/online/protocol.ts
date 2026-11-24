import type { Lane, LaneRevealResult, Player, RoundResult } from '../rules/types';

export type OnlinePhase = 'waiting' | 'battle' | 'summary' | 'matchEnd';

export interface PublicSeat {
  name: string;
  connected: boolean;
  isGuest: boolean;
}

export interface BattleView {
  lead: Player;
  /** Index into LANE_ORDER of the lane being played; 5 once the round is over. */
  laneIndex: number;
  currentLane: Lane | null;
  /** This player's own 10-card hand for the round: myHand[laneIndex] = that lane's two ids. Never the opponent's. */
  myHand: string[][];
  /** This player's locked main card for the current lane, if any. */
  myMain: string | null;
  /** This player's chosen partners for the current lane (empty = none or not chosen yet). */
  myPartners: string[];
  /** True while the main card is locked and this player still has to choose partners (any subset, bonuses stack). */
  needPartner: boolean;
  /** Partner choices for the locked main card, best tier first (own hand only). */
  myPartnerOptions: string[];
  /** This player's red cards: already used as a partner this round. */
  myRed: string[];
  /** Whether the opponent has finished the current lane (main + partner); the cards stay hidden. */
  opponentLocked: boolean;
  /** The opponent's two candidate cards for the current lane (open info). Never says which one they picked. */
  opponentCandidates: string[];
  /** This player's own played main cards this round (lane -> card id). */
  myCards: Partial<Record<Lane, string>>;
  /** Lanes already resolved, with both main cards, chosen partners and the duel result. */
  revealed: LaneRevealResult[];
  /** Picks for the current lane open at this time (after the reveal animation pause). */
  turnStartsAt: number | null;
  /** Server-enforced deadline; unfinished picks get a random main card and only the single best partner. */
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
  /** Set when the match ended because this player left mid-match (the other player wins). */
  forfeitedBy: Player | null;
}

export type ClientMessage =
  | { type: 'pick'; cardId: string }
  | { type: 'partner'; cardIds: string[] } // Any subset of the partner options (empty = none).
  | { type: 'ready' }
  | { type: 'leave' } // Leave the room: frees the seat while waiting, forfeits mid-match.
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'welcome'; you: Player; sessionToken: string; roomCode: string }
  | { type: 'state'; state: MatchView }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; serverNow: number };
