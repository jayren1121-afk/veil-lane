import { describe, expect, it } from 'vitest';
import { wrapLines } from '../src/game/ui/wrapText';

const measure = (value: string) => [...value].length * 10;

describe('wrapLines', () => {
  it('breaks Chinese text without spaces inside the width', () => {
    const lines = wrapLines('每局各拿十張手牌每路兩張依序逐路進行', 60, measure);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(60);
    expect(lines.join('')).toBe('每局各拿十張手牌每路兩張依序逐路進行');
  });

  it('keeps latin words whole and drops the breaking space', () => {
    expect(wrapLines('hello brave new world', 110, measure)).toEqual(['hello brave', 'new world']);
  });

  it('never starts a line with closing punctuation', () => {
    const lines = wrapLines('一二三四五，六七', 50, measure);
    for (const line of lines) expect(line.startsWith('，')).toBe(false);
  });

  it('keeps explicit newlines', () => {
    expect(wrapLines('ab\ncd', 100, measure)).toEqual(['ab', 'cd']);
  });
});
