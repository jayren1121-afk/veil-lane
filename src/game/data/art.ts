/**
 * Return the public URL for a card art image.
 * Images are stored at public/cards/<card_id>.jpg
 */
export function cardArtPath(id: string): string {
  return `cards/${id}.jpg`;
}

export const CARD_BACK_KEY = 'card-back';

export function cardBackPath(): string {
  return 'card-back.jpg';
}

export const COVER_BG_KEY = 'veil-lane-cover-background';

export function coverBgPath(): string {
  return 'bg/cover.jpg';
}
