import Phaser from 'phaser';
import { getMusicManager } from './music';

/** One short card sound (Kenney Casino Audio "card-slide-1", CC0) for selecting and playing a card. */
export const CARD_SFX_KEY = 'sfx-card';
/** Loud enough to cut through the dense battle track (which also ducks briefly under it). */
export const CARD_SFX_VOLUME = 0.9;

export function preloadCardSfx(scene: Phaser.Scene): void {
  if (scene.cache.audio.exists(CARD_SFX_KEY)) return;
  scene.load.audio(CARD_SFX_KEY, ['audio/card.ogg', 'audio/card.mp3']);
}

/**
 * Play the card sound. Silent (never throws) when the music toggle is OFF, when the browser has
 * not unlocked audio yet (no user gesture), when sound is disabled, or when the file failed to load.
 */
export function playCardSfx(scene: Phaser.Scene): void {
  try {
    if (getMusicManager().isMuted()) return;
    const sound = scene.sound;
    if (!sound || sound.locked || (sound as { noAudio?: boolean }).noAudio) return;
    if (!scene.cache.audio.exists(CARD_SFX_KEY)) return;
    sound.play(CARD_SFX_KEY, { volume: CARD_SFX_VOLUME });
    getMusicManager().duck();
  } catch {
    // A missing sound must never break the game.
  }
}
