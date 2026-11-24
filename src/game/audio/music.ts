import { applyGainBoost, resumeAudioContext } from './boost';
import {
  MUSIC_DUCK_LEVEL,
  MUSIC_DUCK_MS,
  MUSIC_FADE_MS,
  MUSIC_TRACKS,
  MUSIC_TRACK_GAIN,
  MUSIC_TRACK_VOLUME,
  MUSIC_VOLUME,
  MusicTrack,
} from './tracks';

export interface AudioLike {
  currentTime: number;
  loop: boolean;
  paused: boolean;
  preload: string;
  volume: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener?(type: string, listener: EventListener, options?: AddEventListenerOptions | boolean): void;
}

type UnlockTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
type AudioFactory = (source: string, gain: number) => AudioLike;

export class MusicManager {
  private readonly createAudio: AudioFactory;
  private readonly unlockTarget: UnlockTarget | null;
  private selectedTrack: MusicTrack = null;
  private activeTrack: MusicTrack = null;
  private audio: AudioLike | null = null;
  private fadeTimer: ReturnType<typeof setInterval> | null = null;
  private duckTimer: ReturnType<typeof setTimeout> | null = null;
  private unlocked = false;
  private muted = false;
  private warnedTracks = new Set<MusicTrack>();
  private readonly unlockHandler = () => this.unlock();

  constructor(
    createAudio: AudioFactory = (source, gain) => {
      const audio = new Audio(source);
      applyGainBoost(audio, gain);
      return audio;
    },
    unlockTarget: UnlockTarget | null = typeof window === 'undefined' ? null : window,
  ) {
    this.createAudio = createAudio;
    this.unlockTarget = unlockTarget;
    this.listenForFirstInteraction();
  }

  setTrack(track: MusicTrack): void {
    this.selectedTrack = track;
    this.applySelection();
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.applySelection();
  }

  isMuted(): boolean {
    return this.muted;
  }

  getSelectedTrack(): MusicTrack {
    return this.selectedTrack;
  }

  getActiveTrack(): MusicTrack {
    return this.activeTrack;
  }

  /** Full playback volume for the playing track. */
  targetVolume(): number {
    return MUSIC_VOLUME * (this.activeTrack ? MUSIC_TRACK_VOLUME[this.activeTrack] : 1);
  }

  /**
   * Dip the music briefly under a sound effect. Skipped while muted, paused or fading so it
   * never fights a track change.
   */
  duck(): void {
    const audio = this.audio;
    if (!audio || this.muted || audio.paused || this.fadeTimer !== null) return;
    if (this.activeTrack !== this.selectedTrack) return;
    const full = this.targetVolume();
    audio.volume = full * MUSIC_DUCK_LEVEL;
    if (this.duckTimer !== null) clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => {
      this.duckTimer = null;
      if (audio !== this.audio || this.fadeTimer !== null || this.muted) return;
      audio.volume = full;
    }, MUSIC_DUCK_MS);
  }

  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    this.removeFirstInteractionListeners();
    this.applySelection();
  }

  private listenForFirstInteraction(): void {
    this.unlockTarget?.addEventListener('pointerdown', this.unlockHandler, true);
    this.unlockTarget?.addEventListener('keydown', this.unlockHandler, true);
  }

  private removeFirstInteractionListeners(): void {
    this.unlockTarget?.removeEventListener('pointerdown', this.unlockHandler, true);
    this.unlockTarget?.removeEventListener('keydown', this.unlockHandler, true);
  }

  private applySelection(): void {
    if (!this.unlocked) return;

    if (!this.selectedTrack) {
      this.fadeCurrentToPause(true);
      return;
    }

    if (this.muted) {
      this.fadeCurrentToPause(false);
      return;
    }

    if (this.audio && this.activeTrack === this.selectedTrack) {
      if (this.audio.paused) {
        this.playAudio(this.audio, this.selectedTrack);
      } else {
        this.fadeAudio(this.audio, this.targetVolume());
      }
      return;
    }

    if (this.audio) {
      const current = this.audio;
      this.fadeAudio(current, 0, () => {
        if (current !== this.audio) return;
        current.pause();
        current.currentTime = 0;
        this.audio = null;
        this.activeTrack = null;
        this.applySelection();
      });
      return;
    }

    this.startSelectedTrack();
  }

  private startSelectedTrack(): void {
    const track = this.selectedTrack;
    if (!track || this.muted || !this.unlocked) return;

    const audio = this.createAudio(MUSIC_TRACKS[track], MUSIC_TRACK_GAIN[track]);
    audio.loop = true;
    audio.preload = 'auto';
    audio.volume = 0;
    this.audio = audio;
    this.activeTrack = track;
    audio.addEventListener?.('error', () => {
      if (this.audio !== audio) return;
      this.warnOnce(track, '音樂檔案載入失敗，已略過背景音樂。');
      this.cancelFade();
      audio.pause();
      this.audio = null;
      this.activeTrack = null;
    }, { once: true });
    this.playAudio(audio, track);
  }

  private playAudio(audio: AudioLike, track: MusicTrack): void {
    void resumeAudioContext(audio).then(() => audio.play()).then(() => {
      if (audio !== this.audio) return;
      if (this.muted || !this.selectedTrack) {
        this.fadeCurrentToPause(!this.muted);
        return;
      }
      if (this.activeTrack !== this.selectedTrack) {
        this.applySelection();
        return;
      }
      this.fadeAudio(audio, this.muted ? 0 : this.targetVolume(), this.muted ? () => audio.pause() : undefined);
    }).catch(() => {
      if (audio !== this.audio) return;
      audio.volume = 0;
      this.cancelFade();
      this.warnOnce(track, '瀏覽器尚未允許播放背景音樂，等待下一次操作。');
      this.unlocked = false;
      this.listenForFirstInteraction();
    });
  }

  private fadeCurrentToPause(resetPosition: boolean): void {
    const current = this.audio;
    if (!current) return;
    this.fadeAudio(current, 0, () => {
      if (current !== this.audio) return;
      current.pause();
      if (resetPosition) {
        current.currentTime = 0;
        this.audio = null;
        this.activeTrack = null;
      }
    });
  }

  private fadeAudio(audio: AudioLike, targetVolume: number, onComplete?: () => void): void {
    this.cancelFade();
    if (this.duckTimer !== null) {
      clearTimeout(this.duckTimer);
      this.duckTimer = null;
    }
    const startVolume = audio.volume;
    if (Math.abs(startVolume - targetVolume) < 0.001) {
      audio.volume = targetVolume;
      onComplete?.();
      return;
    }

    const startedAt = Date.now();
    this.fadeTimer = setInterval(() => {
      if (audio !== this.audio) {
        this.cancelFade();
        return;
      }
      const progress = Math.min((Date.now() - startedAt) / MUSIC_FADE_MS, 1);
      audio.volume = startVolume + (targetVolume - startVolume) * progress;
      if (progress === 1) {
        this.cancelFade();
        onComplete?.();
      }
    }, 30);
  }

  private cancelFade(): void {
    if (this.fadeTimer === null) return;
    clearInterval(this.fadeTimer);
    this.fadeTimer = null;
  }

  private warnOnce(track: MusicTrack, message: string): void {
    if (this.warnedTracks.has(track)) return;
    this.warnedTracks.add(track);
    console.warn(message, track ? MUSIC_TRACKS[track] : '');
  }
}

let sharedMusicManager: MusicManager | null = null;

export function getMusicManager(): MusicManager {
  if (!sharedMusicManager) sharedMusicManager = new MusicManager();
  return sharedMusicManager;
}