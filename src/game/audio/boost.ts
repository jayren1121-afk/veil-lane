interface ConnectableAudioNode {
  connect(destination: unknown): void;
}

interface GainAudioNode extends ConnectableAudioNode {
  gain: { value: number };
}

interface AudioContextLike {
  createMediaElementSource(audio: object): ConnectableAudioNode;
  createGain(): GainAudioNode;
  destination: unknown;
  resume(): Promise<void>;
}

type AudioContextFactory = () => AudioContextLike;

const contexts = new WeakMap<AudioContextFactory, AudioContextLike>();
const audioContexts = new WeakMap<object, AudioContextLike>();
let hasWarnedAboutGain = false;

const createBrowserAudioContext: AudioContextFactory = () => {
  if (typeof AudioContext === 'undefined') throw new Error('Web Audio API is unavailable');
  return new AudioContext() as unknown as AudioContextLike;
};

export function applyGainBoost(
  audio: object,
  gain: number,
  getContext: AudioContextFactory = createBrowserAudioContext,
): boolean {
  if (gain <= 1) return false;

  try {
    let context = contexts.get(getContext);
    if (!context) {
      context = getContext();
      contexts.set(getContext, context);
    }

    const source = context.createMediaElementSource(audio);
    const gainNode = context.createGain();
    gainNode.gain.value = gain;
    source.connect(gainNode);
    gainNode.connect(context.destination);
    audioContexts.set(audio, context);
    return true;
  } catch (error) {
    if (!hasWarnedAboutGain) {
      hasWarnedAboutGain = true;
      console.warn('音訊增益無法使用，將以原音量播放。', error);
    }
    return false;
  }
}

export async function resumeAudioContext(audio: object): Promise<void> {
  await audioContexts.get(audio)?.resume();
}