export const MUSIC_VOLUME = 1;
export const MUSIC_FADE_MS = 700;
export const MUSIC_CREDIT = 'Music: Kevin MacLeod (incompetech.com) — CC BY 4.0';

export type MusicTrack = 'general' | 'draft' | null;

// The general track is recorded much quieter; this keeps its peaks below full scale.
export const MUSIC_TRACK_GAIN: Record<Exclude<MusicTrack, null>, number> = {
  general: 4,
  draft: 1,
};

export const MUSIC_TRACKS: Record<Exclude<MusicTrack, null>, string> = {
  general: 'music/suonatore-di-liuto-kevin-macleod.mp3',
  draft: 'music/clash-defiant-kevin-macleod.mp3',
};

export const SCENE_MUSIC: Record<string, MusicTrack> = {
  MenuScene: 'general',
  HowToPlayScene: 'general',
  DraftScene: 'draft',
  GameScene: null,
  SummaryScene: 'general',
  LoginScene: 'general',
  LobbyScene: 'general',
};

export function trackForScene(sceneKey: string): MusicTrack {
  return SCENE_MUSIC[sceneKey] ?? null;
}