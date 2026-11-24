import { describe, it, expect } from 'vitest';
import {
  autoCompletePick,
  bothReady,
  cardById,
  createMatchState,
  createRoundPlay,
  currentOffer,
  currentPlayLane,
  dealHand,
  eligiblePartners,
  handToPlacements,
  dealLaneOffer,
  GamePhase,
  getScoreString,
  isMatchOver,
  isPlayerReady,
  isRoundPlayComplete,
  Lane,
  LANE_ORDER,
  OFFERS_PER_LANE,
  partnerOptions,
  submitPartnerPicks,
  Player,
  recordRoundResult,
  resolveCurrentLane,
  resolveRound,
  RoundPlay,
  submitMainPick,
  submitPartnerPick,
  summarizeRound,
  usedCardIdsFor,
} from '../src/game/rules';
import { CARDS } from '../src/game/data/cards';

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

const noneUsed = () => ({ [Player.P1]: [] as string[], [Player.P2]: [] as string[] }) as Record<Player, string[]>;

/** Finish the current lane for `player`: main card at `choice`, then the best partner if a choice is needed. */
function finishTurn(play: RoundPlay, player: Player, choice = 0) {
  const offer = currentOffer(play, player);
  expect(submitMainPick(play, player, offer[Math.min(choice, offer.length - 1)])).toBeNull();
  if (!play.partnerDone[player]) {
    expect(submitPartnerPick(play, player, partnerOptions(play, player, play.mains[player]!)[0].card.id)).toBeNull();
  }
}

/** Play a full local round, always taking the main card at `choice`. */
function playRound(state: ReturnType<typeof createMatchState>, random: () => number, choice = 0) {
  const play = createRoundPlay(state.currentRound, {
    [Player.P1]: state.p1UsedCardIds,
    [Player.P2]: state.p2UsedCardIds,
  } as Record<Player, Set<string>>, random);
  while (!isRoundPlayComplete(play)) {
    finishTurn(play, Player.P1, choice);
    finishTurn(play, Player.P2, choice);
    expect(resolveCurrentLane(play)).not.toBeNull();
  }
  const result = summarizeRound(play.results);
  recordRoundResult(state, result);
  return { play, result };
}

/**
 * Search seeded rounds (playing main 0 + best partner) until `found` holds at the start of a
 * lane; returns that live round. Real GRID data decides how often partners exist.
 */
function findLane(found: (play: RoundPlay) => boolean, maxSeeds = 4000): RoundPlay {
  for (let seed = 1; seed < maxSeeds; seed++) {
    const play = createRoundPlay(1, noneUsed(), seeded(seed));
    while (!isRoundPlayComplete(play)) {
      if (found(play)) return play;
      finishTurn(play, Player.P1);
      finishTurn(play, Player.P2);
      resolveCurrentLane(play);
    }
  }
  throw new Error('no matching lane found');
}

const optionCounts = (play: RoundPlay, player: Player) =>
  currentOffer(play, player).map(id => partnerOptions(play, player, id).length);

describe('Match Engine', () => {
  it('creates an empty match state with no draft phase', () => {
    const state = createMatchState();
    expect(state.currentRound).toBe(1);
    expect(state.p1RoundWins).toBe(0);
    expect(state.p2RoundWins).toBe(0);
    expect(state.matchWinner).toBeNull();
    expect(state.phase).toBe(GamePhase.Place);
    expect(state.p1UsedCardIds.size).toBe(0);
  });

  it('getScoreString returns correct format', () => {
    const state = createMatchState();
    expect(getScoreString(state)).toBe('P1: 0 - P2: 0');
    state.p1RoundWins = 1;
    state.p2RoundWins = 1;
    expect(getScoreString(state)).toBe('P1: 1 - P2: 1');
  });

  it('treats a completed tied match as over', () => {
    const state = createMatchState(1);
    expect(isMatchOver(state)).toBe(false);
    state.currentRound = 3;
    state.phase = GamePhase.MatchEnd;
    state.matchWinner = null;
    expect(isMatchOver(state)).toBe(true);
  });
});

