import { describe, expect, it } from 'vitest';
import { OnlineMatch, FIRST_DRAFT_INTRO_MS, SUMMARY_SECONDS } from '../src/game/online/match';
import {
  BATTLE_TURN_SECONDS,
  DRAFT_SECONDS_PER_PLAYER,
  Lane,
  LANE_ORDER,
  LANE_REVEAL_PAUSE_MS,
  Player,
  otherPlayer,
} from '../src/game/rules';

let tokenCounter = 0;
const newToken = () => `token-${++tokenCounter}`;

function seatedMatch(now = 0) {
  const match = OnlineMatch.create('A7K2', () => 0.1); // 0.1 < 0.5 -> P1 wins the coin flip
  const p1 = match.join('Alice', 'g:alice', null, newToken);
  const p2 = match.join('Bob', null, null, newToken);
  if (!p1.ok || !p2.ok) throw new Error('join failed');
  match.startIfReady(now);
  return { match, p1, p2 };
}

/** Plays the current draft: each player takes the first candidate the server offers them. */
function draftAll(match: OnlineMatch, now: number) {
  while (match.data.phase === 'draft') {
    const current = match.data.draft!.slots[match.data.draft!.currentIndex].player;
    const view = match.viewFor(current, now);
    expect(match.pick(current, view.draft!.candidates[0], now)).toBeNull();
  }
}

function opponentCardIds(match: OnlineMatch, player: Player): string[] {
  return match.placements(otherPlayer(player)).map(item => item.card.id);
}

describe('online match seats', () => {
  it('assigns P1 then P2 and rejects a third player', () => {
    const { match, p1, p2 } = seatedMatch();
    expect(p1.ok && p1.player).toBe(Player.P1);
    expect(p2.ok && p2.player).toBe(Player.P2);
    expect(match.join('Eve', null, null, newToken)).toEqual({ ok: false, code: 'ROOM_FULL' });
  });

  it('reconnects a player with the same session token', () => {
    const { match, p2 } = seatedMatch();
    if (!p2.ok) throw new Error();
    match.setConnected(Player.P2, false);
    expect(match.viewFor(Player.P1, 0).players.P2?.connected).toBe(false);
    const again = match.join('ignored', null, p2.sessionToken, newToken);
    expect(again).toMatchObject({ ok: true, player: Player.P2, rejoined: true });
    expect(match.viewFor(Player.P1, 0).players.P2?.connected).toBe(true);
  });

  it('starts the draft only when both seats are filled', () => {
    const match = OnlineMatch.create('B2C3');
    match.join('Solo', null, null, newToken);
    expect(match.startIfReady(0)).toBe(false);
    expect(match.data.phase).toBe('waiting');
  });
});

describe('hidden picks never leak', () => {
  it('only shows the opponent\'s locked lanes during the draft', () => {
    const { match } = seatedMatch();
    // P1 drafts all five lanes first (shared rules), then P2 begins.
    for (let i = 0; i < 5; i++) {
      const view = match.viewFor(Player.P1, 0);
      match.pick(Player.P1, view.draft!.candidates[0], 0);
    }
    const p1Cards = match.data.draft!.slots.filter(s => s.player === Player.P1).map(s => s.cardId!);
    const p2View = match.viewFor(Player.P2, 0);
    expect(p2View.draft!.opponentLocked).toHaveLength(5);
    expect(Object.keys(p2View.draft!.myPicks)).toHaveLength(0);
    // P2's list must still include P1's cards — mirrors are allowed, so absence would leak the pick.
    const p1Top = match.data.draft!.slots.find(s => s.player === Player.P1 && s.lane === Lane.Top)!.cardId!;
    expect(p2View.draft!.currentLane).toBe(Lane.Top);
    expect(p2View.draft!.candidates).toContain(p1Top);
    // The view must not label those cards as P1's picks.
    expect(p2View.draft!.myPicks).not.toHaveProperty('Top');
    // P1 sees its own picks but no candidates while waiting.
    const p1View = match.viewFor(Player.P1, 0);
    expect(Object.values(p1View.draft!.myPicks).sort()).toEqual([...p1Cards].sort());
    expect(p1View.draft!.candidates).toEqual([]);
  });

  it('reveals an opponent card only after its lane is opened', () => {
    const { match } = seatedMatch();
    draftAll(match, 0);
    expect(match.data.phase).toBe('battle');
    const lead = match.data.reveal!.firstPlayer;
    for (const viewer of [Player.P1, Player.P2]) {
      const serialized = JSON.stringify(match.viewFor(viewer, 0));
      const myIds = new Set(match.placements(viewer).map(item => item.card.id));
      for (const id of opponentCardIds(match, viewer)) {
        if (myIds.has(id)) continue; // a legal mirror appears in this player's own hand
        expect(serialized).not.toContain(`"${id}"`);
      }
    }
    const t = FIRST_DRAFT_INTRO_MS;
    expect(match.play(lead, Lane.Mid, t)).toBeNull();
    for (const viewer of [Player.P1, Player.P2]) {
      const view = match.viewFor(viewer, t);
      const serialized = JSON.stringify(view);
      const myIds = new Set(match.placements(viewer).map(item => item.card.id));
      const oppMid = match.placements(otherPlayer(viewer)).find(p => p.lane === Lane.Mid)!.card.id;
      expect(serialized).toContain(`"${oppMid}"`);
      for (const item of match.placements(otherPlayer(viewer)).filter(p => p.lane !== Lane.Mid)) {
        if (myIds.has(item.card.id)) continue;
        expect(serialized).not.toContain(`"${item.card.id}"`);
      }
      expect(view.battle!.opponentHidden).toEqual(LANE_ORDER.filter(lane => lane !== Lane.Mid));
    }
  });

  it('rejects picks and plays from the wrong player', () => {
    const { match } = seatedMatch();
    const view = match.viewFor(Player.P1, 0);
    expect(match.pick(Player.P2, view.draft!.candidates[0], 0)).toBe('NOT_YOUR_TURN');
    expect(match.pick(Player.P1, 'not_a_card', 0)).toBe('INVALID_PICK');
    draftAll(match, 0);
    const lead = match.data.reveal!.firstPlayer;
    expect(match.play(otherPlayer(lead), Lane.Top, 5000)).toBe('NOT_YOUR_TURN');
    expect(match.play(lead, Lane.Top, 5000)).toBeNull();
    expect(match.play(lead, Lane.Top, 20_000)).toBe('INVALID_LANE');
  });
});

