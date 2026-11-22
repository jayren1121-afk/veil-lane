import { describe, it, expect } from 'vitest';
import {
  computeShrinkageWinRate,
  computeSynergyDelta,
  computeTeamScore,
  resolveRoundScores,
  logit,
  logistic,
  Card,
  Player,
  Lane,
  CardRole,
  Placement,
} from '../src/game/rules';
import { getMatchup } from '../src/game/data/matchups';
import { getSynergy } from '../src/game/data/synergies';
import * as cardsModule from '../src/game/data/cards';
import { getCardById, getLaneWinRate } from '../src/game/data/cards';

// Real GRID-derived cards (original names). Top lane:
// scrap_pilot 255/471, bulwark_hunter 139/312; head-to-head 38/61 for scrap_pilot.
const cardA: Card = getCardById('scrap_pilot')!;
const cardB: Card = getCardById('bulwark_hunter')!;
const RATE_A = 255 / 471;
const RATE_B = 139 / 312;

const cardC: Card = {
  id: 'unknown_card',
  name: 'Unknown',
  role: CardRole.Mage,
  lanes: [Lane.Mid],
  laneWinRate: 0.5,
  laneGames: 50,
  color: '#FFFFFF',
};

describe('logit / logistic', () => {
  it('logit(0.5) = 0', () => {
    expect(logit(0.5)).toBeCloseTo(0, 10);
  });

  it('logistic(0) = 0.5', () => {
    expect(logistic(0)).toBeCloseTo(0.5, 10);
  });

  it('logistic is inverse of logit', () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(logistic(logit(p))).toBeCloseTo(p, 10);
    }
  });

  it('logit handles edge values', () => {
    expect(logit(0.01)).toBeLessThan(0);
    expect(logit(0.99)).toBeGreaterThan(0);
    expect(logistic(5)).toBeGreaterThan(0.99);
    expect(logistic(-5)).toBeLessThan(0.01);
  });
});

describe('computeShrinkageWinRate', () => {
  it('uses Bayesian shrinkage when matchup data exists', () => {
    const result = computeShrinkageWinRate(cardA, cardB, Lane.Top);

    expect(result.rawWins).toBe(38);
    expect(result.rawTotal).toBe(61);
    expect(result.winRate).toBeGreaterThan(0);
    expect(result.winRate).toBeLessThan(1);
    const p0 = 0.5 * (RATE_A + 1 - RATE_B);
    expect(result.prior).toBeCloseTo(p0, 6);
    // Shrinkage k=8: (38 + 8 * p0) / (61 + 8)
    expect(result.winRate).toBeCloseTo((38 + 8 * p0) / 69, 6);
  });

  it('returns prior when no matchup data exists', () => {
    const result = computeShrinkageWinRate(cardA, cardC, Lane.Top);

    expect(result.rawWins).toBe(0);
    expect(result.rawTotal).toBe(0);
    expect(result.prior).toBeCloseTo(0.5 * (RATE_A + 1 - 0.5), 6);
    expect(result.winRate).toBeCloseTo(0.5 * (RATE_A + 1 - 0.5), 6);
  });

  it('is symmetric — A vs B and B vs A sum to ~1', () => {
    const ab = computeShrinkageWinRate(cardA, cardB, Lane.Top);
    const ba = computeShrinkageWinRate(cardB, cardA, Lane.Top);
    expect(ab.winRate + ba.winRate).toBeCloseTo(1, 5);
  });
});

