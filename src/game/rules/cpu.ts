/**
 * Computer opponent. Plays under the same rules as a person and sees exactly what a person
 * sees: its own hand and red cards, plus the other player's two open candidates for the
 * current lane. It never reads the other player's actual pick, partner or the rest of their hand.
 *
 * Each lane it reads the player:
 *  - level 1 (usual): guess which candidate the player leans to (the one that does better
 *    against the CPU's own two cards), then pick the card with the best expected lane score
 *    against that guess;
 *  - double bluff (sometimes): assume the player expected that and switched to counter it,
 *    and counter the counter.
 * A little noise keeps it from being predictable.
 */
import { getLaneWinRate } from '../data/cards';
import { laneMatchupWinRate } from './duel';
import { cardById, currentOffer, currentPlayLane, isRoundPlayComplete, partnerOptions, submitMainPick, submitPartnerPick } from './lanePlay';
import { Card, Lane, Player, RoundPlay } from './types';

/** Random noise (0-1 scale) added to each option's expected score. */
export const CPU_SCORE_NOISE = 0.02;
/** How sharply the CPU believes the player leans to their better candidate (softmax temperature). */
export const CPU_READ_TEMPERATURE = 0.04;
/** Chance the CPU plays the double bluff (counters the player's counter). */
export const CPU_DOUBLE_BLUFF = 0.25;
/** Chance to take the second-best partner instead of the best one. */
export const CPU_PARTNER_SURPRISE = 0.15;
/** "Thinking" delay range before the CPU's card goes down, in ms. */
export const CPU_THINK_MS = [900, 2200] as const;

const other = (player: Player) => (player === Player.P1 ? Player.P2 : Player.P1);

/** The other player's open candidates for the current lane (public information). */
export function openCandidates(play: RoundPlay, viewer: Player): Card[] {
  return (play.hands[other(viewer)][play.laneIndex] ?? []).map(id => cardById(id)).filter((card): card is Card => Boolean(card));
}

/** Best partner % `player` would get with `cardId` as main this lane (own hand only). */
function partnerBonus(play: RoundPlay, player: Player, cardId: string): number {
  return partnerOptions(play, player, cardId)[0]?.bonus ?? 0;
}

/**
 * Expected lane score of `cardId` as `player`'s main against a belief over the opponent's
 * candidates: matchup win rate (weighted by the belief) + best partner %. With no candidates
 * known it falls back to the card's lane win rate.
 */
export function cpuExpectedScore(play: RoundPlay, player: Player, cardId: string, belief?: number[]): number {
  const lane = currentPlayLane(play);
  const card = cardById(cardId);
  if (!lane || !card) return 0;
  const candidates = openCandidates(play, player);
  const weights = belief ?? candidates.map(() => 1 / Math.max(1, candidates.length));
  const matchup = candidates.length === 0
    ? getLaneWinRate(card, lane)
    : candidates.reduce((sum, foe, index) => sum + (weights[index] ?? 0) * laneMatchupWinRate(card, foe, lane), 0);
  return matchup + partnerBonus(play, player, cardId);
}

/**
 * Level-1 read: how likely the player is to pick each candidate. The player sees the CPU's two
 * cards too, so a candidate that does better against them on average is the likelier pick.
 */
export function cpuReadPlayer(play: RoundPlay, cpu: Player): number[] {
  const lane = currentPlayLane(play);
  const foes = openCandidates(play, cpu);
  const mine = currentOffer(play, cpu).map(id => cardById(id)).filter((card): card is Card => Boolean(card));
  if (!lane || foes.length === 0) return [];
  const values = foes.map(foe => mine.length === 0
    ? getLaneWinRate(foe, lane)
    : mine.reduce((sum, card) => sum + laneMatchupWinRate(foe, card, lane), 0) / mine.length);
  const top = Math.max(...values);
  const exps = values.map(value => Math.exp((value - top) / CPU_READ_TEMPERATURE));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map(value => value / total);
}

function bestAgainst(play: RoundPlay, player: Player, offer: string[], belief: number[], noise: () => number): string | null {
  let bestId: string | null = null;
  let bestScore = -Infinity;
  for (const id of offer) {
    const score = cpuExpectedScore(play, player, id, belief) + noise();
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestId;
}

/** Choose the main card by reading the player's open candidates (never their actual pick). */
export function cpuChooseMain(play: RoundPlay, player: Player, random: () => number = Math.random): string | null {
  if (isRoundPlayComplete(play)) return null;
  const offer = currentOffer(play, player);
  if (offer.length <= 1) return offer[0] ?? null;
  const lane = currentPlayLane(play) as Lane;
  const noise = () => (random() * 2 - 1) * CPU_SCORE_NOISE;
  const foes = openCandidates(play, player);
  let belief = cpuReadPlayer(play, player);
  if (foes.length === 2 && random() < CPU_DOUBLE_BLUFF) {
    // Double bluff: the player expects my level-1 answer and picks whatever beats it; I counter that.
    const myLevel1 = cardById(bestAgainst(play, player, offer, belief, () => 0)!)!;
    const counter = laneMatchupWinRate(foes[0], myLevel1, lane) >= laneMatchupWinRate(foes[1], myLevel1, lane) ? 0 : 1;
    belief = counter === 0 ? [0.85, 0.15] : [0.15, 0.85];
  }
  return bestAgainst(play, player, offer, belief, noise);
}

/** Choose a partner for the locked main card: usually the highest %, sometimes the runner-up. */
export function cpuChoosePartner(play: RoundPlay, player: Player, random: () => number = Math.random): string | null {
  const main = play.mains[player];
  if (!main) return null;
  const options = partnerOptions(play, player, main);
  if (options.length === 0) return null;
  const pick = options.length > 1 && random() < CPU_PARTNER_SURPRISE ? options[1] : options[0];
  return pick.card.id;
}

/** Lock the CPU's whole turn for the current lane (main, then partner if it has to choose). */
export function cpuTakeTurn(play: RoundPlay, player: Player, random: () => number = Math.random): boolean {
  if (isRoundPlayComplete(play) || play.mains[player] !== null) return false;
  const main = cpuChooseMain(play, player, random);
  if (!main || submitMainPick(play, player, main) !== null) return false;
  if (!play.partnerDone[player]) {
    const partner = cpuChoosePartner(play, player, random);
    if (!partner || submitPartnerPick(play, player, partner) !== null) return false;
  }
  return true;
}

/** Random thinking delay in ms. */
export function cpuThinkDelay(random: () => number = Math.random): number {
  return CPU_THINK_MS[0] + random() * (CPU_THINK_MS[1] - CPU_THINK_MS[0]);
}
