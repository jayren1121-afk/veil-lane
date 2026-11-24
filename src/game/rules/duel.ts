import { Card, Lane, Placement, TeamScore, LaneMatchupDetail, SynergyDetail, RoundResult, Player, LaneRevealResult, LaneSynergyLink, LANE_ORDER } from './types';
import { getMatchup } from '../data/matchups';
import { getSynergy } from '../data/synergies';
import { getLaneWinRate } from '../data/cards';
import { ALPHA, BETA, K, ORDER_BONUS, WIN_RATE_TIE_EPSILON } from './constants';
import { laneSynergyOf } from './synergy';

/**
 * Logit function: ln(p / (1 - p))
 * Clamps p to [1e-10, 1 - 1e-10] to avoid log(0).
 */
export function logit(p: number): number {
  const clamped = Math.max(1e-10, Math.min(1 - 1e-10, p));
  return Math.log(clamped / (1 - clamped));
}

/**
 * Logistic (sigmoid) function: 1 / (1 + e^-x)
 */
export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Compute Bayesian shrinkage win rate for card A vs card B in a lane.
 *
 * Formula from PLAN.md section 3.5:
 *   p0 = 0.5 * (WR(A in lane) + 1 - WR(B in lane))
 *   p^mu = (w + k * p0) / (n + k)
 *
 * where w/n is the raw A-wins / total for A vs B in this lane.
 * If no direct matchup data exists, n=0 and p = p0.
 */
export function computeShrinkageWinRate(
  cardA: Card,
  cardB: Card,
  lane: Lane
): { winRate: number; rawWins: number; rawTotal: number; prior: number } {
  // A mirror matchup (both sides picked the same card) is a 50-50.
  if (cardA.id === cardB.id) {
    return { winRate: 0.5, rawWins: 0, rawTotal: 0, prior: 0.5 };
  }

  const matchup = getMatchup(cardA.id, cardB.id, lane);

  // Prior: blend A's lane win rate and B's lane win rate (inverted)
  const p0 = 0.5 * (getLaneWinRate(cardA, lane) + (1 - getLaneWinRate(cardB, lane)));

  if (!matchup || matchup.total === 0) {
    return {
      winRate: p0,
      rawWins: 0,
      rawTotal: 0,
      prior: p0,
    };
  }

  const w = matchup.winsA;
  const n = matchup.total;

  // Bayesian shrinkage
  const p = (w + K * p0) / (n + K);

  return {
    winRate: p,
    rawWins: w,
    rawTotal: n,
    prior: p0,
  };
}

/**
 * Compute synergy delta for a pair of teammates.
 *
 * Formula from PLAN.md section 3.6:
 *   p^exp = 0.5 * (p^base_i + p^base_j)
 *   p^pair = (w + k * p^exp) / (n + k)
 *   delta^syn = logit(p^pair) - logit(p^exp)
 *
 * If no synergy data (n=0), delta = 0.
 */
export function computeSynergyDelta(
  cardA: Card,
  laneA: Lane,
  cardB: Card,
  laneB: Lane
): { deltaSyn: number; pPair: number; pExp: number; rawWins: number; rawTotal: number } {
  const synergy = getSynergy(cardA.id, laneA, cardB.id, laneB);

  // Expected pair win rate: average of two base rates
  const pExp = 0.5 * (getLaneWinRate(cardA, laneA) + getLaneWinRate(cardB, laneB));

  if (!synergy || synergy.total === 0) {
    // No data — delta is 0
    return { deltaSyn: 0, pPair: pExp, pExp, rawWins: 0, rawTotal: 0 };
  }

  const w = synergy.wins;
  const n = synergy.total;

  // Bayesian shrinkage for pair
  const pPair = (w + K * pExp) / (n + K);

  // Delta on logit scale
  const deltaSyn = logit(pPair) - logit(pExp);

  return { deltaSyn, pPair, pExp, rawWins: w, rawTotal: n };
}

/**
 * Compute team score (three layers on logit scale) for a team of 5 placements.
 *
 * Formula from PLAN.md section 3.7:
 *   s = (1/5) * sum(logit(p^base_i))
 *     + alpha * (1/5) * sum(logit(p^mu_i) - logit(p^base_i))
 *     + beta * (1/10) * sum(delta^syn_ij)
 */
export function computeTeamScore(
  placements: Placement[],
  opponentPlacements: Placement[]
): { teamScore: TeamScore; laneDetails: LaneMatchupDetail[]; synergies: SynergyDetail[] } {
  // Build opponent lookup by lane
  const oppByLane = new Map<Lane, Card>();
  for (const p of opponentPlacements) {
    oppByLane.set(p.lane, p.card);
  }

  // Layer 1: Base logit
  let baseSum = 0;
  // Layer 2: Matchup delta logit
  let matchupDeltaSum = 0;
  const laneDetails: LaneMatchupDetail[] = [];

  for (const p of placements) {
    const card = p.card;
    const oppCard = oppByLane.get(p.lane);
    const baseLogit = logit(getLaneWinRate(card, p.lane));
    baseSum += baseLogit;

    if (oppCard) {
      const shrinkage = computeShrinkageWinRate(card, oppCard, p.lane);
      const muLogit = logit(shrinkage.winRate);
      const delta = muLogit - baseLogit;
      matchupDeltaSum += delta;

      // Also compute opponent's shrinkage for this lane
      const oppShrinkage = computeShrinkageWinRate(oppCard, card, p.lane);

      laneDetails.push({
        lane: p.lane,
        p1Card: card,
        p2Card: oppCard,
        p1BaseLogit: baseLogit,
        p2BaseLogit: logit(getLaneWinRate(oppCard, p.lane)),
        p1MuLogit: muLogit,
        p2MuLogit: logit(oppShrinkage.winRate),
        matchupDelta: delta,
        rawWins: shrinkage.rawWins,
        rawTotal: shrinkage.rawTotal,
      });
    } else {
      matchupDeltaSum += 0;
    }
  }

  // Layer 3: Synergy (all 10 pairs)
  const synergies: SynergyDetail[] = [];
  let synergySum = 0;

  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const pi = placements[i];
      const pj = placements[j];
      const result = computeSynergyDelta(pi.card, pi.lane, pj.card, pj.lane);
      synergySum += result.deltaSyn;
      synergies.push({
        cardA: pi.card,
        cardB: pj.card,
        laneA: pi.lane,
        laneB: pj.lane,
        deltaSyn: result.deltaSyn,
        pPair: result.pPair,
        pExp: result.pExp,
        rawWins: result.rawWins,
        rawTotal: result.rawTotal,
      });
    }
  }

  const n = placements.length; // should be 5
  const nPairs = (n * (n - 1)) / 2; // should be 10

  const baseLogit = baseSum / n;
  const matchupLogit = matchupDeltaSum / n;
  const synergyLogit = synergySum / nPairs;
  const totalLogit = baseLogit + ALPHA * matchupLogit + BETA * synergyLogit;

  const teamScore: TeamScore = {
    baseLogit,
    matchupLogit,
    synergyLogit,
    totalLogit,
  };

  return { teamScore, laneDetails, synergies };
}

