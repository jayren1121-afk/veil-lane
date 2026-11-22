import { Card, Player, Lane, LANE_ORDER, DraftState, DraftSlot, MatchState, usedCardIdsFor } from './types';
import { DRAFT_SECONDS_PER_PLAYER, DRAFT_TOTAL_SECONDS } from './constants';
import { CARDS, shuffle } from '../data/cards';

export { DRAFT_SECONDS_PER_PLAYER, DRAFT_TOTAL_SECONDS };

export function initialDraftBanks(): Record<Player, number> {
  return {
    [Player.P1]: DRAFT_SECONDS_PER_PLAYER * 1000,
    [Player.P2]: DRAFT_SECONDS_PER_PLAYER * 1000,
  };
}

/**
 * Build the draft pick order: P1 picks all 5 lanes first, then P2 picks all 5 lanes.
 * Round 2+: reverse lane order for balance.
 */
export function buildDraftSlots(round: number): DraftSlot[] {
  const lanes = round % 2 === 1 ? [...LANE_ORDER] : [...LANE_ORDER].reverse();
  const slots: DraftSlot[] = [];

  // P1 picks all lanes first
  for (const lane of lanes) {
    slots.push({ lane, player: Player.P1, cardId: null });
  }
  // Then P2 picks all lanes
  for (const lane of lanes) {
    slots.push({ lane, player: Player.P2, cardId: null });
  }

  return slots;
}

/**
 * Create a fresh draft state for a round. Each player starts with a full chess-clock bank.
 */
export function createDraftState(round: number): DraftState {
  return {
    slots: buildDraftSlots(round),
    currentIndex: 0,
    timeRemainingMs: initialDraftBanks(),
  };
}

/** Whole seconds left on `player`'s bank (never negative, rounds up so 0.2s shows as 1). */
export function draftSecondsLeft(state: DraftState, player: Player): number {
  return Math.max(0, Math.ceil((state.timeRemainingMs[player] ?? 0) / 1000));
}

/** Deduct elapsed time from `player`'s bank. Returns the remaining milliseconds. */
export function spendDraftTime(state: DraftState, player: Player, elapsedMs: number): number {
  const left = Math.max(0, (state.timeRemainingMs[player] ?? 0) - Math.max(0, elapsedMs));
  state.timeRemainingMs[player] = left;
  return left;
}

/**
 * Get the list of cards available for a player to pick in a given lane.
 * Excludes cards this player already used earlier in the match (per-player Fearless)
 * and cards this player already picked in this round. The opponent's picks are
 * never excluded, so both sides may pick the same card (a mirror).
 */
export function getDraftCandidates(
  player: Player,
  lane: Lane,
  draftState: DraftState,
  matchState: MatchState
): Card[] {
  const myPicked = new Set<string>();
  for (const slot of draftState.slots) {
    if (slot.cardId && slot.player === player) myPicked.add(slot.cardId);
  }
  const fearless = usedCardIdsFor(matchState, player);

  return CARDS.filter((c) =>
    c.lanes.includes(lane) &&
    !fearless.has(c.id) &&
    !myPicked.has(c.id)
  );
}

/**
 * Pick a card for the current slot. Returns error message or null on success.
 */
export function pickCard(
  draftState: DraftState,
  matchState: MatchState,
  cardId: string
): string | null {
  if (draftState.currentIndex >= draftState.slots.length) {
    return 'Draft is already complete';
  }

  const slot = draftState.slots[draftState.currentIndex];
  const candidates = getDraftCandidates(slot.player, slot.lane, draftState, matchState);
  const card = candidates.find((c) => c.id === cardId);

  if (!card) {
    return `Card ${cardId} is not a valid pick for ${slot.player} in ${slot.lane}`;
  }

  slot.cardId = cardId;
  draftState.currentIndex++;

  return null;
}

/**
 * Auto-pick a random card when a player's clock expires (or a single slot needs filling).
 */
export function autoPick(
  draftState: DraftState,
  matchState: MatchState
): string | null {
  if (draftState.currentIndex >= draftState.slots.length) {
    return 'Draft is already complete';
  }

  const slot = draftState.slots[draftState.currentIndex];
  const candidates = getDraftCandidates(slot.player, slot.lane, draftState, matchState);

  if (candidates.length === 0) {
    return `No available cards for ${slot.player} in ${slot.lane}`;
  }

  const picked = shuffle(candidates)[0];
  slot.cardId = picked.id;
  draftState.currentIndex++;

  return null;
}

/**
 * Auto-pick every remaining slot that still belongs to `player`, then stop so the
 * opponent can use their own clock. Returns an error only if a slot has no legal card.
 */
export function autoPickRemaining(
  draftState: DraftState,
  matchState: MatchState,
  player: Player
): string | null {
  while (!isDraftComplete(draftState) && getCurrentDraftPlayer(draftState) === player) {
    const err = autoPick(draftState, matchState);
    if (err) return err;
  }
  return null;
}

/**
 * Check if all slots have been filled.
 */
export function isDraftComplete(draftState: DraftState): boolean {
  return draftState.currentIndex >= draftState.slots.length;
}

/**
 * Get the current player whose turn it is.
 */
export function getCurrentDraftPlayer(draftState: DraftState): Player | null {
  if (draftState.currentIndex >= draftState.slots.length) return null;
  return draftState.slots[draftState.currentIndex].player;
}

/**
 * Get the current lane being drafted.
 */
export function getCurrentDraftLane(draftState: DraftState): Lane | null {
  if (draftState.currentIndex >= draftState.slots.length) return null;
  return draftState.slots[draftState.currentIndex].lane;
}

/**
 * Convert draft results to placements for both players.
 * Each player gets one card per lane (5 lanes = 5 placements).
 */
export function draftToPlacements(
  draftState: DraftState
): { p1Placements: { card: Card; lane: Lane }[]; p2Placements: { card: Card; lane: Lane }[] } {
  const p1Placements: { card: Card; lane: Lane }[] = [];
  const p2Placements: { card: Card; lane: Lane }[] = [];

  // Group by lane: each lane has 2 slots (P1 and P2)
  for (const lane of LANE_ORDER) {
    const p1Slot = draftState.slots.find((s) => s.lane === lane && s.player === Player.P1);
    const p2Slot = draftState.slots.find((s) => s.lane === lane && s.player === Player.P2);

    if (p1Slot?.cardId) {
      const card = CARDS.find((c) => c.id === p1Slot.cardId);
      if (card) p1Placements.push({ card, lane });
    }
    if (p2Slot?.cardId) {
      const card = CARDS.find((c) => c.id === p2Slot.cardId);
      if (card) p2Placements.push({ card, lane });
    }
  }

  return { p1Placements, p2Placements };
}

/**
 * Mark each drafted card as used by the player who picked it (per-player Fearless).
 */
export function applyDraftFearless(draftState: DraftState, matchState: MatchState): void {
  for (const slot of draftState.slots) {
    if (slot.cardId) {
      usedCardIdsFor(matchState, slot.player).add(slot.cardId);
    }
  }
}
