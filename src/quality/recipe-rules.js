import { findDuplicates } from "./duplicates.js";

export const virtualFiles = Object.freeze({
  source: "source.tsx",
  interface: "interface.d.ts",
  tests: "tests.tsx",
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
 * @returns {keyof typeof virtualFiles | undefined}
 */
export function resolveRecipePart(path) {
  return /** @type {keyof typeof virtualFiles | undefined} */ (relativeParts.get(path));
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
    create(context) {
      function inspect(node) {
        const path = node?.value;
        if (typeof path !== "string") {
          context.report({
            node,
            message: "Use a literal module path so the dependency can be verified.",
          });
          return;
        }
        const origin = context.filename;
        const target = resolveRecipePart(path);
        let message;
        if (target) {
          if (!context.settings.cookbookParts.includes(target)) {
            message = `Recipe part '${target}' is missing.`;
          } else if (virtualFiles[target] === origin) {
            message = "A part cannot import itself.";
          } else if (
            (origin === virtualFiles.source && target === "tests") ||
            (origin === virtualFiles.interface && target !== "interface")
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
        ImportDeclaration(node) {
          inspect(node.source);
        },
        ExportNamedDeclaration(node) {
          if (node.source) {
            inspect(node.source);
          }
        },
        ExportAllDeclaration(node) {
          inspect(node.source);
        },
        ImportExpression(node) {
          inspect(node.source);
        },
        TSImportType(node) {
          inspect(node.source ?? node.argument?.literal ?? node.argument);
        },
        TSExternalModuleReference(node) {
          inspect(node.expression);
        },
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
    create(context) {
      return {
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