describe('computeSynergyDelta', () => {
  it('returns positive delta for good synergy', () => {
    // staff_trickster (Jungle 179/339) + cinderling (Mid 84/164): 22/27 together
    const jg = getCardById('staff_trickster')!;
    const mid = getCardById('cinderling')!;
    const result = computeSynergyDelta(jg, Lane.Jungle, mid, Lane.Mid);

    expect(result.rawWins).toBe(22);
    expect(result.rawTotal).toBe(27);
    const pExp = 0.5 * (179 / 339 + 84 / 164);
    expect(result.pPair).toBeCloseTo((22 + 8 * pExp) / 35, 6);
    expect(result.deltaSyn).toBeGreaterThan(0); // positive synergy
  });

  it('returns zero delta when no synergy data', () => {
    const result = computeSynergyDelta(cardA, Lane.Top, cardC, Lane.Mid);
    expect(result.deltaSyn).toBe(0);
    expect(result.rawTotal).toBe(0);
  });

  it('pExp is average of two base rates', () => {
    const nightstalker: Card = {
      id: 'nightstalker',
      name: 'Nightstalker',
      role: CardRole.Assassin,
      lanes: [Lane.Jungle],
      laneWinRate: 0.53,
      laneGames: 130,
      color: '#2F4F4F',
    };
    const result = computeSynergyDelta(cardA, Lane.Top, nightstalker, Lane.Jungle);
    expect(result.pExp).toBeCloseTo(0.5 * (RATE_A + 0.53), 5);
  });
});

describe('computeTeamScore', () => {
  it('computes all three layers', () => {
    // Build a minimal team of 5
    const team: Placement[] = [
      { card: cardA, lane: Lane.Top },
      { card: { id: 'nightstalker', name: 'Nightstalker', role: CardRole.Assassin, lanes: [Lane.Jungle], laneWinRate: 0.53, laneGames: 130, color: '#2F4F4F' }, lane: Lane.Jungle },
      { card: { id: 'arcane', name: 'Arcane', role: CardRole.Mage, lanes: [Lane.Mid], laneWinRate: 0.52, laneGames: 140, color: '#9370DB' }, lane: Lane.Mid },
      { card: { id: 'silverarrow', name: 'Silverarrow', role: CardRole.Marksman, lanes: [Lane.Bot], laneWinRate: 0.53, laneGames: 125, color: '#C0C0C0' }, lane: Lane.Bot },
      { card: { id: 'warden', name: 'Warden', role: CardRole.Enchanter, lanes: [Lane.Support], laneWinRate: 0.51, laneGames: 135, color: '#8FBC8F' }, lane: Lane.Support },
    ];
    const opp: Placement[] = [
      { card: cardB, lane: Lane.Top },
      { card: { id: 'thornback', name: 'Thornback', role: CardRole.Tank, lanes: [Lane.Jungle], laneWinRate: 0.50, laneGames: 100, color: '#556B2F' }, lane: Lane.Jungle },
      { card: { id: 'voidwalker', name: 'Voidwalker', role: CardRole.Assassin, lanes: [Lane.Mid], laneWinRate: 0.57, laneGames: 105, color: '#483D8B' }, lane: Lane.Mid },
      { card: { id: 'venomstrike', name: 'Venomstrike', role: CardRole.Marksman, lanes: [Lane.Bot], laneWinRate: 0.50, laneGames: 98, color: '#228B22' }, lane: Lane.Bot },
      { card: { id: 'luminara', name: 'Luminara', role: CardRole.Enchanter, lanes: [Lane.Support], laneWinRate: 0.54, laneGames: 108, color: '#FFFACD' }, lane: Lane.Support },
    ];

    const result = computeTeamScore(team, opp);

    expect(result.teamScore.baseLogit).toBeDefined();
    expect(result.teamScore.matchupLogit).toBeDefined();
    expect(result.teamScore.synergyLogit).toBeDefined();
    expect(result.laneDetails.length).toBe(5);
    expect(result.synergies.length).toBe(10); // C(5,2) = 10 pairs
  });
});

