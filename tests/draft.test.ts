import { describe, it, expect } from 'vitest';
import {
  createDraftState,
  getDraftCandidates,
  pickCard,
  autoPick,
  isDraftComplete,
  getCurrentDraftPlayer,
  getCurrentDraftLane,
  draftToPlacements,
  applyDraftFearless,
  autoPickRemaining,
  buildDraftSlots,
  DRAFT_SECONDS_PER_PLAYER,
  draftSecondsLeft,
  spendDraftTime,
  usedCardIdsFor,
  Player,
  Lane,
  LANE_ORDER,
  createMatchState,
} from '../src/game/rules';
import { CARDS } from '../src/game/data/cards';

describe('Draft constants', () => {
  it('gives each player a 100-second chess clock', () => {
    expect(DRAFT_SECONDS_PER_PLAYER).toBe(100);
  });
});

describe('buildDraftSlots', () => {
  it('creates 10 slots (2 per lane × 5 lanes)', () => {
    const slots = buildDraftSlots(1);
    expect(slots.length).toBe(10);
  });

  it('each lane has P1 and P2 slot', () => {
    const slots = buildDraftSlots(1);
    for (const lane of LANE_ORDER) {
      const p1Slot = slots.find((s) => s.lane === lane && s.player === Player.P1);
      const p2Slot = slots.find((s) => s.lane === lane && s.player === Player.P2);
      expect(p1Slot).toBeTruthy();
      expect(p2Slot).toBeTruthy();
    }
  });

  it('odd round uses normal lane order', () => {
    const slots = buildDraftSlots(1);
    const lanes = slots.map((s) => s.lane);
    const players = slots.map((s) => s.player);
    // P1 picks all 5 lanes first: P1 Top, P1 Jungle, P1 Mid, P1 Bot, P1 Support
    // Then P2 picks all 5 lanes: P2 Top, P2 Jungle, P2 Mid, P2 Bot, P2 Support
    expect(lanes[0]).toBe(Lane.Top);
    expect(lanes[1]).toBe(Lane.Jungle);
    expect(lanes[2]).toBe(Lane.Mid);
    expect(players[0]).toBe(Player.P1);
    expect(players[1]).toBe(Player.P1);
    expect(players[2]).toBe(Player.P1);
    expect(players[3]).toBe(Player.P1);
    expect(players[4]).toBe(Player.P1);
    expect(players[5]).toBe(Player.P2);
    expect(players[6]).toBe(Player.P2);
  });

  it('even round reverses lane order', () => {
    const slots = buildDraftSlots(2);
    const lanes = slots.map((s) => s.lane);
    const players = slots.map((s) => s.player);
    // P1 picks all 5 lanes first (reversed): P1 Support, P1 Bot, P1 Mid, P1 Jungle, P1 Top
    // Then P2 picks all 5 lanes (reversed): P2 Support, P2 Bot, P2 Mid, P2 Jungle, P2 Top
    expect(lanes[0]).toBe(Lane.Support);
    expect(lanes[1]).toBe(Lane.Bot);
    expect(lanes[2]).toBe(Lane.Mid);
    expect(players[0]).toBe(Player.P1);
    expect(players[4]).toBe(Player.P1);
    expect(players[5]).toBe(Player.P2);
  });
});

describe('createDraftState', () => {
  it('initializes with timer and index 0', () => {
    const state = createDraftState(1);
    expect(state.currentIndex).toBe(0);
    expect(draftSecondsLeft(state, Player.P1)).toBe(DRAFT_SECONDS_PER_PLAYER);
    expect(draftSecondsLeft(state, Player.P2)).toBe(DRAFT_SECONDS_PER_PLAYER);
    expect(state.slots.length).toBe(10);
  });
});

describe('getDraftCandidates', () => {
  it('returns cards valid for the lane', () => {
    const match = createMatchState();
    const draft = createDraftState(1);
    const candidates = getDraftCandidates(Player.P1, Lane.Top, draft, match);
    for (const c of candidates) {
      expect(c.lanes.includes(Lane.Top)).toBe(true);
    }
  });

  it('excludes Fearless-blocked cards', () => {
    const match = createMatchState();
    const draft = createDraftState(1);

    // Block a Top card
    const topCard = CARDS.find((c) => c.lanes.includes(Lane.Top))!;
    match.p1UsedCardIds.add(topCard.id);

    const candidates = getDraftCandidates(Player.P1, Lane.Top, draft, match);
    expect(candidates.find((c) => c.id === topCard.id)).toBeUndefined();
    // The opponent may still pick the same card (per-player Fearless).
    const p2Candidates = getDraftCandidates(Player.P2, Lane.Top, draft, match);
    expect(p2Candidates.find((c) => c.id === topCard.id)).toBeTruthy();
  });

  it('lets the opponent pick a card already chosen by the other player (mirror)', () => {
    const match = createMatchState();
    const draft = createDraftState(1);

    const topCard = CARDS.find((c) => c.lanes.includes(Lane.Top))!;
    draft.slots[0].cardId = topCard.id;

    const candidates = getDraftCandidates(Player.P2, Lane.Top, draft, match);
    expect(candidates.find((c) => c.id === topCard.id)).toBeTruthy();
  });

  it('still blocks a player from picking the same card twice in one draft', () => {
    const match = createMatchState();
    const draft = createDraftState(1);
    const flex = CARDS.find((c) => c.lanes.includes(Lane.Top) && c.lanes.includes(Lane.Jungle))
      ?? CARDS.find((c) => c.lanes.includes(Lane.Top))!;
    draft.slots[0].cardId = flex.id;
    const nextLane = draft.slots[1].lane;
    const candidates = getDraftCandidates(Player.P1, nextLane, draft, match);
    if (flex.lanes.includes(nextLane)) {
      expect(candidates.find((c) => c.id === flex.id)).toBeUndefined();
    }
  });
});