describe('server-enforced timers', () => {
  it('auto-picks only the timed-out player and leaves the other clock untouched', () => {
    const { match } = seatedMatch(0);
    const p1Deadline = match.data.draftDeadline!;
    expect(p1Deadline).toBe(FIRST_DRAFT_INTRO_MS + DRAFT_SECONDS_PER_PLAYER * 1000);
    expect(match.tick(p1Deadline - 1)).toBe(false);
    expect(match.tick(p1Deadline)).toBe(true);
    expect(match.data.phase).toBe('draft');
    expect(match.placements(Player.P1)).toHaveLength(5);
    expect(match.placements(Player.P2)).toHaveLength(0);
    expect(match.viewFor(Player.P2, p1Deadline).draft!.timeRemainingMs.P2).toBe(DRAFT_SECONDS_PER_PLAYER * 1000);
    const p2Deadline = match.data.draftDeadline!;
    expect(p2Deadline).toBe(p1Deadline + DRAFT_SECONDS_PER_PLAYER * 1000);
    expect(match.tick(p2Deadline)).toBe(true);
    expect(match.data.phase).toBe('battle');
    expect(match.placements(Player.P2)).toHaveLength(5);
  });

  it('opens a random lane when the 20s battle turn expires', () => {
    const { match } = seatedMatch(0);
    draftAll(match, 0);
    const deadline = match.data.turnDeadline!;
    expect(deadline - match.data.turnStartsAt!).toBe(BATTLE_TURN_SECONDS * 1000);
    match.tick(deadline - 1);
    expect(match.data.laneResults).toHaveLength(0);
    match.tick(deadline);
    expect(match.data.laneResults).toHaveLength(1);
    expect(match.data.turnDeadline).toBe(deadline + LANE_REVEAL_PAUSE_MS + BATTLE_TURN_SECONDS * 1000);
  });

  it('finishes a whole best-of-3 with nobody acting, using only timeouts', () => {
    const { match } = seatedMatch(0);
    let now = 0;
    for (let step = 0; step < 200 && match.data.phase !== 'matchEnd'; step++) {
      now = match.nextDeadline()!;
      match.tick(now);
    }
    expect(match.data.phase).toBe('matchEnd');
    expect(match.data.roundResults).toHaveLength(3);
    // Per-player Fearless: each side uses 15 unique cards (mirrors between sides are allowed).
    expect(new Set(match.data.p1UsedCardIds).size).toBe(15);
    expect(new Set(match.data.p2UsedCardIds).size).toBe(15);
    const outcomes = match.outcomes();
    expect(outcomes.map(o => o.accountId)).toEqual(['g:alice']);
  });

  it('moves to the next round when both players are ready or the summary timer ends', () => {
    const { match } = seatedMatch(0);
    draftAll(match, 0);
    let now = 10_000;
    while (match.data.phase === 'battle') {
      now = Math.max(now, match.data.turnStartsAt!);
      match.play(match.data.reveal!.firstPlayer, match.viewFor(Player.P1, now).battle!.opponentHidden[0], now);
    }
    expect(match.data.phase).toBe('summary');
    expect(match.viewFor(Player.P2, now).lastRound).not.toBeNull();
    match.ready(Player.P1, now);
    expect(match.data.phase).toBe('summary');
    match.ready(Player.P2, now);
    expect(match.data.phase).toBe('draft');
    expect(match.data.round).toBe(2);
    expect(match.firstPlayer()).toBe(Player.P2); // first player alternates
    draftAll(match, now);
    while (match.data.phase === 'battle') {
      now = Math.max(now, match.data.turnStartsAt!);
      match.play(match.data.reveal!.firstPlayer, match.viewFor(Player.P1, now).battle!.opponentHidden[0], now);
    }
    const summaryDeadline = match.data.summaryDeadline!;
    expect(summaryDeadline).toBe(now + LANE_REVEAL_PAUSE_MS + SUMMARY_SECONDS * 1000);
    match.tick(summaryDeadline);
    expect(match.data.round).toBe(3);
  });
});
