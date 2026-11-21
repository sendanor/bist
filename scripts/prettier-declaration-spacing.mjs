import { parsers as babel } from "prettier/plugins/babel";
import { parsers as typescript } from "prettier/plugins/typescript";
import { spaceDeclarations } from "../src/quality/declaration-spacing.js";

export const options = {
  blankLinesBetweenDeclarations: {
    type: "boolean",
    category: "Global",
    default: false,
    description: "Separate neighboring JavaScript and TypeScript declarations by a blank line.",
  },
};

/**
 * Extend a built-in Prettier parser with optional spacing for declarations.
 * @param parser Built-in parser whose syntax and printer remain in use.
 */
function withDeclarationSpacing(parser) {
  return {
    ...parser,
    /**
     * Add blank lines before parsing while preserving the original language support.
     * @param text The original source supplied to Prettier.
     * @param options Active Prettier settings and source path.
     */
    async preprocess(text, options) {
      const source = parser.preprocess ? await parser.preprocess(text, options) : text;
      return options.blankLinesBetweenDeclarations
        ? spaceDeclarations(source, options.filepath)
        : source;
    },
  };
}

export const parsers = {
  babel: withDeclarationSpacing(babel.babel),
  "babel-ts": withDeclarationSpacing(babel["babel-ts"]),
  typescript: withDeclarationSpacing(typescript.typescript),
};