describe('pickCard', () => {
  it('picks a valid card and advances index', () => {
    const match = createMatchState();
    const draft = createDraftState(1);

    const topCard = CARDS.find((c) => c.lanes.includes(Lane.Top))!;
    const err = pickCard(draft, match, topCard.id);

    expect(err).toBeNull();
    expect(draft.slots[0].cardId).toBe(topCard.id);
    expect(draft.currentIndex).toBe(1);
  });

  it('rejects invalid card', () => {
    const match = createMatchState();
    const draft = createDraftState(1);

    // Pick a Jungle card for Top lane
    const jungleCard = CARDS.find((c) => c.lanes.includes(Lane.Jungle) && !c.lanes.includes(Lane.Top))!;
    const err = pickCard(draft, match, jungleCard.id);

    expect(err).toBeTruthy();
    expect(draft.currentIndex).toBe(0);
  });

  it('rejects when draft is complete', () => {
    const match = createMatchState();
    const draft = createDraftState(1);
    draft.currentIndex = 10; // force complete

    const topCard = CARDS.find((c) => c.lanes.includes(Lane.Top))!;
    const err = pickCard(draft, match, topCard.id);

    expect(err).toContain('complete');
  });

  it('does not refill a player\'s clock after a pick', () => {
    const match = createMatchState();
    const draft = createDraftState(1);
    spendDraftTime(draft, Player.P1, 95_000);

    const topCard = CARDS.find((c) => c.lanes.includes(Lane.Top))!;
    pickCard(draft, match, topCard.id);

    expect(draftSecondsLeft(draft, Player.P1)).toBe(5);
    expect(draftSecondsLeft(draft, Player.P2)).toBe(DRAFT_SECONDS_PER_PLAYER);
  });
});

describe('autoPick', () => {
  it('picks a random card when timer expires', () => {
    const match = createMatchState();
    const draft = createDraftState(1);

    const err = autoPick(draft, match);
    expect(err).toBeNull();
    expect(draft.slots[0].cardId).toBeTruthy();
    expect(draft.currentIndex).toBe(1);
  });

  it('returns error when no candidates available', () => {
    const match = createMatchState();
    const draft = createDraftState(1);

    // Block all Top cards
    const topCards = CARDS.filter((c) => c.lanes.includes(Lane.Top));
    for (const c of topCards) {
      match.p1UsedCardIds.add(c.id);
    }

    const err = autoPick(draft, match);
    expect(err).toBeTruthy();
  });

  it('returns error when draft is complete', () => {
    const match = createMatchState();
    const draft = createDraftState(1);
    draft.currentIndex = 10;

    const err = autoPick(draft, match);
    expect(err).toContain('complete');
  });
});

describe('isDraftComplete', () => {
  it('returns false when not all slots filled', () => {
    const draft = createDraftState(1);
    expect(isDraftComplete(draft)).toBe(false);
  });

  it('returns true when all slots filled', () => {
    const draft = createDraftState(1);
    draft.currentIndex = 10;
    expect(isDraftComplete(draft)).toBe(true);
  });
});

describe('getCurrentDraftPlayer', () => {
  it('returns P1 for first slot', () => {
    const draft = createDraftState(1);
    expect(getCurrentDraftPlayer(draft)).toBe(Player.P1);
  });

  it('returns null when draft is complete', () => {
    const draft = createDraftState(1);
    draft.currentIndex = 10;
    expect(getCurrentDraftPlayer(draft)).toBeNull();
  });
});

describe('getCurrentDraftLane', () => {
  it('returns Top for first slot in round 1', () => {
    const draft = createDraftState(1);
    expect(getCurrentDraftLane(draft)).toBe(Lane.Top);
  });

  it('returns null when draft is complete', () => {
    const draft = createDraftState(1);
    draft.currentIndex = 10;
    expect(getCurrentDraftLane(draft)).toBeNull();
  });
});

