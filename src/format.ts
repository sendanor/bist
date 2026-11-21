import { isRecord, isString } from "./guards";
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
import { bundledRules, defaultCodePolicy, type Policy } from "./code-policy";
import { normalizeStyles } from "./quality/css";
import { virtualFiles } from "./quality/recipe-rules.js";
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
 */
export async function normalizeFiles(value: unknown, policy: Policy = defaultCodePolicy) {
  const { blankLinesBetweenDeclarations, ...prettier } = policy.prettier;
  if (!isRecord(value)) {
    throw new Error("Provide a files object.");
  }
  const files = value;
  const result: Partial<Record<Part, string>> = {};
  const encoder = new TextEncoder();
  const warnings: string[] = [];
  const errors: string[] = [];
  const sources: Partial<Record<keyof typeof virtualFiles, string>> = {};
  for (const [key, content] of Object.entries(files)) {
    if (
      !parts.some((part) => part === key) ||
      !isString(content) ||
      encoder.encode(content).length > 12000
    ) {
      throw new Error("Use supported file parts of at most 12 KB each.");
    }
  }
  const recipeParts = parts.filter((part) => isString(files[part]) && files[part].trim());
  if (!recipeParts.length) {
    throw new Error("Provide at least one non-empty recipe part.");
  }
  const hasTypeScript = recipeParts.some((part) => Object.hasOwn(virtualFiles, part));
  const linter = hasTypeScript ? new Linter({ configType: "eslintrc" }) : null;
  if (linter) {
    for (const [name, rule] of Object.entries(bundledRules)) {
      linter.defineRule(name, rule);
    }
  }
  for (const key of recipeParts) {
    const content = files[key];
    if (!isString(content)) {
      continue;
    }
    if (key === "documentation" || key === "instructions") {
      result[key] = content.replace(/\r\n?/g, "\n").trimEnd() + "\n";
      continue;
    }
    if (key === "styles") {
      try {
        const { text, findings } = await normalizeStyles(content, prettier);
        if (encoder.encode(text).length > 12000) {
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
      if (!Array.isArray(ast.tokens)) {
        throw new Error("TypeScript lint tokens are unavailable.");
      }
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
          settings: { ...policy.settings, cookbookParts: recipeParts },
        },
        { filename: virtualFiles[part], allowInlineConfig: false },
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
      ? spaceDeclarations(formatted, virtualFiles[part])
      : formatted;
    if (encoder.encode(spaced).length > 12000) {
      throw new Error(`${key} exceeds 12 KB after formatting.`);
    }
    result[key as Part] = spaced;
  }
  if (hasTypeScript && policy.quality.typeCheck !== "off" && errors.length === 0) {
    const target = policy.quality.typeCheck === "error" ? errors : warnings;
    target.push(...checkRecipeTypes(sources, 20));
  }
  if (policy.quality.warningsAsErrors) {
    errors.push(...warnings);
  }
  if (errors.length) {
    throw new Error(limitDiagnostics(errors).join("\n"));
  }
  return { files: result, warnings: limitDiagnostics(warnings) };
}
