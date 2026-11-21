import { format } from "prettier/standalone";
import * as postcss from "prettier/plugins/postcss";
import { lexer, parse, walk, type CssNode } from "css-tree";

export interface StyleFinding {
  readonly check: "cssClasses" | "cssValidation";
  readonly message: string;
}

/**
 * Attach a recipe stylesheet location to a quality finding.
 * @param check The CSS check that produced the finding.
 * @param message The explanation shown to the recipe author.
 * @param node The parsed CSS node locating the problem.
 */
function finding(check: StyleFinding["check"], message: string, node: CssNode): StyleFinding {
  const { line = 1, column = 1 } = node.loc?.start ?? {};
  return { check, message: `styles:${line}:${column} ${message} (${check})` };
}

/**
 * Format a stylesheet and validate its syntax, selectors, and standard declarations.
 * @param content The authored stylesheet text to parse and format.
 * @param policy The Prettier options from the effective recipe policy.
 */
export async function normalizeStyles(content: string, policy: Parameters<typeof format>[1]) {
  const findings: StyleFinding[] = [];
  const tree = parse(content, {
    positions: true,
    /**
     * Reject CSS comments that disable formatting or lint rules.
     * @param value The comment text emitted by the CSS parser.
     * @param location The optional source location for the comment.
     */
    onComment(value, location) {
      if (/^\s*(?:prettier-ignore|stylelint-(?:disable|enable))\b/u.test(value)) {
        const error = new Error("Stylesheet formatting and lint overrides are prohibited.");
        throw Object.assign(error, location?.start);
      }
    },
    /**
     * Abort recipe validation instead of accepting recovered CSS syntax.
     * @param error The syntax error emitted by the CSS parser.
     */
    onParseError(error) {
      throw error;
    },
  });
  walk(tree, (node) => {
    if (node.type === "ClassSelector" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(node.name)) {
      findings.push(
        finding("cssClasses", `Use a lowercase, hyphenated class name for '${node.name}'.`, node),
      );
    }
    if (node.type === "Declaration" && !/^(?:--|-[a-z]+-)/u.test(node.property)) {
      const result = lexer.matchProperty(node.property, node.value);
      if (result.error && !result.error.message.includes("var()")) {
        findings.push(finding("cssValidation", result.error.message.split("\n")[0], node));
      }
    }
  });
  const text = await format(content, { ...policy, parser: "css", plugins: [postcss] });
  return { text, findings };
}