describe('resolveRoundScores', () => {
  it('returns team totals from matchup average, reveal-order bonus, and synergy bonus', () => {
    const p1: Placement[] = [
      { card: cardA, lane: Lane.Top },
      { card: { id: 'nightstalker', name: 'Nightstalker', role: CardRole.Assassin, lanes: [Lane.Jungle], laneWinRate: 0.53, laneGames: 130, color: '#2F4F4F' }, lane: Lane.Jungle },
      { card: { id: 'arcane', name: 'Arcane', role: CardRole.Mage, lanes: [Lane.Mid], laneWinRate: 0.52, laneGames: 140, color: '#9370DB' }, lane: Lane.Mid },
      { card: { id: 'silverarrow', name: 'Silverarrow', role: CardRole.Marksman, lanes: [Lane.Bot], laneWinRate: 0.53, laneGames: 125, color: '#C0C0C0' }, lane: Lane.Bot },
      { card: { id: 'warden', name: 'Warden', role: CardRole.Enchanter, lanes: [Lane.Support], laneWinRate: 0.51, laneGames: 135, color: '#8FBC8F' }, lane: Lane.Support },
    ];
    const p2: Placement[] = [
      { card: cardB, lane: Lane.Top },
      { card: { id: 'thornback', name: 'Thornback', role: CardRole.Tank, lanes: [Lane.Jungle], laneWinRate: 0.50, laneGames: 100, color: '#556B2F' }, lane: Lane.Jungle },
      { card: { id: 'voidwalker', name: 'Voidwalker', role: CardRole.Assassin, lanes: [Lane.Mid], laneWinRate: 0.57, laneGames: 105, color: '#483D8B' }, lane: Lane.Mid },
      { card: { id: 'venomstrike', name: 'Venomstrike', role: CardRole.Marksman, lanes: [Lane.Bot], laneWinRate: 0.50, laneGames: 98, color: '#228B22' }, lane: Lane.Bot },
      { card: { id: 'luminara', name: 'Luminara', role: CardRole.Enchanter, lanes: [Lane.Support], laneWinRate: 0.54, laneGames: 108, color: '#FFFACD' }, lane: Lane.Support },
    ];

    const result = resolveRoundScores(p1, p2);

    expect(result.p1MatchupAvg + result.p2MatchupAvg).toBeCloseTo(1, 5);
    expect(result.p1WinRate).toBeCloseTo(result.p1MatchupAvg + result.orderBonusAvg + result.p1Synergy.bonus, 10);
    expect(result.p2WinRate).toBeCloseTo(result.p2MatchupAvg + result.orderBonusAvg + result.p2Synergy.bonus, 10);
    expect(result.p1WinRate).toBeGreaterThan(0);
    expect(result.p2WinRate).toBeGreaterThan(0);
    expect(result.roundWinner).toBe(Player.P1); // P1 has slightly better cards
  });

  it('swaps winner when teams are reversed', () => {
    const p1: Placement[] = [
      { card: cardA, lane: Lane.Top },
      { card: { id: 'nightstalker', name: 'Nightstalker', role: CardRole.Assassin, lanes: [Lane.Jungle], laneWinRate: 0.53, laneGames: 130, color: '#2F4F4F' }, lane: Lane.Jungle },
      { card: { id: 'arcane', name: 'Arcane', role: CardRole.Mage, lanes: [Lane.Mid], laneWinRate: 0.52, laneGames: 140, color: '#9370DB' }, lane: Lane.Mid },
      { card: { id: 'silverarrow', name: 'Silverarrow', role: CardRole.Marksman, lanes: [Lane.Bot], laneWinRate: 0.53, laneGames: 125, color: '#C0C0C0' }, lane: Lane.Bot },
      { card: { id: 'warden', name: 'Warden', role: CardRole.Enchanter, lanes: [Lane.Support], laneWinRate: 0.51, laneGames: 135, color: '#8FBC8F' }, lane: Lane.Support },
    ];
    const p2: Placement[] = [
      { card: cardB, lane: Lane.Top },
      { card: { id: 'thornback', name: 'Thornback', role: CardRole.Tank, lanes: [Lane.Jungle], laneWinRate: 0.50, laneGames: 100, color: '#556B2F' }, lane: Lane.Jungle },
      { card: { id: 'voidwalker', name: 'Voidwalker', role: CardRole.Assassin, lanes: [Lane.Mid], laneWinRate: 0.57, laneGames: 105, color: '#483D8B' }, lane: Lane.Mid },
      { card: { id: 'venomstrike', name: 'Venomstrike', role: CardRole.Marksman, lanes: [Lane.Bot], laneWinRate: 0.50, laneGames: 98, color: '#228B22' }, lane: Lane.Bot },
      { card: { id: 'luminara', name: 'Luminara', role: CardRole.Enchanter, lanes: [Lane.Support], laneWinRate: 0.54, laneGames: 108, color: '#FFFACD' }, lane: Lane.Support },
    ];

    const r1 = resolveRoundScores(p1, p2);
    const r2 = resolveRoundScores(p2, p1);

    // P1 win rate in r1 should equal P2 win rate in r2
    expect(r1.p1WinRate).toBeCloseTo(r2.p2WinRate, 10);
    expect(r1.p2WinRate).toBeCloseTo(r2.p1WinRate, 10);
  });
});

