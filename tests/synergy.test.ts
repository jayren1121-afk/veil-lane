import { describe, expect, it } from 'vitest';
import { CardRole, computeSynergyBonus, computeSynergyEdge, computeTeamSynergy, Lane, LANE_ORDER, Placement, SynergyEntry } from '../src/game/rules';

function makeTeam(): Placement[] {
  return LANE_ORDER.map((lane, index) => ({
    lane,
    card: {
      id: `test_card_${index}`,
      name: `Test ${index}`,
      role: CardRole.Fighter,
      lanes: [lane],
      laneWinRate: 0.5,
      laneGames: 20,
      color: '#ffffff',
    },
  }));
}

function syntheticLookup(wins: number, total: number) {
  return (cardA: string, laneA: Lane, cardB: string, laneB: Lane): SynergyEntry => ({
    cardA,
    laneA,
    cardB,
    laneB,
    wins,
    total,
  });
}

describe('obvious synergy rules', () => {
  it('treats missing, low-game, and below-edge pairs as no synergy', () => {
    expect(computeTeamSynergy(makeTeam(), () => null)).toMatchObject({ rawValue: 0, bonus: 0, obviousSynergies: [] });
    expect(computeSynergyEdge(18, 19, 0.5)).toBe(0);
    expect(computeSynergyEdge(11, 20, 0.5)).toBe(0);
    expect(computeSynergyBonus(0)).toBe(0);
  });

  it('gives one minimum-edge pair a bonus just above five percent', () => {
    const team = makeTeam();
    team[0].card.laneWinRate = 0.57;
    team[1].card.laneWinRate = 0.57;
    const lookup = (cardA: string, laneA: Lane, cardB: string, laneB: Lane): SynergyEntry | null => {
      if (cardA === team[0].card.id && cardB === team[1].card.id) {
        return { cardA, laneA, cardB, laneB, wins: 13, total: 20 };
      }
      return null;
    };
    const result = computeTeamSynergy(team, lookup);
    expect(result.obviousSynergies).toHaveLength(1);
    expect(result.rawValue).toBeCloseTo(0.08, 10);
    expect(result.bonus).toBeCloseTo(0.058, 10);
  });

  it('caps the bonus at eight percent when multiple strong pairs add up', () => {
    const result = computeTeamSynergy(makeTeam(), syntheticLookup(15, 20));
    expect(result.obviousSynergies.length).toBeGreaterThan(1);
    expect(result.rawValue).toBeGreaterThan(0.3);
    expect(result.bonus).toBeCloseTo(0.08, 10);
    expect(computeSynergyBonus(0.3)).toBeCloseTo(0.08, 10);
  });
});