describe('dealing the 10-card hand', () => {
  it('deals two distinct cards that are legal in the lane and not blocked', () => {
    const blocked = CARDS.filter(card => card.lanes.includes(Lane.Top)).slice(0, 5).map(card => card.id);
    for (let seed = 1; seed < 30; seed++) {
      const offer = dealLaneOffer(Lane.Top, blocked, seeded(seed));
      expect(offer).toHaveLength(OFFERS_PER_LANE);
      expect(new Set(offer).size).toBe(OFFERS_PER_LANE);
      for (const id of offer) {
        expect(cardById(id)!.lanes).toContain(Lane.Top);
        expect(blocked).not.toContain(id);
      }
    }
  });

  it('deals a full hand of 10 distinct cards, 2 legal cards per lane, skipping excluded ones', () => {
    for (let seed = 1; seed < 40; seed++) {
      const excluded = CARDS.slice(seed, seed + 15).map(card => card.id);
      const hand = dealHand(excluded, seeded(seed));
      expect(hand).toHaveLength(5);
      const all = hand.flat();
      expect(all).toHaveLength(10);
      expect(new Set(all).size).toBe(10);
      hand.forEach((ids, index) => {
        expect(ids).toHaveLength(2);
        for (const id of ids) expect(cardById(id)!.lanes).toContain(LANE_ORDER[index]);
      });
      for (const id of all) expect(excluded).not.toContain(id);
    }
  });

  it('gives each player their own whole hand at the start of the round', () => {
    let differed = false;
    for (let seed = 1; seed < 20; seed++) {
      const play = createRoundPlay(1, noneUsed(), seeded(seed));
      expect(currentPlayLane(play)).toBe(Lane.Top);
      expect(play.hands[Player.P1].flat()).toHaveLength(10);
      expect(play.hands[Player.P2].flat()).toHaveLength(10);
      expect(currentOffer(play, Player.P1)).toEqual(play.hands[Player.P1][0]);
      if (play.hands[Player.P1].flat().join() !== play.hands[Player.P2].flat().join()) differed = true;
    }
    expect(differed).toBe(true);
  });
});

describe('main card pick', () => {
  it('only accepts one of the current lane\'s two cards from the player\'s own hand, once', () => {
    const play = createRoundPlay(1, noneUsed(), seeded(5));
    const laterCard = play.hands[Player.P1][3][0];
    const foreign = CARDS.find(card => card.lanes.includes(Lane.Top) && !play.hands[Player.P1].flat().includes(card.id))!;
    expect(submitMainPick(play, Player.P1, laterCard)).toBe('INVALID_PICK');
    expect(submitMainPick(play, Player.P1, foreign.id)).toBe('INVALID_PICK');
    expect(submitPartnerPick(play, Player.P1, laterCard)).toBe('NO_MAIN');
    expect(submitMainPick(play, Player.P1, currentOffer(play, Player.P1)[0])).toBeNull();
    expect(submitMainPick(play, Player.P1, currentOffer(play, Player.P1)[1])).toBe('ALREADY_PICKED');
    expect(bothReady(play)).toBe(false);
    expect(resolveCurrentLane(play)).toBeNull();
  });

  it('plays the five lanes in order; lane total = matchup + partner only (no order bonus)', () => {
    const play = createRoundPlay(1, noneUsed(), seeded(11));
    const lanes: Lane[] = [];
    while (!isRoundPlayComplete(play)) {
      lanes.push(currentPlayLane(play)!);
      finishTurn(play, Player.P1, 0);
      finishTurn(play, Player.P2, 1);
      const result = resolveCurrentLane(play)!;
      expect(result.p1Total).toBeCloseTo(result.p1WinRate + result.p1Synergy.bonus, 10);
      expect(result.p2Total).toBeCloseTo(result.p2WinRate + result.p2Synergy.bonus, 10);
      expect(result.p1Synergy.links.length).toBeLessThanOrEqual(1);
      expect(result.p2Synergy.links.length).toBeLessThanOrEqual(1);
    }
    expect(lanes).toEqual(LANE_ORDER);
    expect(play.results.every(result => !('orderBonus' in result))).toBe(true);
    expect(play.played[Player.P1]).toEqual(play.hands[Player.P1].map(ids => ids[0]));
  });
});

