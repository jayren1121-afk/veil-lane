import { CARDS } from '../data/cards';
import { OFFERS_PER_LANE } from './constants';
import { resolveLaneDuel } from './duel';
import { eligiblePartners } from './synergy';
import { Card, Lane, LANE_ORDER, LaneRevealResult, LaneSynergyLink, Placement, Player, RoundPlay } from './types';

const PLAYERS = [Player.P1, Player.P2] as const;
const CARD_BY_ID = new Map<string, Card>(CARDS.map(card => [card.id, card]));

export function cardById(id: string): Card | undefined {
  return CARD_BY_ID.get(id);
}

/** Cards that may be dealt for `lane`: legal there and not blocked (Fearless / already in hand). */
export function laneDealPool(lane: Lane, blocked: Iterable<string>): Card[] {
  const blockedSet = new Set(blocked);
  return CARDS.filter(card => card.lanes.includes(lane) && !blockedSet.has(card.id));
}

/** Deal up to OFFERS_PER_LANE distinct random card ids for `lane`, skipping `blocked` ids. */
export function dealLaneOffer(lane: Lane, blocked: Iterable<string>, random: () => number = Math.random): string[] {
  const pool = laneDealPool(lane, blocked);
  const offer: string[] = [];
  while (offer.length < OFFERS_PER_LANE && pool.length > 0) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    offer.push(pool.splice(index, 1)[0].id);
  }
  return offer;
}

/**
 * Deal a full hand: OFFERS_PER_LANE cards for every lane (10 cards), all distinct and none of
 * them `excluded` (main cards the player already played in earlier rounds).
 */
export function dealHand(excluded: Iterable<string>, random: () => number = Math.random): string[][] {
  const blocked = new Set(excluded);
  return LANE_ORDER.map(lane => {
    const offer = dealLaneOffer(lane, blocked, random);
    offer.forEach(id => blocked.add(id));
    return offer;
  });
}

function emptyPicks(play: RoundPlay): void {
  for (const player of PLAYERS) {
    play.mains[player] = null;
    play.partners[player] = [];
    play.partnerDone[player] = false;
  }
}

/** Start a round: each player is dealt their own 10-card hand (2 per lane) right away. */
export function createRoundPlay(
  round: number,
  excluded: Record<Player, Iterable<string>>,
  random: () => number = Math.random,
): RoundPlay {
  const p1Excluded = [...excluded[Player.P1]];
  const p2Excluded = [...excluded[Player.P2]];
  const play: RoundPlay = {
    round,
    laneIndex: 0,
    excluded: { [Player.P1]: p1Excluded, [Player.P2]: p2Excluded } as Record<Player, string[]>,
    hands: { [Player.P1]: dealHand(p1Excluded, random), [Player.P2]: dealHand(p2Excluded, random) } as Record<Player, string[][]>,
    mains: { [Player.P1]: null, [Player.P2]: null } as Record<Player, string | null>,
    partners: { [Player.P1]: [], [Player.P2]: [] } as Record<Player, string[]>,
    partnerDone: { [Player.P1]: false, [Player.P2]: false } as Record<Player, boolean>,
    played: { [Player.P1]: [], [Player.P2]: [] } as Record<Player, string[]>,
    red: { [Player.P1]: [], [Player.P2]: [] } as Record<Player, string[]>,
    results: [],
  };
  return play;
}

export function currentPlayLane(play: RoundPlay): Lane | null {
  return LANE_ORDER[play.laneIndex] ?? null;
}

export function isRoundPlayComplete(play: RoundPlay): boolean {
  return play.laneIndex >= LANE_ORDER.length;
}

/** The two cards `player` can play as MAIN in the current lane. */
export function currentOffer(play: RoundPlay, player: Player): string[] {
  return play.hands[player][play.laneIndex] ?? [];
}

/** A hand (string[][] by lane index) as placements: each card tagged with the lane it was dealt for. */
export function handToPlacements(hand: string[][]): Placement[] {
  const result: Placement[] = [];
  hand.forEach((ids, index) => {
    const lane = LANE_ORDER[index];
    for (const id of ids) {
      const card = CARD_BY_ID.get(id);
      if (card && lane) result.push({ card, lane });
    }
  });
  return result;
}

/** Main cards `player` has played this round as placements, in lane order. */
export function playedPlacements(play: RoundPlay, player: Player): Placement[] {
  const result: Placement[] = [];
  play.played[player].forEach((id, index) => {
    const card = CARD_BY_ID.get(id);
    if (card) result.push({ card, lane: LANE_ORDER[index] });
  });
  return result;
}

/**
 * Partner options for `mainId` as `player`'s main card in the current lane: other cards of the
 * hand (other lanes, played or not) that are obvious partners and not red. Best first.
 */
