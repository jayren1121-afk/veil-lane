import { describe, expect, it } from 'vitest';
import {
  CardRole,
  computeLaneSynergy,
  computeSynergyEdge,
  Lane,
  LANE_ORDER,
  Placement,
  rankSynergyPartners,
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
    expect(computeSynergyEdge(18, 19, 0.5)).toBe(0);
    expect(computeSynergyEdge(11, 20, 0.5)).toBe(0);
    expect(computeSynergyEdge(13, 20, 0.5)).toBeCloseTo(0.15, 10);
  });
});

describe('tiered per-lane synergy', () => {
  it('uses the 5/4/3/2/1 tier table and gives nothing beyond the top five', () => {
    expect([...SYNERGY_TIER]).toEqual([5, 4, 3, 2, 1]);
    expect([1, 2, 3, 4, 5, 6].map(synergyTierBonus)).toEqual([0.05, 0.04, 0.03, 0.02, 0.01, 0]);
  });

  it('ranks a card\'s obvious partners by edge and keeps only the top five', () => {
    const ranked = rankSynergyPartners(star.id, Lane.Mid, table, byId);
    expect(ranked).toHaveLength(5);
    expect(ranked.map(item => item.cardId)).toEqual(['t6', 't5', 't4', 't3', 't2']);
    expect(ranked.map(item => item.bonus)).toEqual([0.05, 0.04, 0.03, 0.02, 0.01]);
    expect(ranked.some(item => item.cardId === weak.id)).toBe(false);
    // The pair is symmetric: the partner sees the star from its own ranking.
    expect(rankSynergyPartners('t6', partners[5].lanes[0], table, byId)[0]).toMatchObject({ cardId: star.id, rank: 1, bonus: 0.05 });
  });

  it('adds the tier bonus of every already-played partner to the lane', () => {
    const ranked = rankSynergyPartners(star.id, Lane.Mid, table, byId);
    const played: Placement[] = [
      { card: partners[5], lane: partners[5].lanes[0] }, // rank 1 -> +5%
      { card: partners[2], lane: partners[2].lanes[0] }, // rank 4 -> +2%
      { card: partners[0], lane: partners[0].lanes[0] }, // rank 6 -> 0
      { card: weak, lane: Lane.Bot },                    // below threshold -> 0
    ];
    const synergy = computeLaneSynergy(star, Lane.Mid, played, ranked);
    expect(synergy.links.map(link => [link.card.id, link.rank, link.bonus])).toEqual([['t6', 1, 0.05], ['t3', 4, 0.02]]);
    expect(synergy.bonus).toBeCloseTo(0.07, 10);
    expect(computeLaneSynergy(star, Lane.Mid, [], ranked)).toEqual({ links: [], bonus: 0 });
  });

  it('requires the partner to have been played in the lane the pair was recorded for', () => {
    const ranked = rankSynergyPartners(star.id, Lane.Mid, table, byId);
    const wrongLane = partners[5].lanes[0] === Lane.Top ? Lane.Jungle : Lane.Top;
    expect(computeLaneSynergy(star, Lane.Mid, [{ card: partners[5], lane: wrongLane }], ranked).bonus).toBe(0);
  });

  it('ranks the bundled aggregate table with at most five tiered partners per card', () => {
    let withPartners = 0;
    for (const card of CARDS) {
      for (const lane of card.lanes) {
        const ranked = rankSynergyPartners(card.id, lane);
        expect(ranked.length).toBeLessThanOrEqual(5);
        ranked.forEach((item, index) => {
          expect(item.rank).toBe(index + 1);
          expect(item.bonus).toBeCloseTo(SYNERGY_TIER[index] / 100, 10);
          if (index > 0) expect(item.edge).toBeLessThanOrEqual(ranked[index - 1].edge);
        });
        if (ranked.length > 0) withPartners++;
      }
    }
    expect(withPartners).toBeGreaterThan(0);
  });
});
