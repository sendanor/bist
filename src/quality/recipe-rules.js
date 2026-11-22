import { findDuplicates } from "./duplicates.js";

export const virtualFiles = Object.freeze({
  source: "source.tsx",
  interface: "interface.d.ts",
  tests: "tests.tsx",
});

export const defaultRecipeNames = Object.freeze({
  ...virtualFiles,
  styles: "styles.css",
  documentation: "README.md",
  instructions: "AGENTS.md",
});

const relativeParts = new Map([
  ["./source", "source"],
  ["./source.ts", "source"],
  ["./source.tsx", "source"],
  ["./source.js", "source"],
  ["./interface", "interface"],
  ["./interface.d.ts", "interface"],
  ["./interface.js", "interface"],
  ["./tests", "tests"],
  ["./tests.ts", "tests"],
  ["./tests.tsx", "tests"],
  ["./tests.js", "tests"],
]);

/**
 * Resolve a supported file alias within a recipe snapshot.
 * @param {string} path Literal module specifier written by the author.
 * @param {Partial<Record<keyof typeof virtualFiles, string>>} names Custom names for submitted parts.
 * @returns {keyof typeof virtualFiles | undefined}
 */
export function resolveRecipePart(path, names = {}) {
  const entries = Object.entries(virtualFiles);
  const exact = entries.find(([part, fallback]) => path === "./" + (names[part] ?? fallback));
  if (exact) {
    return /** @type {keyof typeof virtualFiles} */ (exact[0]);
  }
  const legacy = relativeParts.get(path);
  if (legacy && (!names[legacy] || names[legacy] === virtualFiles[legacy])) {
    return /** @type {keyof typeof virtualFiles} */ (legacy);
  }
  const matches = entries.filter(([part]) => {
    const name = names[part];
    if (!name) {
      return false;
    }
    const stem = name.replace(/(?:\.d)?\.[^.]+$/u, "");
    const js = name.endsWith(".mts") ? ".mjs" : name.endsWith(".cts") ? ".cjs" : ".js";
    return path === "./" + stem || path === "./" + stem + js;
  });
  return matches.length === 1
    ? /** @type {keyof typeof virtualFiles} */ (matches[0][0])
    : undefined;
}

export const recipeRules = {
  "recipe-imports": {
    meta: {
      schema: [
        {
          type: "object",
          properties: { external: { type: "array", items: { type: "string" }, uniqueItems: true } },
          additionalProperties: false,
        },
      ],
    },
    /**
     * Register listeners that validate dependencies within a recipe snapshot.
     * @param context The ESLint context with the authored recipe's file list and rule options.
     */
    create(context) {
      /**
       * Validate a module specifier against available recipe parts and external allowances.
       * @param node The module expression or fallback node used for the diagnostic.
       */
      function inspect(node) {
        const path = node?.value;
        if (typeof path !== "string") {
          context.report({
            node,
            message: "Use a literal module path so the dependency can be verified.",
          });
          return;
        }
        const names = context.settings.cookbookFileNames;
        const origin = Object.keys(virtualFiles).find(
          (part) => (names?.[part] ?? virtualFiles[part]) === context.filename,
        );
        const target = resolveRecipePart(path, names);
        let message;
        if (target) {
          if (!context.settings.cookbookParts.includes(target)) {
            message = `Recipe part '${target}' is missing.`;
          } else if (target === origin) {
            message = "A part cannot import itself.";
          } else if (
            (origin === "source" && target === "tests") ||
            (origin === "interface" && target !== "interface")
          ) {
            message =
              "Source cannot depend on its tests, and its public interface must stand on its own.";
          }
        } else if (path.startsWith(".") || path.startsWith("/") || /^[a-z]+:\/\//iu.test(path)) {
          message = `Module '${path}' is outside the recipe or does not name a supported part.`;
        } else if (
          !(
            context.options[0]?.external ?? ["node:assert", "node:assert/strict", "node:test"]
          ).includes(path)
        ) {
          message = `Declare external module '${path}' in the rule's external allowlist.`;
        }
        if (message) {
          context.report({ node, message });
        }
      }
      return {
        /**
         * Validate the dependency of a static import declaration.
         * @param node The import declaration and its module path.
         */
        ImportDeclaration(node) {
          inspect(node.source);
        },

        /**
         * Validate re-exports that name another module.
         * @param node The export declaration that may name a source module.
         */
        ExportNamedDeclaration(node) {
          if (node.source) {
            inspect(node.source);
          }
        },

        /**
         * Validate the dependency of a wildcard re-export.
         * @param node The wildcard export and its source module.
         */
        ExportAllDeclaration(node) {
          inspect(node.source);
        },

        /**
         * Require a verifiable path for a dynamic import.
         * @param node The dynamic import and its source expression.
         */
        ImportExpression(node) {
          inspect(node.source);
        },

        /**
         * Apply recipe import boundaries to TypeScript import types.
         * @param node The TypeScript import type and its module reference.
         */
        TSImportType(node) {
          inspect(node.source);
        },

        /**
         * Validate the path used by a TypeScript import assignment.
         * @param node The external module reference and its path.
         */
        TSExternalModuleReference(node) {
          inspect(node.expression);
        },

        /**
         * Validate dependencies loaded through CommonJS require calls.
         * @param node The call expression whose callee may be require.
         */
        CallExpression(node) {
          if (node.callee.name === "require") {
            inspect(node.arguments[0] ?? node);
          }
        },
      };
    },
  },
  "duplicate-code": {
    meta: { schema: [] },
    /**
     * Register the recipe token duplication check.
     * @param context The ESLint context that provides tokens and diagnostics.
     */
    create(context) {
      return {
        /**
         * Tokenize this part and report any repeated code ranges.
         * @param node The syntax root of the current recipe part.
         */
        Program(node) {
          const tokens = context.sourceCode.getTokens(node).map((token) => ({
            value: token.value,
            line: token.loc.start.line,
            column: token.loc.start.column,
            endLine: token.loc.end.line,
          }));
          for (const match of findDuplicates([{ name: context.filename, tokens }])) {
            context.report({
              node,
              loc: { line: match.line, column: match.column },
              message: `Duplicates ${match.length} tokens starting on line ${match.otherLine}.`,
            });
          }
        },
      };
    },
  },
};
