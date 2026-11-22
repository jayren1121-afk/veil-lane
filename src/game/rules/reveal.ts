import { ORDER_BONUS } from './constants';
import { Lane, LANE_ORDER, Player, RevealState } from './types';

export function createRevealState(firstPlayer: Player): RevealState {
  return { firstPlayer, revealOrder: [] };
}

export function getRemainingLanes(state: RevealState): Lane[] {
  return LANE_ORDER.filter(lane => !state.revealOrder.includes(lane));
}

export function revealLane(state: RevealState, lane: Lane): RevealState | null {
  if (!getRemainingLanes(state).includes(lane)) return null;
  return { ...state, revealOrder: [...state.revealOrder, lane] };
}

export function isRevealComplete(state: RevealState): boolean {
  return state.revealOrder.length === LANE_ORDER.length;
}

export function getRevealOrder(state: RevealState): Lane[] {
  return [...state.revealOrder];
}

export function getOrderBonus(orderIndex: number): number {
  return ORDER_BONUS[orderIndex] ?? 0;
}