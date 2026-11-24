import { MatchState, Player } from './types';

/** Small deterministic PRNG (mulberry32); used for coin flips and reproducible deals. */
export function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function coinFlip(seed?: number): Player {
  const random = seed === undefined ? Math.random : seededRandom(seed);
  return random() < 0.5 ? Player.P1 : Player.P2;
}

export function otherPlayer(player: Player): Player {
  return player === Player.P1 ? Player.P2 : Player.P1;
}

export function getFirstPlayerForRound(round1First: Player, round: number): Player {
  return round % 2 === 1 ? round1First : otherPlayer(round1First);
}

export function getFirstPlayer(state: Pick<MatchState, 'round1FirstPlayer' | 'currentRound'>, round = state.currentRound): Player {
  return getFirstPlayerForRound(state.round1FirstPlayer, round);
}