describe('draftToPlacements', () => {
  it('converts completed draft to placements', () => {
    const match = createMatchState();
    const draft = createDraftState(1);

    // Fill all slots with valid picks
    for (let i = 0; i < draft.slots.length; i++) {
      const slot = draft.slots[i];
      const candidates = getDraftCandidates(slot.player, slot.lane, draft, match);
      if (candidates.length > 0) {
        slot.cardId = candidates[0].id;
      }
      draft.currentIndex = i + 1;
    }

    const { p1Placements, p2Placements } = draftToPlacements(draft);

    expect(p1Placements.length).toBe(5);
    expect(p2Placements.length).toBe(5);

    // Each lane has exactly one placement per player
    for (const lane of LANE_ORDER) {
      const p1InLane = p1Placements.filter((p) => p.lane === lane);
      const p2InLane = p2Placements.filter((p) => p.lane === lane);
      expect(p1InLane.length).toBe(1);
      expect(p2InLane.length).toBe(1);
    }
  });
});

describe('applyDraftFearless', () => {
  it('marks all drafted cards as used', () => {
    const match = createMatchState();
    const draft = createDraftState(1);

    const topCard = CARDS.find((c) => c.lanes.includes(Lane.Top))!;
    draft.slots[0].cardId = topCard.id;

    applyDraftFearless(draft, match);
    expect(match.p1UsedCardIds.has(topCard.id)).toBe(true);
    expect(match.p2UsedCardIds.has(topCard.id)).toBe(false);
  });
});

describe('Full draft flow', () => {
  it('completes a full draft with alternating picks', () => {
    const match = createMatchState();
    const draft = createDraftState(1);

    // Simulate 10 picks
    for (let i = 0; i < 10; i++) {
      const player = getCurrentDraftPlayer(draft)!;
      const lane = getCurrentDraftLane(draft)!;
      const candidates = getDraftCandidates(player, lane, draft, match);

      if (candidates.length > 0) {
        pickCard(draft, match, candidates[0].id);
      } else {
        autoPick(draft, match);
      }
    }

    expect(isDraftComplete(draft)).toBe(true);

    const { p1Placements, p2Placements } = draftToPlacements(draft);
    expect(p1Placements.length).toBe(5);
    expect(p2Placements.length).toBe(5);
  });

  it('Fearless prevents reusing cards across rounds', () => {
    const match = createMatchState();

    // Round 1 draft
    let draft = createDraftState(1);
    for (let i = 0; i < 10; i++) {
      const player = getCurrentDraftPlayer(draft)!;
      const lane = getCurrentDraftLane(draft)!;
      const candidates = getDraftCandidates(player, lane, draft, match);
      if (candidates.length > 0) {
        pickCard(draft, match, candidates[0].id);
      } else {
        autoPick(draft, match);
      }
    }
    applyDraftFearless(draft, match);

    // Round 2 draft — previously used cards should be excluded
    const round2Draft = createDraftState(2);
    const firstSlot = round2Draft.slots[0];
    const candidates = getDraftCandidates(firstSlot.player, firstSlot.lane, round2Draft, match);

    // None of P1's candidates should be in P1's Fearless set.
    // P2's used cards (if any) do not apply.
    for (const c of candidates) {
      expect(usedCardIdsFor(match, firstSlot.player).has(c.id)).toBe(false);
    }
  });

  it('Fearless is per player: P2 may reuse a card P1 already played', () => {
    const match = createMatchState();
    const draft = createDraftState(1);
    const topCard = CARDS.find((c) => c.lanes.includes(Lane.Top))!;
    draft.slots[0].cardId = topCard.id; // P1 Top
    applyDraftFearless(draft, match);

    const round2 = createDraftState(2);
    const p1Pool = getDraftCandidates(Player.P1, Lane.Top, round2, match);
    const p2Pool = getDraftCandidates(Player.P2, Lane.Top, round2, match);
    expect(p1Pool.find((c) => c.id === topCard.id)).toBeUndefined();
    expect(p2Pool.find((c) => c.id === topCard.id)).toBeTruthy();
  });
});

describe('per-player draft chess clock', () => {
  it('only spends the current player\'s bank', () => {
    const draft = createDraftState(1);
    spendDraftTime(draft, Player.P1, 40_000);
    expect(draftSecondsLeft(draft, Player.P1)).toBe(60);
    expect(draftSecondsLeft(draft, Player.P2)).toBe(100);
  });

  it('auto-picks only the timed-out player\'s remaining slots', () => {
    const match = createMatchState();
    const draft = createDraftState(1);
    const topCard = CARDS.find((c) => c.lanes.includes(Lane.Top))!;
    pickCard(draft, match, topCard.id); // P1 has 4 slots left, then P2 has 5
    spendDraftTime(draft, Player.P1, DRAFT_SECONDS_PER_PLAYER * 1000);
    expect(autoPickRemaining(draft, match, Player.P1)).toBeNull();
    expect(draft.slots.filter(s => s.player === Player.P1).every(s => s.cardId)).toBe(true);
    expect(draft.slots.filter(s => s.player === Player.P2).every(s => s.cardId === null)).toBe(true);
    expect(getCurrentDraftPlayer(draft)).toBe(Player.P2);
    expect(isDraftComplete(draft)).toBe(false);
    expect(draftSecondsLeft(draft, Player.P2)).toBe(DRAFT_SECONDS_PER_PLAYER);
  });
});