describe('synergy partner from the whole hand', () => {
  it('offers partners from other lanes of the hand only, played or not yet played, best first', () => {
    let checked = 0;
    for (let seed = 1; seed < 600; seed++) {
      const play = createRoundPlay(1, noneUsed(), seeded(seed));
      while (!isRoundPlayComplete(play)) {
        for (const id of currentOffer(play, Player.P1)) {
          const options = partnerOptions(play, Player.P1, id);
          for (const link of options) {
            expect(link.card.id).not.toBe(id);
            expect(currentOffer(play, Player.P1)).not.toContain(link.card.id);
            expect(play.hands[Player.P1][LANE_ORDER.indexOf(link.lane)]).toContain(link.card.id);
            expect(link.lane).not.toBe(currentPlayLane(play));
            checked++;
          }
          options.forEach((link, index) => { if (index > 0) expect(link.bonus).toBeLessThanOrEqual(options[index - 1].bonus); });
        }
        finishTurn(play, Player.P1);
        finishTurn(play, Player.P2);
        resolveCurrentLane(play);
      }
    }
    expect(checked).toBeGreaterThan(0);
    // Partners can come from lanes not played yet (the hand is known from the start).
    const early = findLane(play => play.laneIndex === 0 && optionCounts(play, Player.P1).some(count => count > 0));
    const main = currentOffer(early, Player.P1).find(id => partnerOptions(early, Player.P1, id).length > 0)!;
    expect(partnerOptions(early, Player.P1, main).every(link => LANE_ORDER.indexOf(link.lane) > 0)).toBe(true);
  });

  it('skips the partner step with no partners; a single partner is a choice too (no auto-pick)', () => {
    const none = findLane(play => optionCounts(play, Player.P1).includes(0));
    const plain = currentOffer(none, Player.P1).find(id => partnerOptions(none, Player.P1, id).length === 0)!;
    expect(submitMainPick(none, Player.P1, plain)).toBeNull();
    expect(isPlayerReady(none, Player.P1)).toBe(true);
    expect(none.partners[Player.P1]).toEqual([]);

    const single = findLane(play => optionCounts(play, Player.P1).includes(1));
    const main = currentOffer(single, Player.P1).find(id => partnerOptions(single, Player.P1, id).length === 1)!;
    const only = partnerOptions(single, Player.P1, main)[0];
    expect(submitMainPick(single, Player.P1, main)).toBeNull();
    expect(isPlayerReady(single, Player.P1)).toBe(false);
    expect(single.partners[Player.P1]).toEqual([]);
    expect(submitPartnerPick(single, Player.P1, only.card.id)).toBeNull();
    expect(submitPartnerPick(single, Player.P1, only.card.id)).toBe('ALREADY_PICKED');
    finishTurn(single, Player.P2);
    const result = resolveCurrentLane(single)!;
    expect(result.p1Synergy).toEqual({ links: [only], bonus: only.bonus });
  });

  it('with 2+ partners the player picks any subset and the bonuses stack (sum)', () => {
    const play = findLane(p => optionCounts(p, Player.P1).some(count => count >= 2));
    const main = currentOffer(play, Player.P1).find(id => partnerOptions(play, Player.P1, id).length >= 2)!;
    const options = partnerOptions(play, Player.P1, main);
    expect(submitMainPick(play, Player.P1, main)).toBeNull();
    expect(isPlayerReady(play, Player.P1)).toBe(false);
    const notOption = play.hands[Player.P1].flat().find(id => id !== main && !options.some(link => link.card.id === id))!;
    expect(submitPartnerPick(play, Player.P1, notOption)).toBe('INVALID_PARTNER');
    expect(submitPartnerPicks(play, Player.P1, [options[0].card.id, notOption])).toBe('INVALID_PARTNER');
    expect(submitPartnerPicks(play, Player.P1, [options[0].card.id, options[0].card.id])).toBe('DUPLICATE_PARTNER');
    // Choose every option: all of them count.
    const chosen = options;
    expect(submitPartnerPicks(play, Player.P1, [...chosen].reverse().map(link => link.card.id))).toBeNull();
    expect(submitPartnerPicks(play, Player.P1, [])).toBe('ALREADY_PICKED');
    finishTurn(play, Player.P2);
    const result = resolveCurrentLane(play)!;
    const sum = chosen.reduce((total, link) => total + link.bonus, 0);
    expect(result.p1Synergy.links.map(link => link.card.id)).toEqual(chosen.map(link => link.card.id));
    expect(result.p1Synergy.bonus).toBeCloseTo(sum, 10);
    expect(result.p1Total).toBeCloseTo(result.p1WinRate + sum, 10);
    for (const link of chosen) expect(play.red[Player.P1]).toContain(link.card.id);
  });

  it('choosing no partners is allowed and adds nothing', () => {
    const play = findLane(p => optionCounts(p, Player.P1).some(count => count >= 1));
    const main = currentOffer(play, Player.P1).find(id => partnerOptions(play, Player.P1, id).length >= 1)!;
    expect(submitMainPick(play, Player.P1, main)).toBeNull();
    expect(submitPartnerPicks(play, Player.P1, [])).toBeNull();
    expect(isPlayerReady(play, Player.P1)).toBe(true);
    finishTurn(play, Player.P2);
    const redBefore = play.red[Player.P1].length;
    const result = resolveCurrentLane(play)!;
    expect(result.p1Synergy).toEqual({ links: [], bonus: 0 });
    expect(result.p1Total).toBeCloseTo(result.p1WinRate, 10);
    expect(play.red[Player.P1].length).toBe(redBefore);
  });

  it('on timeout picks a random main card, then only the single highest-% partner', () => {
    const play = findLane(p => optionCounts(p, Player.P1)[1] >= 2);
    expect(autoCompletePick(play, Player.P1, () => 0.99)).toBe(true);
    const main = currentOffer(play, Player.P1)[1];
    expect(play.mains[Player.P1]).toBe(main);
    expect(play.partners[Player.P1]).toEqual([partnerOptions(play, Player.P1, main)[0].card.id]);
    expect(isPlayerReady(play, Player.P1)).toBe(true);
    expect(autoCompletePick(play, Player.P1)).toBe(false);

    // Main already locked but partner still open: only the partner is filled in.
    const open = findLane(p => optionCounts(p, Player.P1)[0] >= 2);
    const lockedMain = currentOffer(open, Player.P1)[0];
    submitMainPick(open, Player.P1, lockedMain);
    autoCompletePick(open, Player.P1, () => 0.99);
    expect(open.mains[Player.P1]).toBe(lockedMain);
    expect(open.partners[Player.P1]).toEqual([partnerOptions(open, Player.P1, lockedMain)[0].card.id]);
  });
});

