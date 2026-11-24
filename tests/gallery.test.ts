import { describe, expect, it } from 'vitest';
import { CARDS } from '../src/game/data/cards';
import {
  cardLaneStats, GALLERY_FILTERS, GALLERY_PAGE_SIZE, galleryCards, galleryPage, galleryPageCount,
} from '../src/game/data/gallery';
import { Lane, LANE_ORDER } from '../src/game/rules/types';
import { STRINGS } from '../src/game/i18n/strings';

describe('card gallery', () => {
  it('shows every card once under All, sorted by name', () => {
    const all = galleryCards('all');
    expect(all).toHaveLength(CARDS.length);
    expect(new Set(all.map(card => card.id)).size).toBe(CARDS.length);
    const names = all.map(card => card.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('lane tabs only list cards playable in that lane, and together cover every card', () => {
    const seen = new Set<string>();
    for (const lane of LANE_ORDER) {
      const cards = galleryCards(lane);
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        expect(card.lanes).toContain(lane);
        seen.add(card.id);
      }
    }
    expect(seen.size).toBe(CARDS.length);
    expect(GALLERY_FILTERS).toEqual(['all', ...LANE_ORDER]);
  });

  it('pages cover the list exactly and clamp out-of-range pages', () => {
    const all = galleryCards('all');
    const pages = galleryPageCount(all.length);
    expect(pages).toBe(Math.ceil(all.length / GALLERY_PAGE_SIZE));
    const joined = Array.from({ length: pages }, (_, page) => galleryPage(all, page)).flat();
    expect(joined).toEqual(all);
    expect(galleryPage(all, -3)).toEqual(galleryPage(all, 0));
    expect(galleryPage(all, 99)).toEqual(galleryPage(all, pages - 1));
    expect(galleryPageCount(0)).toBe(1);
  });

  it('lists playable lanes in lane order with a base win rate and games', () => {
    for (const card of CARDS) {
      const stats = cardLaneStats(card);
      expect(stats.map(stat => stat.lane)).toEqual(LANE_ORDER.filter(lane => card.lanes.includes(lane)));
      for (const stat of stats) {
        expect(stat.winRate).toBeGreaterThan(0);
        expect(stat.winRate).toBeLessThan(1);
        expect(stat.games).toBeGreaterThan(0);
      }
    }
    expect(Object.values(Lane)).toHaveLength(5);
  });

  it('has Chinese and English text for the gallery and every role', () => {
    const keys = Object.keys(STRINGS).filter(key => key.startsWith('gallery.') || key.startsWith('role.') || key === 'menu.gallery');
    expect(keys.length).toBeGreaterThan(10);
    for (const role of new Set(CARDS.map(card => card.role))) expect(keys).toContain(`role.${role}`);
    for (const key of keys) {
      const entry = STRINGS[key as keyof typeof STRINGS] as { zh: string; en: string };
      expect(entry.zh.length).toBeGreaterThan(0);
      expect(entry.en.length).toBeGreaterThan(0);
    }
  });
});
