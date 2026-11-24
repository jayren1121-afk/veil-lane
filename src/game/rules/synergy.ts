import { CARDS, getLaneWinRate } from '../data/cards';
import { getAllSynergies } from '../data/synergies';
import { SYNERGY_MIN_EDGE, SYNERGY_MIN_GAMES, SYNERGY_TIER } from './constants';
import { Card, Lane, LaneRevealResult, LaneSynergy, LaneSynergyLink, Placement, Player, SynergyEntry } from './types';

/** Edge of a pair over its expected win rate; 0 unless it clears the "obvious synergy" thresholds. */
export function computeSynergyEdge(wins: number, total: number, expectedWinRate: number): number {
  if (total < SYNERGY_MIN_GAMES || total <= 0) return 0;
  const edge = wins / total - expectedWinRate;
  return edge >= SYNERGY_MIN_EDGE ? edge : 0;
}

/** Tier bonus (0-1 scale) for a 1-based synergy rank; 0 beyond the top five. */
export function synergyTierBonus(rank: number): number {
  const tier = SYNERGY_TIER[rank - 1];
  return tier === undefined ? 0 : tier / 100;
}

/** One ranked synergy partner of a card in a lane. */
export interface RankedPartner {
  cardId: string;
  lane: Lane;
  edge: number;
  rank: number;
  bonus: number;
}

const CARD_BY_ID = new Map<string, Card>(CARDS.map(card => [card.id, card]));
let rankingCache: Map<string, RankedPartner[]> | null = null;

function buildRankings(entries: SynergyEntry[], cardById: (id: string) => Card | undefined): Map<string, RankedPartner[]> {
  const lists = new Map<string, { cardId: string; lane: Lane; edge: number }[]>();
  const push = (key: string, item: { cardId: string; lane: Lane; edge: number }) => {
    const list = lists.get(key);
    if (list) list.push(item);
    else lists.set(key, [item]);
  };
  for (const entry of entries) {
    const a = cardById(entry.cardA);
    const b = cardById(entry.cardB);
    if (!a || !b || a.id === b.id) continue;
    const expected = (getLaneWinRate(a, entry.laneA) + getLaneWinRate(b, entry.laneB)) / 2;
    const edge = computeSynergyEdge(entry.wins, entry.total, expected);
    if (edge <= 0) continue;
    push(`${a.id}|${entry.laneA}`, { cardId: b.id, lane: entry.laneB, edge });
    push(`${b.id}|${entry.laneB}`, { cardId: a.id, lane: entry.laneA, edge });
  }
  const ranked = new Map<string, RankedPartner[]>();
  for (const [key, list] of lists) {
    list.sort((x, y) => y.edge - x.edge || x.cardId.localeCompare(y.cardId));
    ranked.set(key, list.slice(0, SYNERGY_TIER.length).map((item, index) => ({
      ...item,
      rank: index + 1,
      bonus: synergyTierBonus(index + 1),
    })));
  }
  return ranked;
}

/**
 * Top obvious synergy partners of `cardId` when it plays `lane`, best first (max five).
 * Pass `entries` to rank a custom table (tests); otherwise the bundled aggregate is used.
 */
export function rankSynergyPartners(
  cardId: string,
  lane: Lane,
  entries?: SynergyEntry[],
  cardById: (id: string) => Card | undefined = id => CARD_BY_ID.get(id),
): RankedPartner[] {
  if (entries) return buildRankings(entries, cardById).get(`${cardId}|${lane}`) ?? [];
  if (!rankingCache) rankingCache = buildRankings(getAllSynergies(), cardById);
  return rankingCache.get(`${cardId}|${lane}`) ?? [];
}

/**
 * Synergy that `card` played in `lane` gets from the player's already-played cards this round.
 * Each played card that is one of the card's top-five obvious partners adds its tier bonus.
 * A card already used as a synergy partner earlier this round (`usedPartners`) can't be a
 * partner again until the next round; it can still be played as a main card.
 */
export function computeLaneSynergy(
  card: Card,
  lane: Lane,
  played: Placement[],
  ranking: RankedPartner[] = rankSynergyPartners(card.id, lane),
  usedPartners: ReadonlySet<string> = new Set(),
): LaneSynergy {
  const links: LaneSynergyLink[] = [];
  for (const partner of ranking) {
    if (usedPartners.has(partner.cardId)) continue;
    const placement = played.find(item => item.card.id === partner.cardId && item.lane === partner.lane);
    if (!placement || placement.card.id === card.id) continue;
    links.push({ card: placement.card, lane: placement.lane, edge: partner.edge, rank: partner.rank, bonus: partner.bonus });
  }
  return { links, bonus: links.reduce((sum, link) => sum + link.bonus, 0) };
}

/** Card ids that already served as a synergy partner for `side` in these resolved lanes. */
export function usedSynergyPartners(results: LaneRevealResult[], side: Player): Set<string> {
  const used = new Set<string>();
  for (const result of results) {
    const synergy = side === Player.P1 ? result.p1Synergy : result.p2Synergy;
    for (const link of synergy.links) used.add(link.card.id);
  }
  return used;
}
