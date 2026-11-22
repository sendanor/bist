/** Optional one-based position supplied by a recipe parser or linter. */
interface DiagnosticPosition {
  readonly line?: number;
  readonly column?: number;
}

/**
 * Preserve validation details from errors and provide a safe message for other thrown values.
 * @param error The failure caught during recipe validation.
 */
export function recipeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Recipe validation failed.";
}

/**
 * Locate a recipe diagnostic even if the parser cannot provide a rule or position.
 * @param part The recipe part being checked, such as source or styles.
 * @param message The diagnostic text to display beside the location.
 * @param position The parser or linter's optional one-based line and column.
 * @param rule The rule ID, or null for a parser diagnostic.
 */
export function describeRecipeDiagnostic(
  part: string,
  message: string,
  position?: DiagnosticPosition | null,
  rule: string | null = null,
): string {
  const { line = 1, column = 1 } = position ?? {};
  return `${part}:${line}:${column} ${message} (${rule ?? "parse"})`;
}