describe('synergy frequency', () => {
  it('most main cards in a dealt hand have a partner, and a good share have 2+ to choose from', () => {
    let mains = 0;
    let atLeastOne = 0;
    let twoOrMore = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const hand = handToPlacements(dealHand([], seeded(seed)));
      for (const main of hand) {
        const count = eligiblePartners(main.card, main.lane, hand).length;
        mains++;
        if (count >= 1) atLeastOne++;
        if (count >= 2) twoOrMore++;
      }
    }
    expect(atLeastOne / mains).toBeGreaterThan(0.6);
    expect(atLeastOne / mains).toBeLessThan(0.8);
    expect(twoOrMore / mains).toBeGreaterThan(0.25);
    expect(twoOrMore / mains).toBeLessThan(0.4);
  });
});

describe('red cards (used partners)', () => {
  it('a used partner turns red: never a partner again this round, still playable as main, reset next round', () => {
    // A lane where the main's best partner is a card dealt for a LATER lane, so it can become a main afterwards.
    const play = findLane(p => {
      const main = currentOffer(p, Player.P1)[0];
      const best = partnerOptions(p, Player.P1, main)[0];
      return Boolean(best) && LANE_ORDER.indexOf(best.lane) > p.laneIndex;
    });
    const main = currentOffer(play, Player.P1)[0];
    const partner = partnerOptions(play, Player.P1, main)[0];
    finishTurn(play, Player.P1, 0);
    expect(play.partners[Player.P1]).toEqual([partner.card.id]);
    finishTurn(play, Player.P2);
    resolveCurrentLane(play);
    expect(play.red[Player.P1]).toContain(partner.card.id);

    // From now on it is never offered as a partner, for any main card.
    let redLaneSeen = false;
    while (!isRoundPlayComplete(play)) {
      for (const id of currentOffer(play, Player.P1)) {
        expect(partnerOptions(play, Player.P1, id).map(link => link.card.id)).not.toContain(partner.card.id);
      }
      if (currentPlayLane(play) === partner.lane) {
        // Its own lane: the red card can still be played as the main card.
        redLaneSeen = true;
        expect(submitMainPick(play, Player.P1, partner.card.id)).toBeNull();
        if (!play.partnerDone[Player.P1]) {
          expect(submitPartnerPick(play, Player.P1, partnerOptions(play, Player.P1, partner.card.id)[0].card.id)).toBeNull();
        }
      } else {
        finishTurn(play, Player.P1);
      }
      finishTurn(play, Player.P2);
      const result = resolveCurrentLane(play)!;
      if (result.lane === partner.lane) {
        expect(result.p1Card.id).toBe(partner.card.id);
        // As a main card it gets its own partner from the other still-eligible cards (never itself).
        for (const link of result.p1Synergy.links) expect(link.card.id).not.toBe(partner.card.id);
      }
      for (const link of result.p1Synergy.links) expect(link.card.id).not.toBe(partner.card.id);
    }
    expect(redLaneSeen).toBe(true);
    // Red never repeats within a round.
    expect(new Set(play.red[Player.P1]).size).toBe(play.red[Player.P1].length);

    // Next round: red resets.
    const next = createRoundPlay(2, { [Player.P1]: play.played[Player.P1], [Player.P2]: play.played[Player.P2] } as Record<Player, string[]>, seeded(1));
    expect(next.red[Player.P1]).toEqual([]);
    expect(next.red[Player.P2]).toEqual([]);
  });
});

