/**
 * Where stacked partner cards dock beside the main card during the lane reveal, so that their
 * "+X%" tags never overlap. Tags sit above the cards; when there are too many to fit in one row
 * they alternate above / below, and the caller shrinks the tag font if even that is too tight.
 */
export interface DockSlot {
  /** Offset to the left of the first dock position. */
  dx: number;
  /** Put this card's tag under the card instead of above it. */
  tagBelow: boolean;
}

export const DOCK_BASE_STEP = 46;
const TAG_GAP = 4;

export function partnerDockLayout(count: number, span: number, tagWidth: number): DockSlot[] | null {
  if (count <= 0) return [];
  if (count === 1) return [{ dx: 0, tagBelow: false }];
  const single = Math.max(DOCK_BASE_STEP, tagWidth + TAG_GAP);
  if (single * (count - 1) <= span) {
    return Array.from({ length: count }, (_, index) => ({ dx: index * single, tagBelow: false }));
  }
  const step = span / (count - 1);
  if (2 * step < tagWidth + TAG_GAP) return null;
  return Array.from({ length: count }, (_, index) => ({ dx: index * step, tagBelow: index % 2 === 1 }));
}

/** Tag rectangles (centre x, width) per row never overlap: used by tests and as a runtime guard. */
export function tagsOverlap(slots: DockSlot[], tagWidth: number): boolean {
  for (const below of [false, true]) {
    const xs = slots.filter(slot => slot.tagBelow === below).map(slot => slot.dx).sort((a, b) => a - b);
    for (let index = 1; index < xs.length; index++) if (xs[index] - xs[index - 1] < tagWidth) return true;
  }
  return false;
}
