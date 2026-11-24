import { describe, expect, it } from 'vitest';
import {
  createMatchState,
  createRoundPlay,
  cpuChooseMain,
  cpuChoosePartner,
  cpuExpectedScore,
  cpuTakeTurn,
  cpuThinkDelay,
  CPU_THINK_MS,
  currentOffer,
  isMatchOver,
  isPlayerReady,
  isRoundPlayComplete,
  partnerOptions,
  Player,
  recordRoundResult,
  resolveCurrentLane,
  RoundPlay,
  summarizeRound,
} from '../src/game/rules';

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

const usedOf = (state: ReturnType<typeof createMatchState>) => ({
  [Player.P1]: state.p1UsedCardIds,
  [Player.P2]: state.p2UsedCardIds,
}) as Record<Player, Set<string>>;

const clone = (play: RoundPlay): RoundPlay => JSON.parse(JSON.stringify(play));

/** CPU vs CPU full match; checks every pick against the rules as it goes. */
function playCpuMatch(seed: number) {
  const state = createMatchState(seed);
  const deal = seeded(seed);
  const brain = seeded(seed * 31 + 7);
  const mainsByPlayer = { [Player.P1]: [] as string[], [Player.P2]: [] as string[] };
  while (!isMatchOver(state)) {
    const before = { [Player.P1]: new Set(state.p1UsedCardIds), [Player.P2]: new Set(state.p2UsedCardIds) };
    const play = createRoundPlay(state.currentRound, usedOf(state), deal);
    for (const player of [Player.P1, Player.P2]) {
      // Fearless: nothing this player played as a main card earlier in the match is dealt again.
      for (const id of play.hands[player].flat()) expect(before[player].has(id)).toBe(false);
    }
    while (!isRoundPlayComplete(play)) {
      for (const player of [Player.P1, Player.P2]) {
        const offer = currentOffer(play, player);
        const redBefore = new Set(play.red[player]);
        expect(cpuTakeTurn(play, player, brain)).toBe(true);
        expect(isPlayerReady(play, player)).toBe(true);
        const main = play.mains[player]!;
        expect(offer).toContain(main);
        const partner = play.partners[player];
        if (partner) {
          expect(redBefore.has(partner)).toBe(false);
          expect(partner).not.toBe(main);
          expect(play.hands[player].flat()).toContain(partner);
        }
        mainsByPlayer[player].push(main);
      }
      expect(resolveCurrentLane(play)).not.toBeNull();
    }
    recordRoundResult(state, summarizeRound(play.results));
  }
  return { state, mainsByPlayer };
}

