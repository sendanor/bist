import { isRevisionId } from "./guards.ts";

const sections = new Set(["library", "contribute", "mine", "review", "settings", "assistant"]);
const recipeSections = new Set(["library", "mine", "review"]);
const settingsPages = new Set(["openai", "code-policy", "mcp", "llm-review"]);

/**
 * Match a browser pathname against the application routes shared by the shell and the Worker.
 * @param pathname The URL pathname without its query string or fragment.
 */
export function parsePagePath(pathname: string) {
  if (pathname === "/") {
    return { page: "library", section: "library" };
  }
  if (!pathname.startsWith("/")) {
    return null;
  }

  let segments: string[];
  try {
    segments = pathname.slice(1).split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  const [page, first, second, third] = segments;
  if (segments.length === 1 && sections.has(page)) {
    return { page, section: page };
  }
  if (segments.length === 2 && page === "settings" && settingsPages.has(first)) {
    return { page: "settings/" + first, section: "settings" };
  }
  if (segments.length === 4 && page === "recipe" && recipeSections.has(first)) {
    return recipeRoute(page, first, second, third);
  }
  if (segments.length === 3 && (page === "edit" || page === "improve")) {
    return recipeRoute(page, "contribute", first, second);
  }
  return null;
}

/**
 * Validate the slug and revision identifier before serving or rendering a recipe route.
 * @param page The page that reads or edits the snapshot.
 * @param section The navigation section associated with this page.
 * @param slug The decoded recipe identifier.
 * @param revision The decoded revision identifier.
 */
function recipeRoute(page: string, section: string, slug: string, revision: string) {
  return slug.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) && isRevisionId(revision)
    ? { page, section, slug, revision }
    : null;
}
