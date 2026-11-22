export const K = 8;
export const ALPHA = 1;
export const BETA = 1;
export const TOTAL_ROUNDS = 3;
/** Seconds each player has for their own draft picks (chess clock; only ticks on their turn). */
export const DRAFT_SECONDS_PER_PLAYER = 100;
/** @deprecated Use DRAFT_SECONDS_PER_PLAYER. Kept as an alias so older call sites keep compiling. */
export const DRAFT_TOTAL_SECONDS = DRAFT_SECONDS_PER_PLAYER;
export const DRAFT_PER_LANE = 3;
export const CARDS_PER_ROUND = 5;
export const WIN_RATE_TIE_EPSILON = 1e-10;

export const ORDER_BONUS = [5, 4, 3, 2, 1] as const;
export const SYNERGY_MIN_GAMES = 20;
export const SYNERGY_MIN_EDGE = 0.08;
export const SYNERGY_RAW_CAP = 0.30;
export const SYNERGY_BONUS_MIN = 5;
export const SYNERGY_BONUS_MAX = 8;

/** Seconds for every battle-phase decision (choosing/confirming the next lane to open). */
export const BATTLE_TURN_SECONDS = 20;
/** The countdown turns red when this many seconds (or fewer) remain. */
export const BATTLE_TURN_WARNING_SECONDS = 5;
/** Pause after a lane is revealed so both players can watch the duel animation. */
export const LANE_REVEAL_PAUSE_MS = 4000;
