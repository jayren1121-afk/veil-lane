export const K = 8;
/**
 * Counter-pick weight: the head-to-head part of a matchup (how far the GRID record between the
 * two specific cards moves the win rate away from the cards' general strength) is multiplied
 * by this. 1.5 was picked by simulation: guessing the opponent's card wrong in a counter-pick
 * lane typically costs ~9 win-rate points (~19 points of lane margin), up from ~6 at 1.0.
 */
export const MATCHUP_SCALE = 1.5;
/** Matchup win rates are kept inside [MATCHUP_MIN, 1 - MATCHUP_MIN] after scaling. */
export const MATCHUP_MIN = 0.05;
export const ALPHA = 1;
export const BETA = 1;
export const TOTAL_ROUNDS = 3;
export const CARDS_PER_ROUND = 5;
/** Cards dealt to each player for every lane; the player plays exactly one of them. */
export const OFFERS_PER_LANE = 2;
export const WIN_RATE_TIE_EPSILON = 1e-10;

/** Order bonus by lane order: the earliest-played lane gets +5%, then 4/3/2/1. */
export const ORDER_BONUS = [5, 4, 3, 2, 1] as const;

/**
 * "Obvious synergy" thresholds from the aggregated pair table: a same-team pair counts when it
 * has at least SYNERGY_MIN_GAMES games together and beats its expected win rate by at least
 * SYNERGY_MIN_EDGE. Loosened (was 20 games / 0.08) so most main cards have a partner in a
 * 10-card hand and the "choose one" step comes up regularly.
 */
export const SYNERGY_MIN_GAMES = 4;
export const SYNERGY_MIN_EDGE = 0.06;
/**
 * Per-lane synergy tiers (percentage points), by rank. A card's obvious partners are ranked by
 * edge. With five or fewer, the best gives +5%, the next +4%, then +3%, +2%, +1%. With more,
 * the ranked list is split into five equal rank bands that give +5/+4/+3/+2/+1%.
 */
export const SYNERGY_TIER = [5, 4, 3, 2, 1] as const;

/** Seconds each player has to pick one of their two offered cards for the current lane. */
export const BATTLE_TURN_SECONDS = 20;
/** The countdown turns red when this many seconds (or fewer) remain. */
export const BATTLE_TURN_WARNING_SECONDS = 5;
/** Pause after a lane resolves so both players can watch the duel and synergy animation. */
export const LANE_REVEAL_PAUSE_MS = 6000;