describe('getMatchup', () => {
  it('finds matchup in stored direction', () => {
    const entry = getMatchup('bulwark_hunter', 'scrap_pilot', Lane.Top);
    expect(entry).not.toBeNull();
    expect(entry!.winsA).toBe(23);
    expect(entry!.total).toBe(61);
  });

  it('finds matchup in reverse direction', () => {
    const entry = getMatchup('scrap_pilot', 'bulwark_hunter', Lane.Top);
    expect(entry).not.toBeNull();
    expect(entry!.winsA).toBe(38);
    expect(entry!.total).toBe(61);
  });

  it('returns null for unknown matchup', () => {
    const entry = getMatchup('scrap_pilot', 'unknown_card', Lane.Top);
    expect(entry).toBeNull();
  });
});

describe('getSynergy', () => {
  it('finds synergy entry', () => {
    const entry = getSynergy('quill_blade', Lane.Bot, 'gleam_showman', Lane.Support);
    expect(entry).not.toBeNull();
    expect(entry!.wins).toBe(74);
    expect(entry!.total).toBe(120);
  });

  it('finds synergy in reverse order', () => {
    const entry = getSynergy('gleam_showman', Lane.Support, 'quill_blade', Lane.Bot);
    expect(entry).not.toBeNull();
    expect(entry!.wins).toBe(74);
    expect(entry!.total).toBe(120);
  });

  it('returns null for unknown synergy', () => {
    const entry = getSynergy('scrap_pilot', Lane.Top, 'unknown_card', Lane.Mid);
    expect(entry).toBeNull();
  });
});

describe('GRID data sanity (PLAN.md section 3)', () => {
  it('card pool: 92 cards, 104 lane cards, n >= 20 per lane', () => {
    const { CARDS, LANE_STATS } = cardsModule;
    expect(CARDS.length).toBe(92);
    const laneCards = CARDS.reduce((s, c) => s + c.lanes.length, 0);
    expect(laneCards).toBe(104);
    for (const c of CARDS) {
      for (const l of c.lanes) expect(LANE_STATS[c.id][l]![1]).toBeGreaterThanOrEqual(20);
    }
  });

  it('mid matchup dune_throne vs rockthread_nomad shrinks 40/108 to ~37.6%', () => {
    const a = getCardById('dune_throne')!;
    const b = getCardById('rockthread_nomad')!;
    const r = computeShrinkageWinRate(a, b, Lane.Mid);
    expect(r.rawWins).toBe(40);
    expect(r.rawTotal).toBe(108);
    expect(r.winRate).toBeCloseTo(0.376, 3);
  });

  it('PLAN.md section 7 worked example: blue team 72.8%', () => {
    const L = [Lane.Top, Lane.Jungle, Lane.Mid, Lane.Bot, Lane.Support];
    const team = (ids: string[]): Placement[] => ids.map((id, i) => ({ card: getCardById(id)!, lane: L[i] }));
    const blue = team(['scrap_pilot', 'halberd_guard', 'rockthread_nomad', 'abyss_huntress', 'gleam_showman']);
    const red = team(['bulwark_hunter', 'gauntlet_brawler', 'dune_throne', 'relic_seeker', 'ironhorn']);
    const blueScore = computeTeamScore(blue, red).teamScore;
    const redScore = computeTeamScore(red, blue).teamScore;
    expect(logistic(blueScore.totalLogit - redScore.totalLogit)).toBeCloseTo(0.728, 3);
  });

  it('flex card uses lane-specific base rate', () => {
    const flex = getCardById('twin_veil_wanderer')!;
    expect(flex.lanes).toEqual([Lane.Top, Lane.Mid]);
    expect(getLaneWinRate(flex, Lane.Top)).toBeCloseTo(48 / 102, 6);
    expect(getLaneWinRate(flex, Lane.Mid)).toBeCloseTo(93 / 184, 6);
  });
});
