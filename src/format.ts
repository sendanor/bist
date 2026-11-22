import { isRecord, isString } from "./guards";
import { isRecipeFileText } from "./recipe-file.ts";
import { format } from "prettier/standalone";
import * as typescript from "prettier/plugins/typescript";
import * as babel from "prettier/plugins/babel";
import * as graphql from "prettier/plugins/graphql";
import * as html from "prettier/plugins/html";
import * as markdown from "prettier/plugins/markdown";
import * as postcss from "prettier/plugins/postcss";
import * as yaml from "prettier/plugins/yaml";
import * as glimmer from "prettier/plugins/glimmer";
import * as angular from "prettier/plugins/angular";
import * as estree from "prettier/plugins/estree";

import { Linter } from "eslint-linter-browserify";
import type { Linter as ESLintConfig, SourceCode } from "eslint";
import { analyze } from "@typescript-eslint/scope-manager";
import { visitorKeys } from "@typescript-eslint/visitor-keys";
import { bundledRules, type Policy } from "./code-policy";
import { normalizeStyles } from "./quality/css";
import { defaultRecipeNames, virtualFiles } from "./quality/recipe-rules.js";
import { checkRecipeTypes } from "./quality/recipe-types";
import { spaceDeclarations } from "./quality/declaration-spacing.js";

export const parts = [
  "source",
  "interface",
  "tests",
  "documentation",
  "instructions",
  "styles",
] as const;
export type Part = (typeof parts)[number];

export type RecipeFileNames = Partial<Record<Part, string>>;

const extensions: Readonly<Record<Part, RegExp>> = {
  source: /\.(?:[cm]?[jt]s|[jt]sx)$/u,
  tests: /\.(?:[cm]?[jt]s|[jt]sx)$/u,
  interface: /\.(?:ts|[cm]ts)$/u,
  styles: /\.css$/u,
  documentation: /\.(?:md|markdown|txt)$/u,
  instructions: /\.(?:md|markdown|txt)$/u,
};

/**
 * Resolve optional custom filenames for the included parts, preserving inherited names.
 * @param value Submitted filename overrides, with an empty string restoring the default.
 * @param included Parts containing content in the current submission.
 * @param inherited Filenames from the previous edit or base recipe.
 * @throws {Error} When a name is unsupported, targets an absent part or collides with another name.
 */
export function recipeFileNames(
  value: unknown,
  included: readonly Part[],
  inherited: RecipeFileNames,
): RecipeFileNames {
  if (value !== undefined && !isRecord(value)) {
    throw new Error("Provide a fileNames object.");
  }
  const overrides = value ?? {};
  if (Object.keys(overrides).some((part) => !included.some((name) => name === part))) {
    throw new Error("Filenames must refer to parts included in this recipe.");
  }
  const used = new Set<string>();
  const names: RecipeFileNames = {};
  for (const part of included) {
    const name = Object.hasOwn(overrides, part) ? overrides[part] : inherited[part];
    const filename = name === "" || name === undefined ? defaultRecipeNames[part] : name;
    if (
      !isString(filename) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(filename) ||
      !extensions[part].test(filename)
    ) {
      throw new Error(`Use a filename with a supported extension and no directory for ${part}.`);
    }
    const canonical = filename.toLowerCase();
    if (used.has(canonical)) {
      throw new Error(`Filename '${filename}' is already used by another part.`);
    }
    used.add(canonical);
    names[part] = filename;
  }
  return names;
}

/**
 * Keep diagnostic messages within the response's display budget.
 * @param messages The complete list of findings in report order.
 */
function limitDiagnostics(messages: readonly string[]) {
  const visible = messages.slice(0, 20);
  if (messages.length > visible.length) {
    visible.push(`Plus ${messages.length - visible.length} more violations.`);
  }
  return visible;
}

/**
 * Apply the maintainer's policy to authored recipe files before saving.
 * @param value The unvalidated snapshot with authored files by part.
 * @param policy The effective lint and formatting policy for the revision.
 * @param requestedNames Optional filename overrides for the submitted parts.
 * @param inheritedNames Previous filenames, used when an override is omitted.
 */
