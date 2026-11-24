import { Card, Lane, LANE_ORDER } from '../rules/types';
import { CARDS, getLaneGames, getLaneWinRate } from './cards';

/** Card gallery: lane filter, paging and per-lane stats. Pure, so it can be unit-tested. */
export type GalleryFilter = 'all' | Lane;
export const GALLERY_FILTERS: GalleryFilter[] = ['all', ...LANE_ORDER];
export const GALLERY_COLS = 8;
export const GALLERY_ROWS = 3;
export const GALLERY_PAGE_SIZE = GALLERY_COLS * GALLERY_ROWS;

export function galleryCards(filter: GalleryFilter, cards: readonly Card[] = CARDS): Card[] {
  return cards
    .filter(card => filter === 'all' || card.lanes.includes(filter))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function galleryPageCount(count: number, pageSize = GALLERY_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(count / pageSize));
}

export function galleryPage<T>(items: readonly T[], page: number, pageSize = GALLERY_PAGE_SIZE): T[] {
  const last = galleryPageCount(items.length, pageSize) - 1;
  const index = Math.min(Math.max(0, Math.floor(page)), last);
  return items.slice(index * pageSize, (index + 1) * pageSize);
}

export interface GalleryLaneStat {
  lane: Lane;
  winRate: number;
  games: number;
}

/** Playable lanes in lane order, each with its base win rate and pro games. */
export function cardLaneStats(card: Card): GalleryLaneStat[] {
  return LANE_ORDER
    .filter(lane => card.lanes.includes(lane))
    .map(lane => ({ lane, winRate: getLaneWinRate(card, lane), games: getLaneGames(card, lane) }));
}
