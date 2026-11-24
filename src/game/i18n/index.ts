import { STRINGS, StringKey } from './strings';

export type Language = 'zh' | 'en';

export const DEFAULT_LANGUAGE: Language = 'zh';
export const LANGUAGE_STORAGE_KEY = 'veil-lane-language';

export interface LanguageStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): LanguageStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export class LanguageStore {
  private language: Language;

  constructor(private readonly storage: LanguageStorage | null = getBrowserStorage()) {
    let storedLanguage: string | null = null;
    try {
      storedLanguage = storage?.getItem(LANGUAGE_STORAGE_KEY) ?? null;
    } catch {
      // Storage can be unavailable in private browsing or restricted environments.
    }
    this.language = storedLanguage === 'en' || storedLanguage === 'zh'
      ? storedLanguage
      : DEFAULT_LANGUAGE;
  }

  getLanguage(): Language {
    return this.language;
  }

  setLanguage(language: Language): void {
    this.language = language;
    try {
      this.storage?.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {
      // The in-memory language remains usable if persistence is unavailable.
    }
  }

  toggleLanguage(): Language {
    const nextLanguage = this.language === 'zh' ? 'en' : 'zh';
    this.setLanguage(nextLanguage);
    return nextLanguage;
  }
}

const languageStore = new LanguageStore();

export const getLanguage = (): Language => languageStore.getLanguage();
export const setLanguage = (language: Language): void => languageStore.setLanguage(language);
export const toggleLanguage = (): Language => languageStore.toggleLanguage();

export function t(key: StringKey, params: Record<string, string | number> = {}): string {
  const template = STRINGS[key][getLanguage()];
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder);
}

export { STRINGS } from './strings';

/**
 * English verbs and possessives change when the subject is "YOU" ("YOU GO FIRST", "YOUR HAND"),
 * so templates that take a player label have a "you" variant used when the label is the viewer.
 */
export const SUBJECT_YOU_VARIANTS: Partial<Record<StringKey, StringKey>> = {
  'coin.winner': 'coin.winnerYou',
  'game.laneWinner': 'game.laneWinnerYou',
  'summary.matchWinner': 'summary.matchWinnerYou',
  'game.handLabel': 'game.handLabelYou',
  'summary.synergyBonus': 'summary.synergyBonusYou',
};

/** Like `t`, but picks the "you" variant of `key` when the subject player is the viewer. */
export function tSubject(key: StringKey, isYou: boolean, params: Record<string, string | number> = {}): string {
  return t(isYou ? SUBJECT_YOU_VARIANTS[key] ?? key : key, params);
}
