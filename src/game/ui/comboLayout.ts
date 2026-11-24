/**
 * Lay synergy lines out in columns of a fixed height. Entries that need two lines take two.
 * If not everything fits, the last line becomes "+N more" so nothing ever spills out of the panel.
 */
export function layoutComboColumns(
  entries: readonly string[],
  columns: number,
  linesPerColumn: number,
  wrap: (entry: string) => string[],
  moreLabel: (count: number) => string,
): string[][] {
  const wrapped = entries.map(entry => wrap(entry).slice(0, linesPerColumn));
  const fill = (count: number): { cols: string[][][]; placed: number } => {
    const cols: string[][][] = [[]];
    let used = 0;
    let placed = 0;
    for (let index = 0; index < count; index++) {
      const lines = wrapped[index];
      if (used + lines.length > linesPerColumn) {
        if (cols.length === columns) break;
        cols.push([]);
        used = 0;
      }
      cols[cols.length - 1].push(lines);
      used += lines.length;
      placed++;
    }
    return { cols, placed };
  };
  let { cols, placed } = fill(entries.length);
  if (placed < entries.length) {
    // Leave one free line at the end of the last column for "+N more".
    for (let count = placed; count >= 0; count--) {
      const attempt = fill(count);
      const last = attempt.cols[attempt.cols.length - 1];
      const lastUsed = last.reduce((sum, lines) => sum + lines.length, 0);
      const roomInLast = attempt.cols.length < columns || lastUsed < linesPerColumn;
      if (roomInLast) {
        cols = attempt.cols;
        placed = attempt.placed;
        break;
      }
    }
    const out = cols.map(col => col.flat());
    const more = moreLabel(entries.length - placed);
    const lastIndex = out.length - 1;
    if (out[lastIndex].length < linesPerColumn) out[lastIndex].push(more);
    else out.push([more]);
    return out;
  }
  return cols.map(col => col.flat());
}