describe('Fearless across the match', () => {
  it('never deals a card the player already played as MAIN, across rounds', () => {
    const random = seeded(42);
    const state = createMatchState(3);
    const played: Record<Player, string[]> = { [Player.P1]: [], [Player.P2]: [] } as Record<Player, string[]>;
    for (let round = 1; round <= 3; round++) {
      const play = createRoundPlay(state.currentRound, {
        [Player.P1]: state.p1UsedCardIds,
        [Player.P2]: state.p2UsedCardIds,
      } as Record<Player, Set<string>>, random);
      for (const player of [Player.P1, Player.P2]) {
        for (const id of play.hands[player].flat()) expect(played[player]).not.toContain(id);
      }
      while (!isRoundPlayComplete(play)) {
        for (const player of [Player.P1, Player.P2]) {
          finishTurn(play, player);
          played[player].push(play.mains[player]!);
        }
        resolveCurrentLane(play);
      }
      recordRoundResult(state, summarizeRound(play.results));
    }
    expect(new Set(played[Player.P1]).size).toBe(15);
    expect(new Set(played[Player.P2]).size).toBe(15);
    // Only main cards are Fearless-blocked; partners are not.
    expect([...usedCardIdsFor(state, Player.P1)].sort()).toEqual([...played[Player.P1]].sort());
    expect(isMatchOver(state)).toBe(true);
    expect(state.roundResults).toHaveLength(3);
  });

  it('plays all 3 rounds even if one player wins early', () => {
    const state = createMatchState();
    const random = seeded(9);
    for (let round = 1; round <= 3; round++) {
      playRound(state, random, round % 2);
      if (round < 3) expect(isMatchOver(state)).toBe(false);
    }
    expect(isMatchOver(state)).toBe(true);
    expect(state.p1RoundWins + state.p2RoundWins).toBeLessThanOrEqual(3);
  });

  it('resolveRound records the round and marks played cards as used', () => {
    const state = createMatchState();
    const pick = (lane: Lane, offset: number) => CARDS.filter(card => card.lanes.includes(lane))[offset];
    const p1 = LANE_ORDER.map(lane => ({ card: pick(lane, 0), lane }));
    const p2 = LANE_ORDER.map(lane => ({ card: pick(lane, 1), lane }));
    const result = resolveRound(p1, p2, state);
    expect(state.roundResults).toEqual([result]);
    expect(state.currentRound).toBe(2);
    for (const item of p1) expect(state.p1UsedCardIds.has(item.card.id)).toBe(true);
    for (const item of p2) expect(state.p2UsedCardIds.has(item.card.id)).toBe(true);
  });
});
