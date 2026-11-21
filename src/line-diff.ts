export type DiffLine = { before: string | null; after: string | null };

export function diffLines(before: string, after: string, maxCells = 250_000): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const rows: DiffLine[] = [];
  let start = 0;
  let endLeft = left.length;
  let endRight = right.length;
  while (start < endLeft && start < endRight && left[start] === right[start]) {
    rows.push({ before: left[start], after: right[start] });
    start++;
  }
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft--;
    endRight--;
  }

  let i = start;
  let j = start;
  const width = endRight - start + 1;
  const cells = (endLeft - start + 1) * width;
  if (endLeft > start && endRight > start && cells <= maxCells) {
    const lengths = new Uint32Array(cells);
    const index = (x: number, y: number) => (x - start) * width + y - start;
    for (let x = endLeft - 1; x >= start; x--) {
      for (let y = endRight - 1; y >= start; y--) {
        lengths[index(x, y)] =
          left[x] === right[y]
            ? 1 + lengths[index(x + 1, y + 1)]
            : Math.max(lengths[index(x + 1, y)], lengths[index(x, y + 1)]);
      }
    }
    while (i < endLeft && j < endRight) {
      if (left[i] === right[j]) {
        rows.push({ before: left[i++], after: right[j++] });
      } else if (lengths[index(i + 1, j)] >= lengths[index(i, j + 1)]) {
        rows.push({ before: left[i++], after: null });
      } else {
        rows.push({ before: null, after: right[j++] });
      }
    }
  }
  while (i < endLeft) {
    rows.push({ before: left[i++], after: null });
  }
  while (j < endRight) {
    rows.push({ before: null, after: right[j++] });
  }
  while (endLeft < left.length) {
    rows.push({ before: left[endLeft++], after: right[endRight++] });
  }
  return rows;
}

/**
 * Split a stored file into the lines shown in the review gutter.
 * @param text File text in any supported line-ending format.
 */
export function sourceLines(text: string): string[] {
  return text.replace(/(?:\r\n|\r|\n)$/u, "").split(/\r\n|\r|\n/u);
}
