import { describe, expect, it } from 'vitest';
import { OnlineMatch, FIRST_ROUND_INTRO_MS, SUMMARY_SECONDS } from '../src/game/online/match';
import {
  BATTLE_TURN_SECONDS,
  cardById,
  Lane,
  LANE_ORDER,
  LANE_REVEAL_PAUSE_MS,
  OFFERS_PER_LANE,
  Player,
  otherPlayer,
} from '../src/game/rules';

let tokenCounter = 0;
const newToken = () => `token-${++tokenCounter}`;

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function seatedMatch(now = 0, seed = 7) {
  const random = seeded(seed);
  const match = OnlineMatch.create('A7K2', random);
  const p1 = match.join('Alice', 'g:alice', null, newToken);
  const p2 = match.join('Bob', null, null, newToken);
  if (!p1.ok || !p2.ok) throw new Error('join failed');
  match.startIfReady(now);
  return { match, p1, p2 };
}

/** Ids `viewer` may legitimately see: own offers/played cards plus everything in resolved lanes. */
function allowedIds(match: OnlineMatch, viewer: Player): Set<string> {
  const play = match.data.play!;
  const ids = new Set<string>([...play.offers[viewer], ...play.played[viewer], ...match.data[viewer === Player.P1 ? 'p1UsedCardIds' : 'p2UsedCardIds']]);
  for (const result of play.results) {
    ids.add(result.p1Card.id);
    ids.add(result.p2Card.id);
    for (const link of [...result.p1Synergy.links, ...result.p2Synergy.links]) ids.add(link.card.id);
  }
  return ids;
}

/** The opponent's current offers and pick must never appear in `viewer`'s serialized view. */
function expectNoLeak(match: OnlineMatch, viewer: Player, now: number): number {
  const play = match.data.play;
  if (!play || match.data.phase !== 'battle') return 0;
  const serialized = JSON.stringify(match.viewFor(viewer, now));
  const allowed = allowedIds(match, viewer);
  const opponent = otherPlayer(viewer);
  let checks = 0;
  for (const id of [...play.offers[opponent], play.picks[opponent]]) {
    if (!id || allowed.has(id)) continue;
    expect(serialized).not.toContain(`"${id}"`);
    checks++;
  }
  return checks;
}

/** Both players pick their first offered card for the current lane. */
function playLane(match: OnlineMatch, now: number) {
  for (const player of [Player.P1, Player.P2]) {
    const view = match.viewFor(player, now);
    expect(match.pick(player, view.battle!.myOffer[0], now)).toBeNull();
  }
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

  it('starts the round only when both seats are filled', () => {
    const match = OnlineMatch.create('B2C3');
    match.join('Solo', null, null, newToken);
    expect(match.startIfReady(0)).toBe(false);
    expect(match.data.phase).toBe('waiting');
  });
});

describe('lane-by-lane dealing', () => {
  it('deals each player their own two Top cards with no draft phase', () => {
    const { match } = seatedMatch();
    expect(match.data.phase).toBe('battle');
    for (const player of [Player.P1, Player.P2]) {
      const battle = match.viewFor(player, 0).battle!;
      expect(battle.currentLane).toBe(Lane.Top);
      expect(battle.myOffer).toHaveLength(OFFERS_PER_LANE);
      expect(new Set(battle.myOffer).size).toBe(OFFERS_PER_LANE);
      for (const id of battle.myOffer) expect(cardById(id)!.lanes).toContain(Lane.Top);
      expect(battle.myPick).toBeNull();
      expect(battle.opponentPicked).toBe(false);
    }
  });

  it('rejects a card that was not offered and a second pick in the same lane', () => {
    const { match } = seatedMatch();
    const offer = match.viewFor(Player.P1, 0).battle!.myOffer;
    const notOffered = match.data.play!.offers[Player.P2].find(id => !offer.includes(id)) ?? 'not_a_card';
    expect(match.pick(Player.P1, notOffered, 0)).toBe('INVALID_PICK');
    expect(match.pick(Player.P1, offer[1], 0)).toBeNull();
    expect(match.pick(Player.P1, offer[0], 0)).toBe('ALREADY_PICKED');
    expect(match.viewFor(Player.P1, 0).battle!.myPick).toBe(offer[1]);
  });

  it('resolves the lane when both have picked, then deals the next lane after the pause', () => {
    const { match } = seatedMatch();
    const now = FIRST_ROUND_INTRO_MS + 1000;
    playLane(match, now);
    const battle = match.viewFor(Player.P1, now).battle!;
    expect(battle.revealed).toHaveLength(1);
    expect(battle.revealed[0].lane).toBe(Lane.Top);
    expect(battle.currentLane).toBe(Lane.Jungle);
    expect(battle.myCards.Top).toBe(battle.revealed[0].p1Card.id);
    expect(match.data.turnStartsAt).toBe(now + LANE_REVEAL_PAUSE_MS);
    expect(match.data.turnDeadline).toBe(now + LANE_REVEAL_PAUSE_MS + BATTLE_TURN_SECONDS * 1000);
  });
});

