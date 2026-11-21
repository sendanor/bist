import english from "./locales/en.json" with { type: "json" };

/**
 * Read English UI copy from the bundled translation catalog.
 * @param {keyof typeof english} key Stable catalog entry for visible UI text.
 */
export function t(key) {
  return english[key];
}
