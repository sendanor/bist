import { secretKinds } from "./secret-patterns.mjs";

const privateMarkers = [
  /\bMAINTAINER_EMAILS\b/u,
  /\b(?:DATABASE_URL|PRIVATE_KEY|[A-Z][A-Z0-9_]*_(?:SECRET|TOKEN|API_KEY))\b/u,
  /\boai-authenticated-user-(?:email|id)\b/u,
  /sourceMappingURL\s*=/u,
];

/**
 * Reject references that must remain outside the public bundle.
 * @param text The built browser code to inspect.
 * @throws {Error} When the browser code contains prohibited references.
 */
export function assertPublicBundle(text) {
  if (secretKinds(text).length) {
    throw new Error("Browser bundle contains a possible credential. Value omitted.");
  }
  for (const pattern of privateMarkers) {
    if (pattern.test(text)) {
      throw new Error(
        `Browser bundle contains a private setting, credential, or source map marker: ${pattern}`,
      );
    }
  }
}
