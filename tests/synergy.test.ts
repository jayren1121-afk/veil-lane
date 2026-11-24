import { describe, expect, it } from 'vitest';
import {
  CardRole,
  eligiblePartners,
  laneSynergyOf,
  resolveLaneDuel,
  usedSynergyPartners,
  Player,
  computeSynergyEdge,
  Lane,
  LANE_ORDER,
  Placement,
  rankSynergyPartners,
  resolveRoundScores,
  SYNERGY_MIN_EDGE,
  SYNERGY_MIN_GAMES,
  SYNERGY_TIER,
  synergyTierBonus,
  SynergyEntry,
} from '../src/game/rules';
import { CARDS } from '../src/game/data/cards';

function testCard(index: number, lane: Lane) {
  return { id: `t${index}`, name: `Test ${index}`, role: CardRole.Fighter, lanes: [lane], laneWinRate: 0.5, laneGames: 50, color: '#ffffff' };
}

const star = testCard(0, Lane.Mid);
const partners = [1, 2, 3, 4, 5, 6].map(index => testCard(index, LANE_ORDER[index % 5] === Lane.Mid ? Lane.Top : LANE_ORDER[index % 5]));
const all = [star, ...partners];
const byId = (id: string) => all.find(card => card.id === id);
// Partner i wins (13 + i) of 20 games with the star: edges 0.20, 0.25, ... strictly increasing with i.
const table: SynergyEntry[] = partners.map((partner, index) => ({
  cardA: star.id, laneA: Lane.Mid, cardB: partner.id, laneB: partner.lanes[0], wins: 14 + index, total: 20,
}));
// Below the obvious-synergy edge: never ranked.
const weak = testCard(9, Lane.Bot);
all.push(weak);
table.push({ cardA: star.id, laneA: Lane.Mid, cardB: weak.id, laneB: Lane.Bot, wins: 11, total: 20 });

describe('obvious synergy thresholds', () => {
  it('treats low-game and below-edge pairs as no synergy', () => {
    expect([SYNERGY_MIN_GAMES, SYNERGY_MIN_EDGE]).toEqual([4, 0.06]);
    expect(computeSynergyEdge(3, 3, 0.5)).toBe(0);    // too few games
    expect(computeSynergyEdge(11, 20, 0.5)).toBe(0);  // edge 0.05 < 0.06
    expect(computeSynergyEdge(3, 4, 0.5)).toBeCloseTo(0.25, 10);
    expect(computeSynergyEdge(13, 20, 0.5)).toBeCloseTo(0.15, 10);
  });
});

