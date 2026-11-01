/** A single line in the unified cell-code preview. */
export type CellDiffLine = {
  content: string;
  kind: 'unchanged' | 'removed' | 'inserted';
};

const MAX_LCS_CELLS = 2_000_000;

/**
 * Produce a unified line diff. Deletions precede insertions for a replacement,
 * matching the order expected by the notebook cell preview.
 *
 * A bounded LCS keeps normal notebook cells precise while avoiding quadratic
 * memory use for exceptionally large generated cells. Large inputs fall back
 * to a common-prefix/common-suffix diff.
 */
export function createCellDiffLines(
  original: string,
  replacement: string
): CellDiffLine[] {
  const oldLines = original === '' ? [] : original.split('\n');
  const newLines = replacement === '' ? [] : replacement.split('\n');

  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return createCoarseDiff(oldLines, newLines);
  }

  const lcs = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint32Array(newLines.length + 1)
  );

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
      lcs[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? 1 + lcs[oldIndex + 1][newIndex + 1]
          : Math.max(lcs[oldIndex + 1][newIndex], lcs[oldIndex][newIndex + 1]);
    }
  }

  const result: CellDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      result.push({ content: oldLines[oldIndex], kind: 'unchanged' });
      oldIndex++;
      newIndex++;
    } else if (
      oldIndex < oldLines.length &&
      (newIndex === newLines.length ||
        lcs[oldIndex + 1][newIndex] >= lcs[oldIndex][newIndex + 1])
    ) {
      result.push({ content: oldLines[oldIndex], kind: 'removed' });
      oldIndex++;
    } else {
      result.push({ content: newLines[newIndex], kind: 'inserted' });
      newIndex++;
    }
  }

  return result;
}

/** Return the editor source representing the unified diff rows. */
export function cellDiffSource(lines: CellDiffLine[]): string {
  return lines.map(line => line.content).join('\n');
}

function createCoarseDiff(
  oldLines: string[],
  newLines: string[]
): CellDiffLine[] {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  return [
    ...oldLines.slice(0, prefix).map(content => ({
      content,
      kind: 'unchanged' as const
    })),
    ...oldLines
      .slice(prefix, oldLines.length - suffix)
      .map(content => ({ content, kind: 'removed' as const })),
    ...newLines
      .slice(prefix, newLines.length - suffix)
      .map(content => ({ content, kind: 'inserted' as const })),
    ...oldLines.slice(oldLines.length - suffix).map(content => ({
      content,
      kind: 'unchanged' as const
    }))
  ];
}
