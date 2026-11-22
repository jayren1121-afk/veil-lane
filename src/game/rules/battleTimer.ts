import { BATTLE_TURN_SECONDS, BATTLE_TURN_WARNING_SECONDS } from './constants';
import { getRemainingLanes, revealLane } from './reveal';
import { Lane, RevealState } from './types';

/** Absolute deadline (ms epoch) for a battle decision that becomes available after `delayMs`. */
export function createTurnDeadline(nowMs: number, delayMs = 0, seconds = BATTLE_TURN_SECONDS): number {
  return nowMs + delayMs + seconds * 1000;
}

/** Whole seconds left on the countdown (never negative, rounds up so 0.2s shows as 1). */
export function turnSecondsLeft(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

export function isTurnExpired(deadlineMs: number, nowMs: number): boolean {
  return nowMs >= deadlineMs;
}

/** True when the countdown should be drawn in the warning colour (last 5 seconds). */
export function isTurnWarning(secondsLeft: number): boolean {
  return secondsLeft <= BATTLE_TURN_WARNING_SECONDS;
}

/** Pick a random lane that has not been opened yet; null when every lane is open. */
export function pickRandomLane(state: RevealState, random: () => number = Math.random): Lane | null {
  const remaining = getRemainingLanes(state);
  if (remaining.length === 0) return null;
  const index = Math.min(remaining.length - 1, Math.floor(random() * remaining.length));
  return remaining[index];
}

/**
 * When the turn deadline has passed, auto-open a random valid lane.
 * Returns null if the deadline has not passed or no lane is left.
 */
export function autoRevealOnTimeout(
  state: RevealState,
  deadlineMs: number,
  nowMs: number,
  random: () => number = Math.random,
): { state: RevealState; lane: Lane } | null {
  if (!isTurnExpired(deadlineMs, nowMs)) return null;
  const lane = pickRandomLane(state, random);
  if (!lane) return null;
  const next = revealLane(state, lane);
  return next ? { state: next, lane } : null;
}