describe('hidden picks never leak', () => {
  it('hides the opponent\'s offers and pick until the lane resolves', () => {
    const { match } = seatedMatch();
    expect(expectNoLeak(match, Player.P1, 0)).toBeGreaterThan(0);
    expect(expectNoLeak(match, Player.P2, 0)).toBeGreaterThan(0);
    const p2Pick = match.data.play!.offers[Player.P2][1];
    match.pick(Player.P2, p2Pick, 0);
    const p1View = match.viewFor(Player.P1, 0);
    expect(p1View.battle!.opponentPicked).toBe(true);
    if (!allowedIds(match, Player.P1).has(p2Pick)) expect(JSON.stringify(p1View)).not.toContain(`"${p2Pick}"`);
    expect(match.viewFor(Player.P2, 0).battle!.myPick).toBe(p2Pick);
    expect(p1View.usedCardIds).toEqual([]);
  });

  it('never leaks across a whole best-of-3', () => {
    const { match } = seatedMatch(0, 99);
    let now = 0;
    let checks = 0;
    for (let step = 0; step < 400 && match.data.phase !== 'matchEnd'; step++) {
      checks += expectNoLeak(match, Player.P1, now) + expectNoLeak(match, Player.P2, now);
      if (match.data.phase === 'battle') {
        // P1 acts at once; P2 is checked again after P1 locks in, then picks.
        const p1 = match.viewFor(Player.P1, now).battle!;
        if (!p1.myPick) match.pick(Player.P1, p1.myOffer[1] ?? p1.myOffer[0], now);
        checks += expectNoLeak(match, Player.P1, now) + expectNoLeak(match, Player.P2, now);
        const p2 = match.viewFor(Player.P2, now).battle!;
        if (match.data.phase === 'battle' && !p2.myPick) match.pick(Player.P2, p2.myOffer[0], now);
        now += 1000;
      } else if (match.data.phase === 'summary') {
        match.ready(Player.P1, now);
        match.ready(Player.P2, now);
      }
    }
    expect(match.data.phase).toBe('matchEnd');
    expect(checks).toBeGreaterThan(30);
  });
});

describe('server-enforced timers', () => {
  it('auto-picks for whoever has not picked when the 20s clock expires', () => {
    const { match } = seatedMatch(0);
    const deadline = match.data.turnDeadline!;
    expect(deadline).toBe(FIRST_ROUND_INTRO_MS + BATTLE_TURN_SECONDS * 1000);
    const chosen = match.data.play!.offers[Player.P1][0];
    match.pick(Player.P1, chosen, 1000);
    expect(match.tick(deadline - 1)).toBe(false);
    expect(match.tick(deadline)).toBe(true);
    const result = match.data.play!.results[0];
    expect(result.p1Card.id).toBe(chosen);
    expect(match.data.play!.played[Player.P2]).toHaveLength(1);
    expect(match.data.turnDeadline).toBe(deadline + LANE_REVEAL_PAUSE_MS + BATTLE_TURN_SECONDS * 1000);
  });

  it('finishes a whole best-of-3 with nobody acting, using only timeouts', () => {
    const { match } = seatedMatch(0);
    for (let step = 0; step < 200 && match.data.phase !== 'matchEnd'; step++) {
      match.tick(match.nextDeadline()!);
    }
    expect(match.data.phase).toBe('matchEnd');
    expect(match.data.roundResults).toHaveLength(3);
    // Fearless: each side plays 15 unique cards (mirrors between sides are allowed).
    expect(new Set(match.data.p1UsedCardIds).size).toBe(15);
    expect(new Set(match.data.p2UsedCardIds).size).toBe(15);
    expect(match.outcomes().map(o => o.accountId)).toEqual(['g:alice']);
  });

  it('never deals a card the player already played this match', () => {
    const { match } = seatedMatch(0, 3);
    const seen: Record<Player, Set<string>> = { [Player.P1]: new Set(), [Player.P2]: new Set() } as Record<Player, Set<string>>;
    for (let step = 0; step < 200 && match.data.phase !== 'matchEnd'; step++) {
      const play = match.data.play!;
      if (match.data.phase === 'battle') {
        for (const player of [Player.P1, Player.P2]) {
          for (const id of play.offers[player]) expect(seen[player].has(id)).toBe(false);
        }
      }
      match.tick(match.nextDeadline()!);
      for (const result of match.data.play!.results) {
        seen[Player.P1].add(result.p1Card.id);
        seen[Player.P2].add(result.p2Card.id);
      }
    }
    expect(match.data.phase).toBe('matchEnd');
  });

  it('moves to the next round when both players are ready or the summary timer ends', () => {
    const { match } = seatedMatch(0);
    let now = 10_000;
    while (match.data.phase === 'battle') {
      playLane(match, now);
      now += 1000;
    }
    expect(match.data.phase).toBe('summary');
    const last = match.viewFor(Player.P2, now).lastRound!;
    expect(last.laneResults.map(r => r.lane)).toEqual(LANE_ORDER);
    match.ready(Player.P1, now);
    expect(match.data.phase).toBe('summary');
    match.ready(Player.P2, now);
    expect(match.data.phase).toBe('battle');
    expect(match.data.round).toBe(2);
    expect(match.firstPlayer()).toBe(otherPlayer(match.data.round1FirstPlayer)); // lead alternates
    while (match.data.phase === 'battle') {
      playLane(match, now);
      now += 1000;
    }
    now -= 1000;
    const summaryDeadline = match.data.summaryDeadline!;
    expect(summaryDeadline).toBe(now + LANE_REVEAL_PAUSE_MS + SUMMARY_SECONDS * 1000);
    match.tick(summaryDeadline);
    expect(match.data.round).toBe(3);
  });
});
