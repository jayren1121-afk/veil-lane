import { CARDS } from '../data/cards';
import { OFFERS_PER_LANE } from './constants';
import { resolveLaneDuel } from './duel';
import { computeLaneSynergy, usedSynergyPartners } from './synergy';
import { Card, Lane, LANE_ORDER, LaneRevealResult, LaneSynergy, Placement, Player, RoundPlay } from './types';

const PLAYERS = [Player.P1, Player.P2] as const;
const CARD_BY_ID = new Map<string, Card>(CARDS.map(card => [card.id, card]));

export function cardById(id: string): Card | undefined {
  return CARD_BY_ID.get(id);
}

/** Cards `player` may still be dealt for `lane`: legal there and never played this match. */
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

function blockedFor(play: RoundPlay, player: Player): string[] {
  return [...play.excluded[player], ...play.played[player]];
}

function dealCurrentLane(play: RoundPlay, random: () => number): void {
  const lane = LANE_ORDER[play.laneIndex];
  for (const player of PLAYERS) {
    play.offers[player] = lane ? dealLaneOffer(lane, blockedFor(play, player), random) : [];
    play.picks[player] = null;
  }
}

/**
 * Start a round. `excluded` is each player's Fearless list (cards played in earlier rounds).
 * Both players are immediately dealt their own two cards for the first lane.
 */
export function createRoundPlay(
  round: number,
  excluded: Record<Player, Iterable<string>>,
  random: () => number = Math.random,
): RoundPlay {
  const play: RoundPlay = {
    round,
    laneIndex: 0,
    excluded: { [Player.P1]: [...excluded[Player.P1]], [Player.P2]: [...excluded[Player.P2]] } as Record<Player, string[]>,
    offers: { [Player.P1]: [], [Player.P2]: [] } as Record<Player, string[]>,
    picks: { [Player.P1]: null, [Player.P2]: null } as Record<Player, string | null>,
    played: { [Player.P1]: [], [Player.P2]: [] } as Record<Player, string[]>,
    results: [],
  };
  dealCurrentLane(play, random);
  return play;
}

export function currentPlayLane(play: RoundPlay): Lane | null {
  return LANE_ORDER[play.laneIndex] ?? null;
}

export function isRoundPlayComplete(play: RoundPlay): boolean {
  return play.laneIndex >= LANE_ORDER.length;
}

/** Cards `player` has played this round as placements, in lane order. */
export function playedPlacements(play: RoundPlay, player: Player): Placement[] {
  const result: Placement[] = [];
  play.played[player].forEach((id, index) => {
    const card = CARD_BY_ID.get(id);
    if (card) result.push({ card, lane: LANE_ORDER[index] });
  });
  return result;
}

/**
 * Synergy each of `player`'s current offers would get from the cards they already played
 * (partners already used this round are excluded, so they don't glow).
 */
export function offerSynergies(play: RoundPlay, player: Player): Record<string, LaneSynergy> {
  const lane = currentPlayLane(play);
  const played = playedPlacements(play, player);
  const used = usedSynergyPartners(play.results, player);
  const result: Record<string, LaneSynergy> = {};
  if (!lane) return result;
  for (const id of play.offers[player]) {
    const card = CARD_BY_ID.get(id);
    if (card) result[id] = computeLaneSynergy(card, lane, played, undefined, used);
  }
  return result;
}

/** Lock `player`'s pick for the current lane. Returns an error string or null. */
export function submitLanePick(play: RoundPlay, player: Player, cardId: string): string | null {
  if (isRoundPlayComplete(play)) return 'ROUND_COMPLETE';
  if (play.picks[player] !== null) return 'ALREADY_PICKED';
  if (!play.offers[player].includes(cardId)) return 'INVALID_PICK';
  play.picks[player] = cardId;
  return null;
}

/** Pick a random offered card for `player` (used when their 20s clock runs out). */
export function autoLanePick(play: RoundPlay, player: Player, random: () => number = Math.random): string | null {
  if (isRoundPlayComplete(play) || play.picks[player] !== null) return null;
  const offer = play.offers[player];
  if (offer.length === 0) return null;
  const cardId = offer[Math.min(offer.length - 1, Math.floor(random() * offer.length))];
  play.picks[player] = cardId;
  return cardId;
}

export function bothPicked(play: RoundPlay): boolean {
  return play.picks[Player.P1] !== null && play.picks[Player.P2] !== null;
}

/**
 * Resolve the current lane once both players have picked: duel + order bonus + synergy from
 * earlier-played cards. The played cards become Fearless-blocked and the next lane is dealt.
 */
export function resolveCurrentLane(play: RoundPlay, random: () => number = Math.random): LaneRevealResult | null {
  const lane = currentPlayLane(play);
  if (!lane || !bothPicked(play)) return null;
  const p1Card = CARD_BY_ID.get(play.picks[Player.P1]!);
  const p2Card = CARD_BY_ID.get(play.picks[Player.P2]!);
  if (!p1Card || !p2Card) return null;
  const result = resolveLaneDuel(
    p1Card, p2Card, lane, play.laneIndex,
    playedPlacements(play, Player.P1), playedPlacements(play, Player.P2),
    usedSynergyPartners(play.results, Player.P1), usedSynergyPartners(play.results, Player.P2),
  );
  play.played[Player.P1].push(p1Card.id);
  play.played[Player.P2].push(p2Card.id);
  play.results.push(result);
  play.laneIndex += 1;
  dealCurrentLane(play, random);
  return result;
}