export async function normalizeFiles(
  value: unknown,
  policy: Policy,
  requestedNames: unknown,
  inheritedNames: RecipeFileNames,
) {
  const { blankLinesBetweenDeclarations, ...prettier } = policy.prettier;
  if (!isRecord(value)) {
    throw new Error("Provide a files object.");
  }
  const result: Partial<Record<Part, string>> = {};
  const warnings: string[] = [];
  const errors: string[] = [];
  const sources: Partial<Record<keyof typeof virtualFiles, string>> = {};
  for (const [key, content] of Object.entries(value)) {
    if (!parts.some((part) => part === key) || !isRecipeFileText(content)) {
      throw new Error("Use supported file parts of at most 12 KB each.");
    }
  }
  const recipeFiles = parts.flatMap((part) => {
    const content = value[part];
    return isString(content) && content.trim() ? [{ part, content }] : [];
  });
  const recipeParts = recipeFiles.map(({ part }) => part);
  if (!recipeParts.length) {
    throw new Error("Provide at least one non-empty recipe part.");
  }
  const fileNames = recipeFileNames(requestedNames, recipeParts, inheritedNames);
  const hasTypeScript = recipeParts.some((part) => Object.hasOwn(virtualFiles, part));
  const linter = hasTypeScript ? new Linter({ configType: "eslintrc" }) : null;
  if (linter) {
    for (const [name, rule] of Object.entries(bundledRules)) {
      linter.defineRule(name, rule);
    }
  }
  for (const { part: key, content } of recipeFiles) {
    if (key === "documentation" || key === "instructions") {
      result[key] = content.replace(/\r\n?/g, "\n").trimEnd() + "\n";
      continue;
    }
    if (key === "styles") {
      try {
        const { text, findings } = await normalizeStyles(content, prettier);
        if (!isRecipeFileText(text)) {
          throw new Error("Styles exceed 12 KB after formatting.");
        }
        result[key] = text;
        for (const { check, message } of findings) {
          if (policy.quality[check] === "error") {
            errors.push(message);
          }
          if (policy.quality[check] === "warn") {
            warnings.push(message);
          }
        }
      } catch (error) {
        const {
          line = 1,
          column = 1,
          message,
        } = error as Error & { line?: number; column?: number };
        throw new Error(`styles:${line}:${column} ${message} (css-syntax)`);
      }
      continue;
    }
    const part = key as keyof typeof virtualFiles;
    const filename = fileNames[part] ?? virtualFiles[part];
    const rules = { ...policy.eslint, ...policy.overrides[part] };
    sources[part] = content;
    let formatted: string;
    let lintText = content;
    let hasFormatIgnore = false;
    let ast: undefined | Awaited<ReturnType<typeof typescript.parsers.typescript.parse>>;
    try {
      const capture = {
        parsers: {
          typescript: {
            ...typescript.parsers.typescript,
            /**
             * Capture the TypeScript parse result while Prettier formats a part.
             * @param text The recipe source passed to Prettier.
             * @param options Parser options supplied by the formatter.
             */
            async parse(
              text: string,
              options: Parameters<typeof typescript.parsers.typescript.parse>[1],
            ) {
              const parsed = await typescript.parsers.typescript.parse(text, options);
              hasFormatIgnore =
                parsed.comments?.some(
                  (comment: { value: string }) => comment.value.trim() === "prettier-ignore",
                ) ?? false;
              if (Object.keys(rules).length) {
                ast = structuredClone(parsed);
                lintText = text;
              }
              return parsed;
            },
          },
        },
      };
      formatted = await format(content, {
        ...prettier,
        parser: "typescript",
        plugins: [
          typescript,
          estree,
          angular,
          glimmer,
          yaml,
          postcss,
          markdown,
          html,
          graphql,
          babel,
          capture,
        ],
      });
    } catch (error) {
      const { loc, message } = error as Error & {
        loc?: { start?: { line: number; column: number } };
      };
      throw new Error(
        `${key}:${loc?.start?.line ?? 1}:${loc?.start?.column ?? 1} ${message.split("\n")[0]} (parse)`,
      );
    }
    if (hasFormatIgnore) {
      throw new Error(`${key} contains a prettier-ignore directive.`);
    }
    if (ast && linter) {
      // The legacy API runs rules with options validated by Code Cookbook
      // without compiling schemas with dynamic code generation in the Worker.
      const lintAst = ast;
      linter.defineParser("cookbook-typescript", {
        /** Pass the captured syntax and scope information to ESLint. */
        parseForESLint() {
          return {
            ast: lintAst,
            visitorKeys: visitorKeys as unknown as SourceCode.VisitorKeys,
            scopeManager: analyze(lintAst, {
              sourceType: "module",
            }) as unknown as ESLintConfig.ESLintParseResult["scopeManager"],
          };
        },
      });
      const messages: {
        severity: number;
        line?: number;
        column?: number;
        message: string;
        ruleId: string | null;
      }[] = linter.verify(
        lintText,
        {
          parser: "cookbook-typescript",
          env: { es2022: true },
          rules,
          globals: policy.globals,
          settings: {
            ...policy.settings,
            cookbookParts: recipeParts,
            cookbookFileNames: fileNames,
          },
        },
        { filename, allowInlineConfig: false },
      );
      /**
       * Format a lint diagnostic with its recipe part and location.
       * @param message The lint finding emitted for the current part.
       */
      const describe = (message: (typeof messages)[number]) =>
        `${key}:${message.line}:${message.column} ${message.message} (${message.ruleId ?? "parse"})`;
      for (const message of messages) {
        (message.severity === 2 ? errors : warnings).push(describe(message));
      }
    }
    const spaced = blankLinesBetweenDeclarations
      ? spaceDeclarations(formatted, filename)
      : formatted;
    if (!isRecipeFileText(spaced)) {
      throw new Error(`${key} exceeds 12 KB after formatting.`);
    }
    result[key as Part] = spaced;
  }
  if (hasTypeScript && policy.quality.typeCheck !== "off" && errors.length === 0) {
    const target = policy.quality.typeCheck === "error" ? errors : warnings;
    target.push(...checkRecipeTypes(sources, 20, fileNames));
  }
  if (policy.quality.warningsAsErrors) {
    errors.push(...warnings);
  }
  if (errors.length) {
    throw new Error(limitDiagnostics(errors).join("\n"));
  }
  return { files: result, fileNames, warnings: limitDiagnostics(warnings) };
}
