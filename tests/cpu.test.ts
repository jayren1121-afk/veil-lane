import { describe, expect, it } from 'vitest';
import {
  createMatchState,
  createRoundPlay,
  cpuChooseMain,
  cpuChoosePartners,
  cpuPartnerPlan,
  laterPartnerValue,
  CPU_PARTNER_KEEP,
  LANE_ORDER,
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
  submitMainPick,
  submitPartnerPick,
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
        const options = partnerOptions(play, player, main).map(link => link.card.id);
        for (const partner of play.partners[player]) {
          expect(redBefore.has(partner)).toBe(false);
          expect(partner).not.toBe(main);
          expect(options).toContain(partner);
        }
        expect(new Set(play.partners[player]).size).toBe(play.partners[player].length);
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
          for (const id of probe.partners[Player.P2]) expect(play.red[Player.P2]).not.toContain(id);
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

  it("never peeks: same choice whatever the player's pick, partner, red cards or other lanes are", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const play = createRoundPlay(1, { [Player.P1]: new Set(), [Player.P2]: new Set() } as Record<Player, Set<string>>, seeded(seed));
      const a = clone(play);
      const b = clone(play);
      const offer = currentOffer(b, Player.P1);
      a.mains[Player.P1] = offer[0];
      b.mains[Player.P1] = offer[1] ?? offer[0];
      b.partners[Player.P1] = [b.hands[Player.P1][3][0], b.hands[Player.P1][4][0]];
      b.partnerDone[Player.P1] = true;
      // Shuffle the player's other lanes (hidden) but keep the current lane's open candidates.
      b.hands[Player.P1] = [b.hands[Player.P1][0], ...b.hands[Player.P1].slice(1).reverse()];
      b.red[Player.P1] = b.hands[Player.P1].slice(1).flat().slice(0, 3);
      expect(cpuTakeTurn(a, Player.P2, seeded(seed * 5))).toBe(true);
      expect(cpuTakeTurn(b, Player.P2, seeded(seed * 5))).toBe(true);
      expect(b.mains[Player.P2]).toBe(a.mains[Player.P2]);
      expect(b.partners[Player.P2]).toEqual(a.partners[Player.P2]);
    }
  });

  it("reads the player's open candidates: different candidates can change its pick", () => {
    let changed = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const play = createRoundPlay(1, { [Player.P1]: new Set(), [Player.P2]: new Set() } as Record<Player, Set<string>>, seeded(seed));
      const other = createRoundPlay(1, { [Player.P1]: new Set(), [Player.P2]: new Set() } as Record<Player, Set<string>>, seeded(seed + 5000));
      const swapped = clone(play);
      swapped.hands[Player.P1] = [other.hands[Player.P1][0].filter(id => !play.hands[Player.P2].flat().includes(id)), ...play.hands[Player.P1].slice(1)];
      if (swapped.hands[Player.P1][0].length < 2) continue;
      if (cpuChooseMain(play, Player.P2, seeded(9)) !== cpuChooseMain(swapped, Player.P2, seeded(9))) changed++;
    }
    expect(changed).toBeGreaterThan(10);
  });

  it('beats simple players over many lanes and sometimes double-bluffs', () => {
    const lanes = { greedy: [0, 0], random: [0, 0] } as Record<string, [number, number]>;
    let varied = 0;
    for (let seed = 1; seed <= 300; seed++) {
      for (const style of ['greedy', 'random'] as const) {
        const play = createRoundPlay(1, { [Player.P1]: new Set(), [Player.P2]: new Set() } as Record<Player, Set<string>>, seeded(seed));
        const brain = seeded(seed * 17);
        const coin = seeded(seed * 29);
        while (!isRoundPlayComplete(play)) {
          const offer = currentOffer(play, Player.P1);
          const main = style === 'random'
            ? offer[Math.floor(coin() * offer.length)]
            : [...offer].sort((x, y) => cpuExpectedScore(play, Player.P1, y) - cpuExpectedScore(play, Player.P1, x))[0];
          submitMainPick(play, Player.P1, main);
          if (!play.partnerDone[Player.P1]) submitPartnerPick(play, Player.P1, partnerOptions(play, Player.P1, main)[0].card.id);
          cpuTakeTurn(play, Player.P2, brain);
          const result = resolveCurrentLane(play)!;
          if (result.laneWinner === Player.P2) lanes[style][0]++;
          if (result.laneWinner === Player.P1) lanes[style][1]++;
        }
      }
      // Same lane, different random streams: the CPU should not always pick the same card.
      const fresh = createRoundPlay(1, { [Player.P1]: new Set(), [Player.P2]: new Set() } as Record<Player, Set<string>>, seeded(seed));
      const picks = new Set<string | null>();
      for (let r = 1; r <= 12; r++) picks.add(cpuChooseMain(fresh, Player.P2, seeded(r * 7919 + seed)));
      if (picks.size > 1) varied++;
    }
    const rate = (pair: [number, number]) => pair[0] / (pair[0] + pair[1]);
    // Measured at the time of writing: ~65% of decided lanes vs random, ~54% vs greedy.
    expect(rate(lanes.random)).toBeGreaterThan(0.5);
    expect(rate(lanes.greedy)).toBeGreaterThan(0.5);
    expect(varied).toBeGreaterThan(15);
  });

  it('chooses a subset of its partners: spends cheap ones, saves ones worth more in a later lane, spends all in the last lane', () => {
    let lanes = 0;
    let saved = 0;
    let stacked = 0;
    let lastLaneChecks = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const play = createRoundPlay(1, { [Player.P1]: new Set(), [Player.P2]: new Set() } as Record<Player, Set<string>>, seeded(seed));
      while (!isRoundPlayComplete(play)) {
        const main = currentOffer(play, Player.P2)[0];
        const options = partnerOptions(play, Player.P2, main);
        if (options.length > 0) {
          play.mains[Player.P2] = main;
          const plan = cpuPartnerPlan(play, Player.P2, main).map(link => link.card.id);
          for (const link of options) {
            const keep = link.bonus < CPU_PARTNER_KEEP * laterPartnerValue(play, Player.P2, link.card.id);
            expect(plan.includes(link.card.id)).toBe(!keep);
            if (keep) saved++;
          }
          if (play.laneIndex === LANE_ORDER.length - 1) {
            expect(plan).toEqual(options.map(link => link.card.id));
            lastLaneChecks++;
          }
          if (plan.length >= 2) stacked++;
          const choice = cpuChoosePartners(play, Player.P2, seeded(seed * 11 + play.laneIndex));
          for (const id of choice) expect(options.map(link => link.card.id)).toContain(id);
          lanes++;
          play.mains[Player.P2] = null;
        }
        cpuTakeTurn(play, Player.P1, seeded(seed));
        cpuTakeTurn(play, Player.P2, seeded(seed + 1));
        resolveCurrentLane(play);
      }
    }
    expect(lanes).toBeGreaterThan(100);
    expect(saved).toBeGreaterThan(10);
    expect(stacked).toBeGreaterThan(10);
    expect(lastLaneChecks).toBeGreaterThan(10);
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
