import { getLaneWinRate } from '../data/cards';
import { getSynergy } from '../data/synergies';
import { SYNERGY_BONUS_MAX, SYNERGY_BONUS_MIN, SYNERGY_MIN_EDGE, SYNERGY_MIN_GAMES, SYNERGY_RAW_CAP } from './constants';
import { ObviousSynergy, Placement, SynergyEntry, TeamSynergy } from './types';

export function computeSynergyEdge(wins: number, total: number, expectedWinRate: number): number {
  if (total < SYNERGY_MIN_GAMES || total <= 0) return 0;
  const edge = wins / total - expectedWinRate;
  return edge >= SYNERGY_MIN_EDGE ? edge : 0;
}

export function computeSynergyBonus(raw: number): number {
  if (raw <= 0) return 0;
  const bonusPercentage = SYNERGY_BONUS_MIN +
    (SYNERGY_BONUS_MAX - SYNERGY_BONUS_MIN) * Math.min(raw / SYNERGY_RAW_CAP, 1);
  return bonusPercentage / 100;
}

export function computeTeamSynergy(
  placements: Placement[],
  lookup: (cardA: string, laneA: Placement['lane'], cardB: string, laneB: Placement['lane']) => SynergyEntry | null = getSynergy
): TeamSynergy {
  const obviousSynergies: ObviousSynergy[] = [];

  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const first = placements[i];
      const second = placements[j];
      const entry = lookup(first.card.id, first.lane, second.card.id, second.lane);
      if (!entry) continue;

      const expectedWinRate = (getLaneWinRate(first.card, first.lane) + getLaneWinRate(second.card, second.lane)) / 2;
      const edge = computeSynergyEdge(entry.wins, entry.total, expectedWinRate);
      if (edge === 0) continue;

      obviousSynergies.push({
        cardA: first.card,
        laneA: first.lane,
        cardB: second.card,
        laneB: second.lane,
        wins: entry.wins,
        total: entry.total,
        expectedWinRate,
        synergyWinRate: entry.wins / entry.total,
        edge,
      });
    }
  }

  const rawValue = obviousSynergies.reduce((total, synergy) => total + synergy.edge, 0);
  return { obviousSynergies, rawValue, bonus: computeSynergyBonus(rawValue) };
}