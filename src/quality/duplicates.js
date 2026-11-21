const minimumLines = 12;
const minimumTokens = 80;

function eligibleLengths(tokens) {
  const lineStarts = [];
  const lines = tokens.map((token, index) => {
    if (index === 0 || tokens[index - 1].line !== token.line) {
      lineStarts.push(index);
    }
    return lineStarts.length - 1;
  });
  return lines.map((line, index) => {
    const last = lineStarts[line + minimumLines - 1];
    return last === undefined ? Infinity : Math.max(minimumTokens, last - index + 1);
  });
}

/** Find exact runs after ignoring comments and whitespace. Each file supplies ordered lexical tokens. */
export function findDuplicates(files, limit = 20) {
  const windows = new Map();
  const duplicates = [];
  for (const { name, tokens } of files) {
    const requiredLengths = eligibleLengths(tokens);
    for (let start = 0; start + minimumTokens <= tokens.length; start++) {
      const required = requiredLengths[start];
      if (start + required > tokens.length) {
        continue;
      }
      const first = tokens[start];
      const key = JSON.stringify(
        tokens.slice(start, start + minimumTokens).map((token) => token.value),
      );
      const candidates = windows.get(key) ?? [];
      let duplicate = false;
      for (const candidate of candidates) {
        const available = candidate.name === name ? start - candidate.start : Infinity;
        const minimum = Math.max(required, candidate.required);
        if (
          minimum > available ||
          start + minimum > tokens.length ||
          candidate.start + minimum > candidate.tokens.length
        ) {
          continue;
        }
        let length = minimumTokens;
        while (
          length < available &&
          tokens[start + length] &&
          candidate.tokens[candidate.start + length]?.value === tokens[start + length].value
        ) {
          length++;
        }
        if (length < minimum) {
          continue;
        }
        duplicates.push({
          name,
          line: first.line,
          column: first.column,
          other: candidate.name,
          otherLine: candidate.tokens[candidate.start].line,
          length,
        });
        if (duplicates.length >= limit) {
          return duplicates;
        }
        start += length - 1;
        duplicate = true;
        break;
      }
      if (!duplicate) {
        candidates.push({ name, tokens, start, required });
        windows.set(key, candidates);
      }
    }
  }
  return duplicates;
}
