import { describe, expect, it } from 'vitest';
import { layoutComboColumns } from '../src/game/ui/comboLayout';

const wrap = (entry: string) => (entry.startsWith('long') ? [entry, '…cont'] : [entry]);
const more = (count: number) => `+${count} more`;

describe('layoutComboColumns', () => {
  it('fills the first column, then the next', () => {
    const cols = layoutComboColumns(['a', 'b', 'c', 'd', 'e'], 2, 3, wrap, more);
    expect(cols).toEqual([['a', 'b', 'c'], ['d', 'e']]);
  });

  it('never exceeds the column height and ends with "+N more" when too many', () => {
    const entries = Array.from({ length: 14 }, (_, index) => `e${index}`);
    const cols = layoutComboColumns(entries, 2, 6, wrap, more);
    expect(cols).toHaveLength(2);
    for (const col of cols) expect(col.length).toBeLessThanOrEqual(6);
    expect(cols[1][cols[1].length - 1]).toBe('+3 more');
    expect(cols.flat().filter(line => line.startsWith('e'))).toHaveLength(11);
  });

  it('keeps two-line entries together', () => {
    const cols = layoutComboColumns(['a', 'long1', 'b', 'long2'], 2, 3, wrap, more);
    expect(cols).toEqual([['a', 'long1', '…cont'], ['b', 'long2', '…cont']]);
  });

  it('handles 10 partners per side in 2 columns of 6', () => {
    const entries = Array.from({ length: 10 }, (_, index) => (index % 3 === 0 ? `long${index}` : `e${index}`));
    const cols = layoutComboColumns(entries, 2, 6, wrap, more);
    for (const col of cols) expect(col.length).toBeLessThanOrEqual(6);
    expect(cols.length).toBeLessThanOrEqual(2);
  });
});
