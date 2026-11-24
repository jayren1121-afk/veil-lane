import { describe, expect, it } from 'vitest';
import { DOCK_BASE_STEP, partnerDockLayout, tagsOverlap } from '../src/game/ui/partnerDock';

describe('partner dock layout', () => {
  it('one partner docks at the base position', () => {
    expect(partnerDockLayout(1, 150, 48)).toEqual([{ dx: 0, tagBelow: false }]);
    expect(partnerDockLayout(0, 150, 48)).toEqual([]);
  });

  it('a few partners sit in one row, spaced at least the tag width apart', () => {
    const slots = partnerDockLayout(3, 150, 48)!;
    expect(slots.every(slot => !slot.tagBelow)).toBe(true);
    expect(slots[1].dx).toBeGreaterThanOrEqual(Math.max(DOCK_BASE_STEP, 48));
    expect(tagsOverlap(slots, 48)).toBe(false);
    expect(slots[2].dx).toBeLessThanOrEqual(150);
  });

  it('many partners alternate tags above / below and never overlap or leave the span', () => {
    for (let count = 2; count <= 9; count++) {
      for (const width of [48, 40, 33]) {
        const slots = partnerDockLayout(count, 150, width);
        if (!slots) continue;
        expect(tagsOverlap(slots, width)).toBe(false);
        expect(Math.max(...slots.map(slot => slot.dx))).toBeLessThanOrEqual(150 + 1e-9);
      }
      // With the smallest tag it always fits up to 9 partners.
      expect(partnerDockLayout(count, 150, 33)).not.toBeNull();
    }
  });

  it('returns null when even alternating rows would overlap (caller shrinks the font)', () => {
    expect(partnerDockLayout(9, 150, 48)).toBeNull();
  });
});
