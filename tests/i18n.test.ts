import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  LanguageStore,
  LanguageStorage,
  setLanguage,
  t,
} from '../src/game/i18n';
import { STRINGS } from '../src/game/i18n/strings';

class MemoryStorage implements LanguageStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('language selection', () => {
  it('defaults to Traditional Chinese', () => {
    expect(new LanguageStore(null).getLanguage()).toBe(DEFAULT_LANGUAGE);
  });

  it('toggles between Chinese and English', () => {
    const language = new LanguageStore(null);

    expect(language.toggleLanguage()).toBe('en');
    expect(language.toggleLanguage()).toBe('zh');
  });

  it('persists the selected language and restores it from storage', () => {
    const storage = new MemoryStorage();
    const language = new LanguageStore(storage);
    language.setLanguage('en');

    expect(storage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(new LanguageStore(storage).getLanguage()).toBe('en');
  });

  it('falls back to the default for invalid stored values', () => {
    const storage = new MemoryStorage();
    storage.setItem(LANGUAGE_STORAGE_KEY, 'fr');

    expect(new LanguageStore(storage).getLanguage()).toBe(DEFAULT_LANGUAGE);
  });

  it('does not throw when storage access fails', () => {
    const storage: LanguageStorage = {
      getItem: () => { throw new Error('storage unavailable'); },
      setItem: () => { throw new Error('storage unavailable'); },
    };
    const language = new LanguageStore(storage);

    expect(language.getLanguage()).toBe(DEFAULT_LANGUAGE);
    expect(() => language.setLanguage('en')).not.toThrow();
    expect(language.getLanguage()).toBe('en');
  });

  it('substitutes template parameters in the selected language', () => {
    setLanguage('en');
    expect(t('draft.title', { round: 2 })).toBe('ROUND 2 — DRAFT');
    setLanguage('zh');
    expect(t('draft.title', { round: 2 })).toBe('第 2 局 — 選卡階段');
  });

  it('defines non-empty translations with matching placeholders for every key', () => {
    const placeholderNames = (value: string) => [...value.matchAll(/\{(\w+)\}/g)]
      .map(match => match[1])
      .sort();

    for (const [key, translations] of Object.entries(STRINGS)) {
      expect(translations.zh.trim(), `${key} zh`).not.toBe('');
      expect(translations.en.trim(), `${key} en`).not.toBe('');
      expect(translations.en, `${key} English text`).not.toMatch(/[\u3400-\u9fff]/);
      expect(placeholderNames(translations.zh), `${key} placeholders`).toEqual(placeholderNames(translations.en));
    }
  });
});