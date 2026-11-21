/**
 * Check whether an input is a string before using its methods.
 * @param value The unvalidated input at the current boundary.
 */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Check whether an input is a non-null, non-array object at a data boundary.
 * @param value The value to narrow before reading its properties.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Check whether an input is an array. Item types still require validation.
 * @param value The value to narrow before reading array items.
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Check a canonical lowercase RFC 9562 version 4 revision ID with the standard variant.
 * @param value The external revision identifier to validate.
 */
export function isRevisionId(
  value: unknown,
): value is `${string}-${string}-${string}-${string}-${string}` {
  return (
    isString(value) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}