export function partnerOptions(play: RoundPlay, player: Player, mainId: string): LaneSynergyLink[] {
  const lane = currentPlayLane(play);
  const main = CARD_BY_ID.get(mainId);
  if (!lane || !main) return [];
  return eligiblePartners(main, lane, handToPlacements(play.hands[player]), new Set(play.red[player]));
}

/**
 * Lock `player`'s MAIN card for the current lane. With no eligible partner the partner step is
 * settled right away (no partners); otherwise the player chooses any subset next (even with
 * one option, which they may skip). Returns an error or null.
 */
export function submitMainPick(play: RoundPlay, player: Player, cardId: string): string | null {
  if (isRoundPlayComplete(play)) return 'ROUND_COMPLETE';
  if (play.mains[player] !== null) return 'ALREADY_PICKED';
  if (!currentOffer(play, player).includes(cardId)) return 'INVALID_PICK';
  play.mains[player] = cardId;
  play.partners[player] = [];
  play.partnerDone[player] = partnerOptions(play, player, cardId).length === 0;
  return null;
}

/**
 * Choose `player`'s synergy partners for the current lane: any subset of the eligible options
 * (empty = none). Their bonuses stack; each chosen card turns red for the rest of the round.
 * Returns an error or null.
 */
export function submitPartnerPicks(play: RoundPlay, player: Player, cardIds: readonly string[]): string | null {
  if (isRoundPlayComplete(play)) return 'ROUND_COMPLETE';
  const main = play.mains[player];
  if (main === null) return 'NO_MAIN';
  if (play.partnerDone[player]) return 'ALREADY_PICKED';
  if (!Array.isArray(cardIds) || cardIds.some(id => typeof id !== 'string')) return 'INVALID_PARTNER';
  if (new Set(cardIds).size !== cardIds.length) return 'DUPLICATE_PARTNER';
  const options = partnerOptions(play, player, main);
  if (!cardIds.every(id => options.some(link => link.card.id === id))) return 'INVALID_PARTNER';
  play.partners[player] = options.filter(link => cardIds.includes(link.card.id)).map(link => link.card.id);
  play.partnerDone[player] = true;
  return null;
}

/** Shorthand: choose exactly one partner. */
export function submitPartnerPick(play: RoundPlay, player: Player, cardId: string): string | null {
  return submitPartnerPicks(play, player, [cardId]);
}

/**
 * Timeout: pick a random main card if none is locked, then (if the partner step is still open)
 * only the single highest-% eligible partner. Returns true if anything changed.
 */
export function autoCompletePick(play: RoundPlay, player: Player, random: () => number = Math.random): boolean {
  if (isRoundPlayComplete(play) || isPlayerReady(play, player)) return false;
  if (play.mains[player] === null) {
    const offer = currentOffer(play, player);
    if (offer.length === 0) return false;
    submitMainPick(play, player, offer[Math.min(offer.length - 1, Math.floor(random() * offer.length))]);
  }
  if (!play.partnerDone[player]) {
    const best = partnerOptions(play, player, play.mains[player]!)[0];
    play.partners[player] = best ? [best.card.id] : [];
    play.partnerDone[player] = true;
  }
  return true;
}

/** Main card locked and partner step settled. */
export function isPlayerReady(play: RoundPlay, player: Player): boolean {
  return play.mains[player] !== null && play.partnerDone[player];
}

export function bothReady(play: RoundPlay): boolean {
  return isPlayerReady(play, Player.P1) && isPlayerReady(play, Player.P2);
}

function chosenLinks(play: RoundPlay, player: Player): LaneSynergyLink[] {
  const chosen = play.partners[player] ?? [];
  const main = play.mains[player];
  if (!main || chosen.length === 0) return [];
  return partnerOptions(play, player, main).filter(link => chosen.includes(link.card.id));
}

/**
 * Resolve the current lane once both players are ready: matchup + the summed tier %
 * of every chosen partner. Chosen partners turn red for the rest of the round.
 */
export function resolveCurrentLane(play: RoundPlay): LaneRevealResult | null {
  const lane = currentPlayLane(play);
  if (!lane || !bothReady(play)) return null;
  const p1Card = CARD_BY_ID.get(play.mains[Player.P1]!);
  const p2Card = CARD_BY_ID.get(play.mains[Player.P2]!);
  if (!p1Card || !p2Card) return null;
  const p1Links = chosenLinks(play, Player.P1);
  const p2Links = chosenLinks(play, Player.P2);
  const result = resolveLaneDuel(p1Card, p2Card, lane, play.laneIndex, p1Links, p2Links);
  play.played[Player.P1].push(p1Card.id);
  play.played[Player.P2].push(p2Card.id);
  play.red[Player.P1].push(...p1Links.map(link => link.card.id));
  play.red[Player.P2].push(...p2Links.map(link => link.card.id));
  play.results.push(result);
  play.laneIndex += 1;
  emptyPicks(play);
  return result;
}