describe('CPU opponent', () => {
  it('plays full best-of-3 matches with legal picks, no red partners, and Fearless respected', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { mainsByPlayer } = playCpuMatch(seed);
      for (const mains of Object.values(mainsByPlayer)) {
        expect(new Set(mains).size).toBe(mains.length);
      }
    }
  });

  it('never picks a red (already used) card as a partner', () => {
    let checked = 0;
    for (let seed = 1; seed < 400 && checked < 30; seed++) {
      const play = createRoundPlay(1, { [Player.P1]: new Set(), [Player.P2]: new Set() } as Record<Player, Set<string>>, seeded(seed));
      const brain = seeded(seed + 99);
      while (!isRoundPlayComplete(play)) {
        if (play.red[Player.P2].length > 0) {
          const offer = currentOffer(play, Player.P2);
          const probe = clone(play);
          expect(cpuTakeTurn(probe, Player.P2, brain)).toBe(true);
          if (probe.partners[Player.P2]) expect(play.red[Player.P2]).not.toContain(probe.partners[Player.P2]);
          for (const id of offer) {
            for (const option of partnerOptions(play, Player.P2, id)) expect(play.red[Player.P2]).not.toContain(option.card.id);
          }
          checked++;
        }
        cpuTakeTurn(play, Player.P1, brain);
        cpuTakeTurn(play, Player.P2, brain);
        resolveCurrentLane(play);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("never peeks: its choice is the same whatever the player's hand or pick is", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const play = createRoundPlay(1, { [Player.P1]: new Set(), [Player.P2]: new Set() } as Record<Player, Set<string>>, seeded(seed));
      const a = clone(play);
      const b = clone(play);
      // Player 1 picks differently in each copy and their hands are shuffled around.
      const offer = currentOffer(b, Player.P1);
      a.mains[Player.P1] = offer[0];
      b.mains[Player.P1] = offer[1] ?? offer[0];
      b.hands[Player.P1] = [...b.hands[Player.P1]].reverse();
      b.red[Player.P1] = b.hands[Player.P1].flat().slice(0, 3);
      expect(cpuTakeTurn(a, Player.P2, seeded(seed * 5))).toBe(true);
      expect(cpuTakeTurn(b, Player.P2, seeded(seed * 5))).toBe(true);
      expect(b.mains[Player.P2]).toBe(a.mains[Player.P2]);
      expect(b.partners[Player.P2]).toBe(a.partners[Player.P2]);
    }
  });

  it('mostly takes the higher expected lane score (win rate + partner %)', () => {
    let clear = 0;
    let agreed = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const play = createRoundPlay(1, { [Player.P1]: new Set(), [Player.P2]: new Set() } as Record<Player, Set<string>>, seeded(seed));
      const offer = currentOffer(play, Player.P2);
      if (offer.length < 2) continue;
      const scores = offer.map(id => cpuExpectedScore(play, Player.P2, id));
      if (Math.abs(scores[0] - scores[1]) < 0.06) continue;
      clear++;
      const best = scores[0] > scores[1] ? offer[0] : offer[1];
      if (cpuChooseMain(play, Player.P2, seeded(seed * 3)) === best) agreed++;
    }
    expect(clear).toBeGreaterThan(20);
    expect(agreed / clear).toBeGreaterThan(0.9);
  });

  it('is not fully predictable: noise sometimes changes close calls', () => {
    const picks = new Set<string | null>();
    for (let seed = 1; seed <= 400 && picks.size < 2; seed++) {
      const play = createRoundPlay(1, { [Player.P1]: new Set(), [Player.P2]: new Set() } as Record<Player, Set<string>>, seeded(seed));
      const offer = currentOffer(play, Player.P2);
      const scores = offer.map(id => cpuExpectedScore(play, Player.P2, id));
      if (offer.length < 2 || Math.abs(scores[0] - scores[1]) > 0.01) continue;
      for (let r = 1; r <= 40; r++) picks.add(cpuChooseMain(play, Player.P2, seeded(r * 977)));
    }
    expect(picks.size).toBe(2);
  });

  it('picks a partner from its own options, usually the best one', () => {
    let many = 0;
    let best = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const play = createRoundPlay(1, { [Player.P1]: new Set(), [Player.P2]: new Set() } as Record<Player, Set<string>>, seeded(seed));
      const main = currentOffer(play, Player.P2)[0];
      const options = partnerOptions(play, Player.P2, main);
      if (options.length < 2) continue;
      play.mains[Player.P2] = main;
      const choice = cpuChoosePartner(play, Player.P2, seeded(seed * 11));
      expect(options.map(option => option.card.id)).toContain(choice);
      many++;
      if (choice === options[0].card.id) best++;
    }
    expect(many).toBeGreaterThan(20);
    expect(best / many).toBeGreaterThan(0.7);
  });

  it('thinks for a short, bounded time', () => {
    const random = seeded(4);
    for (let i = 0; i < 50; i++) {
      const delay = cpuThinkDelay(random);
      expect(delay).toBeGreaterThanOrEqual(CPU_THINK_MS[0]);
      expect(delay).toBeLessThanOrEqual(CPU_THINK_MS[1]);
    }
  });
});
