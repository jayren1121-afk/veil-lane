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

/**
 * Tier bonus (0-1 scale) for a 1-based synergy rank out of `count` obvious partners. Up to five
 * partners map straight to 5/4/3/2/1; longer lists are split into five equal rank bands.
 */
export function synergyTierBonus(rank: number, count: number = SYNERGY_TIER.length): number {
  if (rank < 1 || rank > count) return 0;
  const index = count <= SYNERGY_TIER.length ? rank - 1 : Math.floor(((rank - 1) * SYNERGY_TIER.length) / count);
  const tier = SYNERGY_TIER[index];
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
    ranked.set(key, list.map((item, index) => ({
      ...item,
      rank: index + 1,
      bonus: synergyTierBonus(index + 1, list.length),
    })));
  }
  return ranked;
}

/**
 * All obvious synergy partners of `cardId` when it plays `lane`, best first, with tier bonuses.
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
 * Synergy partners available to `main` played in `lane`: any OTHER card in the player's hand
 * (dealt for a different lane, played or not) that is one of the main card's obvious partners
 * and is not red (already used as a partner this round). Best tier first.
 */
export function eligiblePartners(
  main: Card,
  lane: Lane,
  hand: Placement[],
  red: ReadonlySet<string> = new Set(),
  ranking: RankedPartner[] = rankSynergyPartners(main.id, lane),
): LaneSynergyLink[] {
  const links: LaneSynergyLink[] = [];
  for (const partner of ranking) {
    if (partner.cardId === main.id || red.has(partner.cardId)) continue;
    const placement = hand.find(item => item.lane !== lane && item.card.id === partner.cardId && item.lane === partner.lane);
    if (!placement) continue;
    links.push({ card: placement.card, lane: placement.lane, edge: partner.edge, rank: partner.rank, bonus: partner.bonus });
  }
  return links;
}

/** Synergy for one lane: synergy never stacks, so it is the single chosen partner (or none). */
export function laneSynergyOf(partner: LaneSynergyLink | null | undefined): LaneSynergy {
  return partner ? { links: [partner], bonus: partner.bonus } : { links: [], bonus: 0 };
}

/** Card ids that already served as a synergy partner for `side` in these resolved lanes (red cards). */
export function usedSynergyPartners(results: LaneRevealResult[], side: Player): Set<string> {
  const used = new Set<string>();
  for (const result of results) {
    const synergy = side === Player.P1 ? result.p1Synergy : result.p2Synergy;
    for (const link of synergy.links) used.add(link.card.id);
  }
  return used;
}
