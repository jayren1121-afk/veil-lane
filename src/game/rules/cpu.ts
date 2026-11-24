/**
 * Computer opponent. Plays under the same rules as a person and only ever looks at its own
 * hand, its own red cards and the public lane order: never the other player's hand or picks.
 */
import { getLaneWinRate } from '../data/cards';
import { cardById, currentOffer, currentPlayLane, isRoundPlayComplete, partnerOptions, submitMainPick, submitPartnerPick } from './lanePlay';
import { Player, RoundPlay } from './types';

/** Random noise (0-1 scale) added to each option's expected score so the CPU isn't predictable. */
export const CPU_SCORE_NOISE = 0.03;
/** Chance to take the second-best partner instead of the best one. */
export const CPU_PARTNER_SURPRISE = 0.15;
/** "Thinking" delay range before the CPU's card goes down, in ms. */
export const CPU_THINK_MS = [900, 2200] as const;

/**
 * Expected lane score of playing `cardId` as `player`'s main card in the current lane:
 * the card's win rate in that lane (the opponent's card is unknown) plus its best partner %.
 */
export function cpuExpectedScore(play: RoundPlay, player: Player, cardId: string): number {
  const lane = currentPlayLane(play);
  const card = cardById(cardId);
  if (!lane || !card) return 0;
  const best = partnerOptions(play, player, cardId)[0];
  return getLaneWinRate(card, lane) + (best?.bonus ?? 0);
}

/** Choose the main card: highest expected score after a little random noise. */
export function cpuChooseMain(play: RoundPlay, player: Player, random: () => number = Math.random): string | null {
  if (isRoundPlayComplete(play)) return null;
  const offer = currentOffer(play, player);
  let bestId: string | null = null;
  let bestScore = -Infinity;
  for (const id of offer) {
    const score = cpuExpectedScore(play, player, id) + (random() * 2 - 1) * CPU_SCORE_NOISE;
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestId;
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