describe('tiered per-lane synergy', () => {
  it('uses the 5/4/3/2/1 tier table by rank, split into five equal bands for longer lists', () => {
    expect([...SYNERGY_TIER]).toEqual([5, 4, 3, 2, 1]);
    expect([1, 2, 3, 4, 5, 6].map(rank => synergyTierBonus(rank))).toEqual([0.05, 0.04, 0.03, 0.02, 0.01, 0]);
    expect([1, 2, 3].map(rank => synergyTierBonus(rank, 3))).toEqual([0.05, 0.04, 0.03]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(rank => synergyTierBonus(rank, 10)))
      .toEqual([0.05, 0.05, 0.04, 0.04, 0.03, 0.03, 0.02, 0.02, 0.01, 0.01]);
    expect(synergyTierBonus(11, 10)).toBe(0);
  });

  it('ranks all of a card\'s obvious partners by edge and pays them by rank band', () => {
    const ranked = rankSynergyPartners(star.id, Lane.Mid, table, byId);
    expect(ranked).toHaveLength(6);
    expect(ranked.map(item => item.cardId)).toEqual(['t6', 't5', 't4', 't3', 't2', 't1']);
    // Six partners split into five bands: 5, 5, 4, 3, 2, 1.
    expect(ranked.map(item => item.bonus)).toEqual([0.05, 0.05, 0.04, 0.03, 0.02, 0.01]);
    expect(ranked.some(item => item.cardId === weak.id)).toBe(false);
    // The pair is symmetric: the partner sees the star from its own ranking.
    expect(rankSynergyPartners('t6', partners[5].lanes[0], table, byId)[0]).toMatchObject({ cardId: star.id, rank: 1, bonus: 0.05 });
  });

  it('offers every eligible partner from the whole hand, best tier first', () => {
    const ranked = rankSynergyPartners(star.id, Lane.Mid, table, byId);
    const hand: Placement[] = [
      { card: partners[0], lane: partners[0].lanes[0] }, // rank 6 of 6 -> +1%
      { card: partners[2], lane: partners[2].lanes[0] }, // rank 4 of 6 -> +3%
      { card: weak, lane: Lane.Bot },                    // below threshold -> not eligible
      { card: partners[5], lane: partners[5].lanes[0] }, // rank 1 -> +5%
    ];
    const links = eligiblePartners(star, Lane.Mid, hand, new Set(), ranked);
    expect(links.map(link => [link.card.id, link.rank, link.bonus])).toEqual([['t6', 1, 0.05], ['t3', 4, 0.03], ['t1', 6, 0.01]]);
    expect(eligiblePartners(star, Lane.Mid, [], new Set(), ranked)).toEqual([]);
  });

  it('only matches a partner dealt for the lane the pair was recorded in, never the main lane', () => {
    const ranked = rankSynergyPartners(star.id, Lane.Mid, table, byId);
    const wrongLane = partners[5].lanes[0] === Lane.Top ? Lane.Jungle : Lane.Top;
    expect(eligiblePartners(star, Lane.Mid, [{ card: partners[5], lane: wrongLane }], new Set(), ranked)).toEqual([]);
    expect(eligiblePartners(star, Lane.Mid, [{ card: star, lane: Lane.Mid }], new Set(), ranked)).toEqual([]);
  });

  it('does not stack: a lane gets exactly the one chosen partner', () => {
    const ranked = rankSynergyPartners(star.id, Lane.Mid, table, byId);
    const hand: Placement[] = [partners[5], partners[4], partners[3]].map(card => ({ card, lane: card.lanes[0] }));
    const links = eligiblePartners(star, Lane.Mid, hand, new Set(), ranked);
    expect(links).toHaveLength(3);
    expect(links.map(link => link.bonus)).toEqual([0.05, 0.05, 0.04]);
    expect(laneSynergyOf(links[2])).toEqual({ links: [links[2]], bonus: 0.04 });
    expect(laneSynergyOf(null)).toEqual({ links: [], bonus: 0 });
    const real = CARDS.filter(card => card.lanes.includes(Lane.Mid));
    const withPartner = resolveLaneDuel(real[0], real[1], Lane.Mid, 0, links[2], null);
    const without = resolveLaneDuel(real[0], real[1], Lane.Mid, 0);
    expect(withPartner.p1Total - without.p1Total).toBeCloseTo(0.04, 10);
    expect(withPartner.p2Total).toBeCloseTo(without.p2Total, 10);
  });

  it('ranks the bundled aggregate table with banded tiers for every card', () => {
    let withPartners = 0;
    for (const card of CARDS) {
      for (const lane of card.lanes) {
        const ranked = rankSynergyPartners(card.id, lane);
        ranked.forEach((item, index) => {
          expect(item.rank).toBe(index + 1);
          expect(item.bonus).toBeCloseTo(synergyTierBonus(index + 1, ranked.length), 10);
          if (index > 0) expect(item.bonus).toBeLessThanOrEqual(ranked[index - 1].bonus);
          if (index > 0) expect(item.edge).toBeLessThanOrEqual(ranked[index - 1].edge);
        });
        if (ranked.length > 0) withPartners++;
      }
    }
    expect(withPartners).toBeGreaterThan(0);
  });
});

describe('red cards: a partner can only be used once per round', () => {
  it('skips red partners but still offers the others', () => {
    const ranked = rankSynergyPartners(star.id, Lane.Mid, table, byId);
    const hand: Placement[] = [
      { card: partners[5], lane: partners[5].lanes[0] }, // rank 1 (+5%) but red
      { card: partners[4], lane: partners[4].lanes[0] }, // rank 2 (+5%)
    ];
    const links = eligiblePartners(star, Lane.Mid, hand, new Set([partners[5].id]), ranked);
    expect(links.map(link => link.card.id)).toEqual(['t5']);
    // Nothing glows when the only partner is red.
    expect(eligiblePartners(star, Lane.Mid, hand.slice(0, 1), new Set([partners[5].id]), ranked)).toEqual([]);
  });

  it('derives the red set from resolved lanes for one side only', () => {
    const real = CARDS.filter(card => card.lanes.includes(Lane.Mid));
    const link = { card: partners[5], lane: partners[5].lanes[0], edge: 0.3, rank: 1, bonus: 0.05 };
    const result = resolveLaneDuel(real[0], real[1], Lane.Mid, 0, link, null);
    expect([...usedSynergyPartners([result], Player.P1)]).toEqual(['t6']);
    expect([...usedSynergyPartners([result], Player.P2)]).toEqual([]);
  });
});
