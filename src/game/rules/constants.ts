export const K = 8;
export const ALPHA = 1;
export const BETA = 1;
export const TOTAL_ROUNDS = 3;
export const CARDS_PER_ROUND = 5;
/** Cards dealt to each player for every lane; the player plays exactly one of them. */
export const OFFERS_PER_LANE = 2;
export const WIN_RATE_TIE_EPSILON = 1e-10;

/** Order bonus by lane order: the earliest-played lane gets +5%, then 4/3/2/1. */
export const ORDER_BONUS = [5, 4, 3, 2, 1] as const;

/** "Obvious synergy" thresholds from the aggregated pair table. */
export const SYNERGY_MIN_GAMES = 20;
export const SYNERGY_MIN_EDGE = 0.08;
/**
 * Per-lane synergy tiers (percentage points). For the card being played, its obvious synergy
 * partners are ranked by edge: the best pair gives +5%, the next +4%, then +3%, +2%, +1%.
 * Pairs beyond the top five give nothing.
 */
export const SYNERGY_TIER = [5, 4, 3, 2, 1] as const;

/** Seconds each player has to pick one of their two offered cards for the current lane. */
export const BATTLE_TURN_SECONDS = 20;
/** The countdown turns red when this many seconds (or fewer) remain. */
export const BATTLE_TURN_WARNING_SECONDS = 5;
/** Pause after a lane resolves so both players can watch the duel and synergy animation. */
export const LANE_REVEAL_PAUSE_MS = 6000;
