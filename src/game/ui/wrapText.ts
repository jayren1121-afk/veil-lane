/**
 * Word wrap that also breaks CJK text (which has no spaces) so long Chinese lines stay inside a width.
 * Latin words are kept whole; CJK characters can break anywhere, except that closing punctuation
 * never starts a line and opening punctuation never ends one.
 */
const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/;
const NO_LINE_START = /[，。、；：！？）」』】〉》,.;:!?)\]％%]/;
const NO_LINE_END = /[（「『【〈《(\[]/;

function tokenize(paragraph: string): string[] {
  const tokens: string[] = [];
  let word = '';
  for (const ch of paragraph) {
    if (ch === ' ' || CJK.test(ch)) {
      if (word) tokens.push(word);
      word = '';
      tokens.push(ch);
    } else {
      word += ch;
    }
  }
  if (word) tokens.push(word);
  // Glue punctuation to its neighbour so it never dangles at a line edge.
  const glued: string[] = [];
  for (const token of tokens) {
    const last = glued[glued.length - 1];
    if (last !== undefined && last !== ' ' && (NO_LINE_START.test(token[0]) || NO_LINE_END.test(last[last.length - 1]))) {
      glued[glued.length - 1] = last + token;
    } else {
      glued.push(token);
    }
  }
  return glued;
}

export function wrapLines(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const token of tokenize(paragraph)) {
      const candidate = line + token;
      if (line && measure(candidate.trimEnd()) > maxWidth) {
        out.push(line.trimEnd());
        line = token === ' ' ? '' : token;
      } else {
        line = candidate;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Measure with a shared offscreen canvas; falls back to a rough estimate where no canvas exists. */
export function measureTextWidth(value: string, font: string): number {
  if (measureContext === undefined) {
    measureContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  if (!measureContext) {
    const size = Number(/(\d+)px/.exec(font)?.[1] ?? 16);
    return [...value].reduce((sum, ch) => sum + (CJK.test(ch) ? size : size * 0.55), 0);
  }
  measureContext.font = font;
  return measureContext.measureText(value).width;
}
