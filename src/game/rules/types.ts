// Lane positions in the game
export enum Lane {
  Top = 'Top',
  Jungle = 'Jungle',
  Mid = 'Mid',
  Bot = 'Bot',
  Support = 'Support',
}

export const LANE_ORDER: Lane[] = [Lane.Top, Lane.Jungle, Lane.Mid, Lane.Bot, Lane.Support];

export const LANE_LABELS: Record<Lane, string> = {
  [Lane.Top]: 'Top',
  [Lane.Jungle]: 'Jungle',
  [Lane.Mid]: 'Mid',
  [Lane.Bot]: 'Bot',
  [Lane.Support]: 'Support',
};

// Card rarity / role flavor
export enum CardRole {
  Tank = 'Tank',
  Fighter = 'Fighter',
  Mage = 'Mage',
  Assassin = 'Assassin',
  Marksman = 'Marksman',
  Enchanter = 'Enchanter',
}

// A card in the game
export interface Card {
  id: string;            // internal ID like "card_01"
  name: string;          // original display name
  role: CardRole;        // flavor role
  lanes: Lane[];         // valid lanes this card can be placed in
  laneWinRate: number;   // overall win rate in its primary lane (0-1), for Bayesian prior
  laneGames: number;     // number of games played in primary lane
  color: string;         // card face color for placeholder art
}

export enum Player {
  P1 = 'P1',
  P2 = 'P2',
}

// A placed card in a lane during a round (no special cards)
export interface Placement {
  card: Card;
  lane: Lane;
}

// Matchup data: precomputed head-to-head between two cards in a lane
export interface MatchupEntry {
  cardA: string;   // card ID
  cardB: string;   // card ID
  lane: Lane;
  winsA: number;   // A wins against B
  total: number;   // total games A vs B in this lane
}

// Synergy data: precomputed teammate pair stats
export interface SynergyEntry {
  cardA: string;   // card ID
  laneA: Lane;     // position of A when they played together
  cardB: string;   // card ID
  laneB: Lane;     // position of B when they played together
  wins: number;    // team wins when both on same team
  total: number;   // total games both on same team
}

// Per-lane matchup detail for a round
export interface LaneMatchupDetail {
  lane: Lane;
  p1Card: Card;
  p2Card: Card;
  p1BaseLogit: number;       // logit of P1 card base win rate
  p2BaseLogit: number;       // logit of P2 card base win rate
  p1MuLogit: number;         // logit of P1 shrinkage win rate (matchup)
  p2MuLogit: number;         // logit of P2 shrinkage win rate (matchup)
  matchupDelta: number;      // logit(p1Mu) - logit(p1Base) for P1
  rawWins: number;           // raw head-to-head wins
  rawTotal: number;          // raw head-to-head total
}

// Per-pair synergy detail
export interface SynergyDetail {
  cardA: Card;
  cardB: Card;
  laneA: Lane;
  laneB: Lane;
  deltaSyn: number;          // logit(pPair) - logit(pExp)
  pPair: number;             // shrinkage pair win rate
  pExp: number;              // expected pair win rate
  rawWins: number;
  rawTotal: number;
}

export interface ObviousSynergy {
  cardA: Card;
  laneA: Lane;
  cardB: Card;
  laneB: Lane;
  wins: number;
  total: number;
  expectedWinRate: number;
  synergyWinRate: number;
  edge: number;
}

export interface TeamSynergy {
  obviousSynergies: ObviousSynergy[];
  rawValue: number;
  bonus: number;
}

export interface RevealState {
  firstPlayer: Player;
  revealOrder: Lane[];
}

// Team score breakdown (three layers on logit scale)
export interface TeamScore {
  baseLogit: number;         // (1/5) * sum of logit(pBase_i)
  matchupLogit: number;      // (1/5) * sum of (logit(pMu_i) - logit(pBase_i))
  synergyLogit: number;      // (1/10) * sum of deltaSyn_ij
  totalLogit: number;        // base + alpha*matchup + beta*synergy
}

// Result of a single lane reveal (matchup only, no synergy)
export interface LaneRevealResult {
  lane: Lane;
  p1Card: Card;
  p2Card: Card;
  p1WinRate: number;         // P1 card win rate in this lane (matchup only)
  p2WinRate: number;         // P2 card win rate in this lane (matchup only)
  matchupDelta: number;      // logit delta for P1
  orderIndex: number;
  orderBonus: number;        // common percentage-point bonus, e.g. 5 means +5%
  p1Total: number;            // matchup win rate + order bonus
  p2Total: number;            // matchup win rate + order bonus
  laneWinner: Player | null; // null = tie
}

// Result of a full round after all five lanes have been revealed
export interface RoundResult {
  firstPlayer: Player;
  revealOrder: Lane[];
  laneResults: LaneRevealResult[];
  p1MatchupAvg: number;
  p2MatchupAvg: number;
  orderBonusAvg: number;
  p1Synergy: TeamSynergy;
  p2Synergy: TeamSynergy;
  p1WinRate: number;
  p2WinRate: number;
  roundWinner: Player | null;
}

// Full match state (best of 3)
export interface MatchState {
  p1Hand: Card[];           // P1's drafted hand
  p2Hand: Card[];           // P2's drafted hand
  p1UsedCardIds: Set<string>; // Fearless — cards P1 already played this match
  p2UsedCardIds: Set<string>; // Fearless — cards P2 already played this match
  currentRound: number;     // 1-based
  round1FirstPlayer: Player;
  p1RoundWins: number;
  p2RoundWins: number;
  roundResults: RoundResult[];
  matchWinner: Player | null;
  phase: GamePhase;
}

export enum GamePhase {
  Draft = 'Draft',
  Place = 'Place',
  Reveal = 'Reveal',
  Resolve = 'Resolve',
  RoundEnd = 'RoundEnd',
  MatchEnd = 'MatchEnd',
}

// --- Draft (pick) types ---

/** One slot in the draft: which lane, which player, which card (if picked). */
export interface DraftSlot {
  lane: Lane;
  player: Player;
  cardId: string | null;  // null = not yet picked
}

/** Draft state — tracks per-lane picks for the current round. */
export interface DraftState {
  slots: DraftSlot[];           // ordered pick slots
  currentIndex: number;         // next slot to pick
  /** Chess-clock banks in milliseconds; only the current player's bank ticks down. */
  timeRemainingMs: Record<Player, number>;
}

/** The Fearless set that belongs to `player`. */
export function usedCardIdsFor(
  state: Pick<MatchState, 'p1UsedCardIds' | 'p2UsedCardIds'>,
  player: Player,
): Set<string> {
  return player === Player.P1 ? state.p1UsedCardIds : state.p2UsedCardIds;
}
