import { describe, expect, it } from 'vitest';
import { FIRST_ROUND_INTRO_MS, OnlineMatch, OnlineMatchData, REMATCH_SECONDS } from '../src/game/online/match';
import { Player } from '../src/game/rules';

let tokens = 0;
const newToken = () => `rt-${++tokens}`;

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

/** Two seated players; the match is played to the end on timeouts only. Returns the end time. */
function finishedMatch(seed = 5) {
  const match = OnlineMatch.create('R3MX', seeded(seed));
  match.join('Alice', 'g:alice', null, newToken);
  match.join('Bob', 'g:bob', null, newToken);
  match.startIfReady(0);
  let now = 0;
  for (let step = 0; step < 300 && match.data.phase !== 'matchEnd'; step++) {
    now = match.nextDeadline()!;
    match.tick(now);
  }
  expect(match.data.phase).toBe('matchEnd');
  return { match, end: now };
}

describe('rematch', () => {
  it('opens a 60s rematch offer when a match finishes normally', () => {
    const { match, end } = finishedMatch();
    const view = match.viewFor(Player.P1, end);
    expect(view.rematch).toEqual({
      you: false, opponent: false, opponentLeft: false, deadline: end + REMATCH_SECONDS * 1000, closed: false,
    });
    expect(match.nextDeadline()).toBe(end + REMATCH_SECONDS * 1000);
  });

  it('tells the other side, and starts a fresh Bo3 in the same room when both ask', () => {
    const { match, end } = finishedMatch(6);
    const before = { seats: JSON.stringify(match.data.seats), code: match.data.roomCode };
    expect(match.rematch(Player.P1, end + 1000)).toBeNull();
    expect(match.viewFor(Player.P2, end + 1000).rematch).toMatchObject({ you: false, opponent: true });
    expect(match.viewFor(Player.P1, end + 1000).rematch).toMatchObject({ you: true, opponent: false });
    expect(match.data.phase).toBe('matchEnd');

    expect(match.rematch(Player.P2, end + 2000)).toBeNull();
    expect(match.data.phase).toBe('battle');
    expect(match.data.round).toBe(1);
    expect(match.data.p1RoundWins + match.data.p2RoundWins).toBe(0);
    expect(match.data.p1UsedCardIds).toEqual([]);
    expect(match.data.p2UsedCardIds).toEqual([]);
    expect(match.data.roundResults).toEqual([]);
    expect(match.data.matchWinner).toBeNull();
    expect(match.data.resultRecorded).toBe(false);
    expect(match.data.play!.red[Player.P1]).toHaveLength(0);
    expect(match.data.turnStartsAt).toBe(end + 2000 + FIRST_ROUND_INTRO_MS);
    expect(JSON.stringify(match.data.seats)).toBe(before.seats);
    expect(match.data.roomCode).toBe(before.code);
    const view = match.viewFor(Player.P1, end + 2000);
    expect(view.rematch).toBeNull();
    expect(view.lastRound).toBeNull();
    expect(view.usedCardIds).toEqual([]);
  });

  it('the second match plays to the end and records results again', () => {
    const { match, end } = finishedMatch(7);
    match.rematch(Player.P1, end);
    match.rematch(Player.P2, end);
    let now = end;
    for (let step = 0; step < 300 && match.data.phase !== 'matchEnd'; step++) {
      now = match.nextDeadline()!;
      match.tick(now);
    }
    expect(match.data.phase).toBe('matchEnd');
    expect(match.data.roundResults).toHaveLength(3);
    expect(new Set(match.data.p1UsedCardIds).size).toBe(15);
    expect(match.outcomes()).toHaveLength(2);
    expect(match.viewFor(Player.P2, now).rematch).toMatchObject({ you: false, opponent: false, closed: false });
  });

  it('when one side goes back to the lobby the other sees it and cannot rematch', () => {
    const { match, end } = finishedMatch(8);
    match.rematch(Player.P1, end);
    expect(match.leave(Player.P2, end + 10)).toBeNull();
    expect(match.viewFor(Player.P1, end + 10).rematch).toMatchObject({ opponentLeft: true });
    expect(match.rematch(Player.P1, end + 20)).toBe('OPPONENT_LEFT');
    expect(match.data.phase).toBe('matchEnd');
    // Leaving withdraws your own request, and the result of the finished match stays as it was.
    expect(match.data.forfeitedBy ?? null).toBeNull();
  });

  it('a disconnected opponent counts as gone', () => {
    const { match, end } = finishedMatch(9);
    match.setConnected(Player.P2, false);
    expect(match.viewFor(Player.P1, end).rematch).toMatchObject({ opponentLeft: true });
    expect(match.rematch(Player.P1, end)).toBe('OPPONENT_LEFT');
    match.setConnected(Player.P2, true);
    expect(match.rematch(Player.P1, end)).toBeNull();
  });

  it('expires after 60s: the offer closes and no rematch is possible', () => {
    const { match, end } = finishedMatch(10);
    match.rematch(Player.P1, end);
    const deadline = end + REMATCH_SECONDS * 1000;
    match.tick(deadline - 1);
    expect(match.viewFor(Player.P1, deadline - 1).rematch?.closed).toBe(false);
    expect(match.tick(deadline)).toBe(true);
    const view = match.viewFor(Player.P2, deadline);
    expect(view.rematch).toMatchObject({ closed: true, deadline: null, opponent: false });
    expect(match.nextDeadline()).toBeNull();
    expect(match.rematch(Player.P2, deadline + 1)).toBe('REMATCH_EXPIRED');
  });

  it('no rematch after a forfeit (forfeit behaviour unchanged)', () => {
    const match = OnlineMatch.create('F0RF', seeded(11));
    match.join('Alice', null, null, newToken);
    match.join('Bob', null, null, newToken);
    match.startIfReady(0);
    match.leave(Player.P1, FIRST_ROUND_INTRO_MS);
    expect(match.data.phase).toBe('matchEnd');
    expect(match.data.matchWinner).toBe(Player.P2);
    expect(match.viewFor(Player.P2, FIRST_ROUND_INTRO_MS).rematch).toBeNull();
    expect(match.rematch(Player.P2, FIRST_ROUND_INTRO_MS)).toBe('NO_REMATCH');
  });

  it('rooms saved before rematch existed do not crash', () => {
    const { match, end } = finishedMatch(12);
    const old = JSON.parse(JSON.stringify(match.data)) as OnlineMatchData;
    delete old.rematch;
    delete old.leftAfterMatch;
    delete old.rematchDeadline;
    delete old.rematchClosed;
    const restored = new OnlineMatch(old, seeded(1));
    expect(restored.viewFor(Player.P1, end).rematch).toBeNull();
    expect(restored.rematch(Player.P1, end)).toBe('NO_REMATCH');
    expect(restored.leave(Player.P2, end)).toBeNull();
    expect(restored.nextDeadline()).toBeNull();
    expect(restored.tick(end + 999999)).toBe(false);
  });

  it('rematch is rejected outside matchEnd', () => {
    const match = OnlineMatch.create('W8NG', seeded(13));
    match.join('Alice', null, null, newToken);
    match.join('Bob', null, null, newToken);
    match.startIfReady(0);
    expect(match.rematch(Player.P1, 10)).toBe('NO_REMATCH');
    expect(match.data.phase).toBe('battle');
  });
});
