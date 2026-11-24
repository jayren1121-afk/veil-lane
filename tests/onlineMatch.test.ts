import { describe, expect, it } from 'vitest';
import { OnlineMatch, FIRST_ROUND_INTRO_MS, SUMMARY_SECONDS } from '../src/game/online/match';
import {
  BATTLE_TURN_SECONDS,
  cardById,
  Lane,
  LANE_ORDER,
  LANE_REVEAL_PAUSE_MS,
  OFFERS_PER_LANE,
  partnerOptions,
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

/** Ids `viewer` may legitimately see: own hand/played/Fearless cards plus everything in resolved lanes. */
function allowedIds(match: OnlineMatch, viewer: Player): Set<string> {
  const play = match.data.play!;
  const ids = new Set<string>([...play.hands[viewer].flat(), ...play.played[viewer], ...match.data[viewer === Player.P1 ? 'p1UsedCardIds' : 'p2UsedCardIds']]);
  for (const result of play.results) {
    ids.add(result.p1Card.id);
    ids.add(result.p2Card.id);
    for (const link of [...result.p1Synergy.links, ...result.p2Synergy.links]) ids.add(link.card.id);
  }
  return ids;
}

/** The opponent's hand, current main card and partner must never appear in `viewer`'s serialized view. */
function expectNoLeak(match: OnlineMatch, viewer: Player, now: number): number {
  const play = match.data.play;
  if (!play || match.data.phase !== 'battle') return 0;
  const serialized = JSON.stringify(match.viewFor(viewer, now));
  const allowed = allowedIds(match, viewer);
  const opponent = otherPlayer(viewer);
  let checks = 0;
  for (const id of [...play.hands[opponent].flat(), play.mains[opponent], play.partners[opponent]]) {
    if (!id || allowed.has(id)) continue;
    expect(serialized).not.toContain(`"${id}"`);
    checks++;
  }
  return checks;
}

/** `player` plays main card `choice` for the current lane, then the best partner if asked to choose. */
function playTurn(match: OnlineMatch, player: Player, now: number, choice = 0) {
  const battle = match.viewFor(player, now).battle!;
  const main = battle.myHand[battle.laneIndex][choice];
  expect(match.pick(player, main, now)).toBeNull();
  if (match.data.phase !== 'battle') return;
  const after = match.viewFor(player, now).battle!;
  if (after.needPartner) expect(match.partner(player, after.myPartnerOptions[0], now)).toBeNull();
}

/** Both players finish the current lane. */
function playLane(match: OnlineMatch, now: number) {
  playTurn(match, Player.P1, now);
  playTurn(match, Player.P2, now);
}

/** A seated match (P1 has played main 0 + best partner so far) at a lane where P1's main `choice` has 2+ partners. */
function matchNeedingPartner(choice = 0) {
  for (let seed = 1; seed < 3000; seed++) {
    const { match } = seatedMatch(0, seed);
    let now = FIRST_ROUND_INTRO_MS;
    while (match.data.phase === 'battle') {
      const play = match.data.play!;
      const main = play.hands[Player.P1][play.laneIndex][choice];
      if (partnerOptions(play, Player.P1, main).length >= 2) return { match, now, main };
      playLane(match, now);
      now += 1000;
    }
  }
  throw new Error('no partner choice found');
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

describe('10-card hands', () => {
  it('deals each player their own whole hand (2 cards per lane) with no draft phase', () => {
    const { match } = seatedMatch();
    expect(match.data.phase).toBe('battle');
    for (const player of [Player.P1, Player.P2]) {
      const battle = match.viewFor(player, 0).battle!;
      expect(battle.currentLane).toBe(Lane.Top);
      expect(battle.myHand).toHaveLength(5);
      expect(new Set(battle.myHand.flat()).size).toBe(10);
      battle.myHand.forEach((ids, index) => {
        expect(ids).toHaveLength(OFFERS_PER_LANE);
        for (const id of ids) expect(cardById(id)!.lanes).toContain(LANE_ORDER[index]);
      });
      expect(battle.myMain).toBeNull();
      expect(battle.needPartner).toBe(false);
      expect(battle.myRed).toEqual([]);
      expect(battle.opponentLocked).toBe(false);
    }
  });

  it('rejects a main card outside the current lane\'s two, and a second main pick', () => {
    const { match } = seatedMatch();
    const hand = match.viewFor(Player.P1, 0).battle!.myHand;
    expect(match.pick(Player.P1, hand[2][0], 0)).toBe('INVALID_PICK');
    const notMine = match.data.play!.hands[Player.P2][0].find(id => !hand[0].includes(id)) ?? 'not_a_card';
    expect(match.pick(Player.P1, notMine, 0)).toBe('INVALID_PICK');
    expect(match.pick(Player.P1, hand[0][1], 0)).toBeNull();
    expect(match.pick(Player.P1, hand[0][0], 0)).toBe('ALREADY_PICKED');
    expect(match.viewFor(Player.P1, 0).battle!.myMain).toBe(hand[0][1]);
  });

  it('resolves the lane when both are done, then opens the next lane after the pause', () => {
    const { match } = seatedMatch();
    const now = FIRST_ROUND_INTRO_MS + 1000;
    playLane(match, now);
    const battle = match.viewFor(Player.P1, now).battle!;
    expect(battle.revealed).toHaveLength(1);
    expect(battle.revealed[0].lane).toBe(Lane.Top);
    expect(battle.currentLane).toBe(Lane.Jungle);
    expect(battle.myCards.Top).toBe(battle.revealed[0].p1Card.id);
    expect(battle.myHand.flat()).toHaveLength(10); // the hand stays the same all round
    expect(match.data.turnStartsAt).toBe(now + LANE_REVEAL_PAUSE_MS);
    expect(match.data.turnDeadline).toBe(now + LANE_REVEAL_PAUSE_MS + BATTLE_TURN_SECONDS * 1000);
  });
});

describe('partner choice online', () => {
  it('asks for one partner when there are 2+, and counts only that one', () => {
    const { match, now, main } = matchNeedingPartner();
    expect(match.pick(Player.P1, main, now)).toBeNull();
    const battle = match.viewFor(Player.P1, now).battle!;
    expect(battle.needPartner).toBe(true);
    expect(battle.myPartnerOptions.length).toBeGreaterThanOrEqual(2);
    // P1 is not done yet, so P2 sees "not locked".
    expect(match.viewFor(Player.P2, now).battle!.opponentLocked).toBe(false);
    const notOption = battle.myHand.flat().find(id => id !== main && !battle.myPartnerOptions.includes(id))!;
    expect(match.partner(Player.P1, notOption, now)).toBe('INVALID_PARTNER');
    const chosen = battle.myPartnerOptions[1];
    expect(match.partner(Player.P1, chosen, now)).toBeNull();
    expect(match.partner(Player.P1, battle.myPartnerOptions[0], now)).toBe('ALREADY_PICKED');
    expect(match.viewFor(Player.P2, now).battle!.opponentLocked).toBe(true);
    const laneCount = match.data.play!.results.length;
    playTurn(match, Player.P2, now);
    const result = match.data.play!.results[laneCount];
    expect(result.p1Card.id).toBe(main);
    expect(result.p1Synergy.links.map(link => link.card.id)).toEqual([chosen]);
    expect(match.viewFor(Player.P1, now).battle!.myRed).toContain(chosen);
  });

  it('on timeout fills in the highest-% partner for a locked main card', () => {
    const { match, now, main } = matchNeedingPartner();
    match.pick(Player.P1, main, now);
    const best = match.viewFor(Player.P1, now).battle!.myPartnerOptions[0];
    const laneCount = match.data.play!.results.length;
    expect(match.tick(match.data.turnDeadline!)).toBe(true);
    const result = match.data.play!.results[laneCount];
    expect(result.p1Card.id).toBe(main);
    expect(result.p1Synergy.links[0].card.id).toBe(best);
  });
});

describe('hidden information never leaks', () => {
  it('hides the opponent\'s hand, main card and partner until the lane flips', () => {
    const { match } = seatedMatch();
    expect(expectNoLeak(match, Player.P1, 0)).toBeGreaterThan(5);
    expect(expectNoLeak(match, Player.P2, 0)).toBeGreaterThan(5);
    const p2Main = match.data.play!.hands[Player.P2][0][1];
    match.pick(Player.P2, p2Main, 0);
    const p1View = match.viewFor(Player.P1, 0);
    expect(p1View.battle!.opponentLocked).toBe(match.data.play!.partnerDone[Player.P2]);
    if (!allowedIds(match, Player.P1).has(p2Main)) expect(JSON.stringify(p1View)).not.toContain(`"${p2Main}"`);
    expect(match.viewFor(Player.P2, 0).battle!.myMain).toBe(p2Main);
    expect(p1View.usedCardIds).toEqual([]);
    expectNoLeak(match, Player.P1, 0);
  });

  it('keeps a pending partner choice hidden too', () => {
    const { match, now, main } = matchNeedingPartner();
    match.pick(Player.P1, main, now);
    match.partner(Player.P1, match.viewFor(Player.P1, now).battle!.myPartnerOptions[1], now);
    expect(expectNoLeak(match, Player.P2, now)).toBeGreaterThan(0);
  });

  it('never leaks across a whole best-of-3', () => {
    const { match } = seatedMatch(0, 99);
    let now = 0;
    let checks = 0;
    for (let step = 0; step < 400 && match.data.phase !== 'matchEnd'; step++) {
      checks += expectNoLeak(match, Player.P1, now) + expectNoLeak(match, Player.P2, now);
      if (match.data.phase === 'battle') {
        // P1 acts at once; P2 is checked again after P1 locks in, then plays.
        const p1 = match.viewFor(Player.P1, now).battle!;
        if (!p1.myMain) playTurn(match, Player.P1, now, 1);
        checks += expectNoLeak(match, Player.P1, now) + expectNoLeak(match, Player.P2, now);
        const p2 = match.viewFor(Player.P2, now).battle!;
        if (match.data.phase === 'battle' && !p2.myMain) playTurn(match, Player.P2, now);
        now += 1000;
      } else if (match.data.phase === 'summary') {
        match.ready(Player.P1, now);
        match.ready(Player.P2, now);
      }
    }
    expect(match.data.phase).toBe('matchEnd');
    expect(checks).toBeGreaterThan(100);
  });
});

describe('server-enforced timers', () => {
  it('auto-plays for whoever is not done when the 20s clock expires', () => {
    const { match } = seatedMatch(0);
    const deadline = match.data.turnDeadline!;
    expect(deadline).toBe(FIRST_ROUND_INTRO_MS + BATTLE_TURN_SECONDS * 1000);
    const chosen = match.data.play!.hands[Player.P1][0][0];
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
      if (match.data.phase === 'battle' && play.results.length === 0) {
        // A new round's hand never holds a main card played in an earlier round.
        for (const player of [Player.P1, Player.P2]) {
          for (const id of play.hands[player].flat()) expect(seen[player].has(id)).toBe(false);
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
