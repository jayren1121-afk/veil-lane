export const MUSIC_VOLUME = 1;
export const MUSIC_FADE_MS = 700;
export const MUSIC_CREDIT = 'Music: Kevin MacLeod (incompetech.com) — CC BY 4.0';

export type MusicTrack = 'general' | 'draft' | null;

// The general track is recorded much quieter; this keeps its peaks below full scale.
export const MUSIC_TRACK_GAIN: Record<Exclude<MusicTrack, null>, number> = {
  general: 4,
  draft: 1,
};

// Playback volume per track. The battle track (Clash Defiant) is dense and loud, so it sits lower
// (it now plays in GameScene and between rounds) to leave room for the card sound.
export const MUSIC_TRACK_VOLUME: Record<Exclude<MusicTrack, null>, number> = {
  general: 1,
  draft: 0.55,
};

/** Brief music duck under each card sound. */
export const MUSIC_DUCK_LEVEL = 0.5;
export const MUSIC_DUCK_MS = 160;

export const MUSIC_TRACKS: Record<Exclude<MusicTrack, null>, string> = {
  general: 'music/suonatore-di-liuto-kevin-macleod.mp3',
  draft: 'music/clash-defiant-kevin-macleod.mp3',
};

export const SCENE_MUSIC: Record<string, MusicTrack> = {
  MenuScene: 'general',
  HowToPlayScene: 'general',
  DraftScene: 'draft',
  // Picking moved into GameScene (vs CPU and online), so the battle track plays there.
  GameScene: 'draft',
  SummaryScene: 'general',
  LoginScene: 'general',
  LobbyScene: 'general',
};

export function trackForScene(sceneKey: string): MusicTrack {
  return SCENE_MUSIC[sceneKey] ?? null;
}

/**
 * The round summary sits between battle rounds: keep the battle track playing there so it carries on
 * from round to round, and switch back to the general track only once the match is over.
 */
export function summaryTrack(matchOver: boolean): MusicTrack {
  return matchOver ? 'general' : 'draft';
}
