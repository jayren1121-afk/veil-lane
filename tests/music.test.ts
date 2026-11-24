import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyGainBoost } from '../src/game/audio/boost';
import { AudioLike, MusicManager } from '../src/game/audio/music';
import { MUSIC_DUCK_LEVEL, MUSIC_DUCK_MS, MUSIC_TRACKS, MUSIC_TRACK_GAIN, MUSIC_TRACK_VOLUME, MUSIC_VOLUME, summaryTrack, trackForScene } from '../src/game/audio/tracks';

class FakeAudio implements AudioLike {
  currentTime = 0;
  loop = false;
  paused = true;
  preload = '';
  volume = 1;
  playCalls = 0;
  failNextPlay = false;
  readonly listeners = new Map<string, EventListener>();

  constructor(readonly source: string) {}

  play(): Promise<void> {
    this.playCalls++;
    if (this.failNextPlay) {
      this.failNextPlay = false;
      return Promise.reject(new Error('Autoplay blocked'));
    }
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }
}

async function flushPromises() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('background music', () => {
  it('uses a stronger gain for general music without changing draft music', async () => {
    vi.useFakeTimers();
    const gains: number[] = [];
    const manager = new MusicManager((source, gain) => {
      gains.push(gain);
      return new FakeAudio(source);
    }, null);

    manager.setTrack('general');
    manager.unlock();
    await flushPromises();
    vi.advanceTimersByTime(750);
    manager.setTrack('draft');
    vi.advanceTimersByTime(750);
    await flushPromises();

    expect(MUSIC_TRACK_GAIN).toEqual({ general: 4, draft: 1 });
    expect(gains).toEqual([4, 1]);
  });

  it('connects boosted audio and resumes its context before MusicManager playback', async () => {
    const calls: string[] = [];
    const destination = {};
    const gainNode = { gain: { value: 0 }, connect: vi.fn(() => calls.push('gain-connect')) };
    const context = {
      createMediaElementSource: vi.fn(() => ({ connect: vi.fn(() => calls.push('source-connect')) })),
      createGain: vi.fn(() => gainNode),
      destination,
      resume: vi.fn(async () => { calls.push('resume'); }),
    };
    const getContext = () => context;
    const audio = new FakeAudio(MUSIC_TRACKS.general);
    vi.spyOn(audio, 'play').mockImplementation(() => {
      audio.playCalls++;
      audio.paused = false;
      calls.push('play');
      return Promise.resolve();
    });
    const manager = new MusicManager((source, gain) => {
      expect(applyGainBoost(audio, gain, getContext)).toBe(true);
      return audio;
    }, null);

    manager.setTrack('general');
    manager.unlock();
    await flushPromises();
    manager.setTrack(null);

    expect(gainNode.gain.value).toBe(4);
    expect(context.createMediaElementSource).toHaveBeenCalledWith(audio);
    expect(gainNode.connect).toHaveBeenCalledWith(destination);
    expect(calls).toEqual(['source-connect', 'gain-connect', 'resume', 'play']);
  });

  it('does not create an audio context for unity gain', () => {
    const getContext = vi.fn(() => { throw new Error('should not be called'); });

    expect(applyGainBoost({}, 1, getContext)).toBe(false);
    expect(getContext).not.toHaveBeenCalled();
  });

  it('falls back to normal playback if an audio context cannot be created', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getContext = () => { throw new Error('unsupported'); };

    expect(() => applyGainBoost({}, 4, getContext)).not.toThrow();
    expect(applyGainBoost({}, 4, getContext)).toBe(false);
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it('maps each scene to the expected track', () => {
    expect(trackForScene('MenuScene')).toBe('general');
    expect(trackForScene('HowToPlayScene')).toBe('general');
    expect(trackForScene('SummaryScene')).toBe('general');
    expect(trackForScene('DraftScene')).toBe('draft');
    expect(trackForScene('GameScene')).toBe('draft');
    for (const scene of ['MenuScene', 'HowToPlayScene', 'SummaryScene', 'LobbyScene', 'LoginScene']) {
      expect(trackForScene(scene)).toBe('general');
    }
    expect(summaryTrack(false)).toBe('draft');
    expect(summaryTrack(true)).toBe('general');
    expect(trackForScene('UnknownScene')).toBeNull();
  });

  it('keeps the same song playing across scenes without restarting it', async () => {
    vi.useFakeTimers();
    const audios: FakeAudio[] = [];
    const manager = new MusicManager(source => {
      const audio = new FakeAudio(source);
      audios.push(audio);
      return audio;
    }, null);

    manager.setTrack('general');
    manager.unlock();
    await flushPromises();
    vi.advanceTimersByTime(750);
    manager.setTrack('general');

    expect(audios).toHaveLength(1);
    expect(audios[0].playCalls).toBe(1);
    expect(audios[0].volume).toBeCloseTo(MUSIC_VOLUME);
  });

  it('keeps the battle track running from round to round (game → summary → game)', async () => {
    vi.useFakeTimers();
    const audios: FakeAudio[] = [];
    const manager = new MusicManager(source => {
      const audio = new FakeAudio(source);
      audios.push(audio);
      return audio;
    }, null);

    manager.setTrack(trackForScene('GameScene'));
    manager.unlock();
    await flushPromises();
    vi.advanceTimersByTime(750);
    audios[0].currentTime = 42;
    manager.setTrack(summaryTrack(false));
    vi.advanceTimersByTime(750);
    manager.setTrack(trackForScene('GameScene'));
    vi.advanceTimersByTime(750);

    expect(audios).toHaveLength(1);
    expect(audios[0].source).toBe(MUSIC_TRACKS.draft);
    expect(audios[0].playCalls).toBe(1);
    expect(audios[0].paused).toBe(false);
    expect(audios[0].currentTime).toBe(42);
    expect(audios[0].volume).toBeCloseTo(MUSIC_VOLUME * MUSIC_TRACK_VOLUME.draft);
  });

  it('plays the battle track quieter and ducks it briefly under a card sound', async () => {
    vi.useFakeTimers();
    const audios: FakeAudio[] = [];
    const manager = new MusicManager(source => {
      const audio = new FakeAudio(source);
      audios.push(audio);
      return audio;
    }, null);

    manager.setTrack('draft');
    manager.unlock();
    await flushPromises();
    vi.advanceTimersByTime(750);
    const full = MUSIC_VOLUME * MUSIC_TRACK_VOLUME.draft;
    expect(MUSIC_TRACK_VOLUME.draft).toBeLessThan(MUSIC_TRACK_VOLUME.general);
    expect(audios[0].volume).toBeCloseTo(full);

    manager.duck();
    expect(audios[0].volume).toBeCloseTo(full * MUSIC_DUCK_LEVEL);
    vi.advanceTimersByTime(MUSIC_DUCK_MS + 10);
    expect(audios[0].volume).toBeCloseTo(full);

    manager.setMuted(true);
    vi.advanceTimersByTime(750);
    manager.duck();
    expect(audios[0].volume).toBe(0);
  });

  it('fades out the old track and fades in the newly selected track', async () => {
    vi.useFakeTimers();
    const audios: FakeAudio[] = [];
    const manager = new MusicManager(source => {
      const audio = new FakeAudio(source);
      audios.push(audio);
      return audio;
    }, null);

    manager.setTrack('general');
    manager.unlock();
    await flushPromises();
    vi.advanceTimersByTime(750);
    manager.setTrack('draft');
    vi.advanceTimersByTime(750);
    await flushPromises();
    vi.advanceTimersByTime(750);

    expect(audios[0].paused).toBe(true);
    expect(audios[0].currentTime).toBe(0);
    expect(audios[1].source).toBe(MUSIC_TRACKS.draft);
    expect(audios[1].loop).toBe(true);
    expect(audios[1].volume).toBeCloseTo(MUSIC_VOLUME * MUSIC_TRACK_VOLUME.draft);
  });

  it('fades out and stops music when a scene has no track', async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio(MUSIC_TRACKS.general);
    const manager = new MusicManager(() => audio, null);
    manager.setTrack('general');
    manager.unlock();
    await flushPromises();
    vi.advanceTimersByTime(750);

    manager.setTrack(null);
    vi.advanceTimersByTime(750);

    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(0);
    expect(manager.getActiveTrack()).toBeNull();
  });

  it('stops and resets the previous track when a scene has no track while muted', async () => {
    const audio = new FakeAudio(MUSIC_TRACKS.general);
    const manager = new MusicManager(() => audio, null);
    manager.setTrack('general');
    manager.unlock();
    await flushPromises();
    audio.currentTime = 27;
    manager.setMuted(true);
    manager.setTrack(null);

    expect(audio.paused).toBe(true);
    expect(audio.currentTime).toBe(0);
    expect(manager.getActiveTrack()).toBeNull();
  });

  it('waits for the first user interaction after autoplay is blocked', async () => {
    const target = new EventTarget();
    const audio = new FakeAudio(MUSIC_TRACKS.general);
    audio.failNextPlay = true;
    const manager = new MusicManager(() => audio, target);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    manager.setTrack('general');
    manager.unlock();
    await flushPromises();

    target.dispatchEvent(new Event('pointerdown'));
    await flushPromises();

    expect(audio.playCalls).toBe(2);
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it('preserves mute state when the selected scene track changes', async () => {
    vi.useFakeTimers();
    const audios: FakeAudio[] = [];
    const manager = new MusicManager(source => {
      const audio = new FakeAudio(source);
      audios.push(audio);
      return audio;
    }, null);
    manager.setTrack('general');
    manager.unlock();
    await flushPromises();
    vi.advanceTimersByTime(750);
    manager.setMuted(true);
    vi.advanceTimersByTime(750);
    manager.setTrack('draft');
    manager.setMuted(false);
    await flushPromises();
    vi.advanceTimersByTime(750);

    expect(manager.isMuted()).toBe(false);
    expect(audios).toHaveLength(2);
    expect(audios[1].source).toBe(MUSIC_TRACKS.draft);
    expect(audios[1].volume).toBeCloseTo(MUSIC_VOLUME * MUSIC_TRACK_VOLUME.draft);
  });
});