/**
 * Resolve a single lane duel. Each side's lane total is its matchup win rate, plus the common
 * order bonus, plus the tier bonus of the one synergy partner that side chose (if any).
 */
export function resolveLaneDuel(
  p1Card: Card,
  p2Card: Card,
  lane: Lane,
  orderIndex = 0,
  p1Partner: LaneSynergyLink | null = null,
  p2Partner: LaneSynergyLink | null = null,
): LaneRevealResult {
  const p1Shrinkage = computeShrinkageWinRate(p1Card, p2Card, lane);
  const p2Shrinkage = computeShrinkageWinRate(p2Card, p1Card, lane);

  const p1WinRate = p1Shrinkage.winRate;
  const p2WinRate = p2Shrinkage.winRate;

  const p1BaseLogit = logit(getLaneWinRate(p1Card, lane));
  const p1MuLogit = logit(p1Shrinkage.winRate);
  const matchupDelta = p1MuLogit - p1BaseLogit;

  const orderBonus = (ORDER_BONUS[orderIndex] ?? 0) / 100;
  const p1Synergy = laneSynergyOf(p1Partner);
  const p2Synergy = laneSynergyOf(p2Partner);
  const p1Total = p1WinRate + orderBonus + p1Synergy.bonus;
  const p2Total = p2WinRate + orderBonus + p2Synergy.bonus;

  let laneWinner: Player | null = null;
  if (p1Total - p2Total > WIN_RATE_TIE_EPSILON) {
    laneWinner = Player.P1;
  } else if (p2Total - p1Total > WIN_RATE_TIE_EPSILON) {
    laneWinner = Player.P2;
  }

  return {
    lane,
    p1Card,
    p2Card,
    p1WinRate,
    p2WinRate,
    matchupDelta,
    orderIndex,
    orderBonus,
    p1Synergy,
    p2Synergy,
    p1Total,
    p2Total,
    laneWinner,
  };
}

/** Summarise five resolved lanes into a round result (round total = mean of lane totals). */
export function summarizeRound(laneResults: LaneRevealResult[], firstPlayer: Player = Player.P1): RoundResult {
  const laneCount = laneResults.length || 1;
  const mean = (pick: (result: LaneRevealResult) => number) =>
    laneResults.reduce((sum, result) => sum + pick(result), 0) / laneCount;
  const p1WinRate = mean(result => result.p1Total);
  const p2WinRate = mean(result => result.p2Total);

  let roundWinner: Player | null = null;
  if (p1WinRate - p2WinRate > WIN_RATE_TIE_EPSILON) roundWinner = Player.P1;
  else if (p2WinRate - p1WinRate > WIN_RATE_TIE_EPSILON) roundWinner = Player.P2;

  return {
    firstPlayer,
    revealOrder: laneResults.map(result => result.lane),
    laneResults,
    p1MatchupAvg: mean(result => result.p1WinRate),
    p2MatchupAvg: mean(result => result.p2WinRate),
    orderBonusAvg: mean(result => result.orderBonus),
    p1SynergyAvg: mean(result => result.p1Synergy.bonus),
    p2SynergyAvg: mean(result => result.p2Synergy.bonus),
    p1WinRate,
    p2WinRate,
    roundWinner,
  };
}

/**
 * Resolve a full round from both line-ups, playing lanes in `revealOrder`. Optional chosen
 * partners per lane (one per side, synergy never stacks); lanes without one get no synergy.
 */
export function resolveRoundScores(
  p1Placements: Placement[],
  p2Placements: Placement[],
  revealOrder: Lane[] = LANE_ORDER,
  firstPlayer: Player = Player.P1,
  p1Partners: Partial<Record<Lane, LaneSynergyLink | null>> = {},
  p2Partners: Partial<Record<Lane, LaneSynergyLink | null>> = {},
): RoundResult {
  const laneResults: LaneRevealResult[] = [];
  for (const lane of revealOrder) {
    const p1Place = p1Placements.find(p => p.lane === lane);
    const p2Place = p2Placements.find(p => p.lane === lane);
    if (!p1Place || !p2Place) continue;
    laneResults.push(resolveLaneDuel(
      p1Place.card, p2Place.card, lane, laneResults.length, p1Partners[lane] ?? null, p2Partners[lane] ?? null,
    ));
  }
  return summarizeRound(laneResults, firstPlayer);
}
