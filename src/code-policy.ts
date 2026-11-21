import { Linter } from "eslint-linter-browserify";
import type { Linter as ESLintConfig, Rule } from "eslint";
import hooks from "eslint-plugin-react-hooks";
import { qualityRules } from "./quality/rules.js";
import { recipeRules } from "./quality/recipe-rules.js";
import { Validator } from "jsonschema";

export const prettierOptions = [
  { key: "bracketSameLine", label: "Closing bracket on the same line", default: false },
  { key: "bracketSpacing", label: "Spaces inside object braces", default: true },
  {
    key: "objectWrap",
    label: "Object wrapping",
    default: "preserve",
    choices: ["preserve", "collapse"],
  },
  {
    key: "quoteProps",
    label: "Property quotes",
    default: "as-needed",
    choices: ["as-needed", "consistent", "preserve"],
  },
  { key: "jsxSingleQuote", label: "Single quotes in JSX", default: false },
  { key: "singleAttributePerLine", label: "One JSX attribute per line", default: true },
  {
    key: "experimentalOperatorPosition",
    label: "Wrapped operator position",
    default: "end",
    choices: ["end", "start"],
  },
  { key: "experimentalTernaries", label: "Experimental ternary formatting", default: false },
  {
    key: "embeddedLanguageFormatting",
    label: "Format embedded languages",
    default: "auto",
    choices: ["auto", "off"],
  },
  { key: "endOfLine", label: "Line endings", default: "lf", choices: ["lf", "crlf", "cr", "auto"] },
  { key: "insertPragma", label: "Insert format pragma", default: false },
  { key: "singleQuote", label: "Single quotes", default: false },
  { key: "semi", label: "Semicolons", default: true },
  { key: "useTabs", label: "Indent with tabs", default: false },
  { key: "printWidth", label: "Preferred line width", default: 100, min: 40, max: 200 },
  { key: "tabWidth", label: "Indent width", default: 2, min: 1, max: 8 },
  {
    key: "trailingComma",
    label: "Trailing commas",
    default: "all",
    choices: ["all", "es5", "none"],
  },
  {
    key: "arrowParens",
    label: "Arrow function parentheses",
    default: "always",
    choices: ["always", "avoid"],
  },
] as const;

const coreRules: Map<string, { meta?: { schema?: unknown } }> = new Linter({
  configType: "eslintrc",
}).getRules();
const customRules = {
  ...Object.fromEntries(
    Object.entries(qualityRules).map(([name, rule]) => ["quality/" + name, rule]),
  ),
  ...Object.fromEntries(
    Object.entries(recipeRules).map(([name, rule]) => ["quality/" + name, rule]),
  ),
  ...Object.fromEntries(
    Object.entries(hooks.rules).map(([name, rule]) => ["react-hooks/" + name, rule]),
  ),
  "quality/undeclared-value": {
    meta: { schema: [] },
    create(context: ValueRuleContext) {
      return {
        "Program:exit"() {
          for (const reference of context.sourceCode.scopeManager.globalScope.through) {
            if (reference.isValueReference) {
              context.report({
                node: reference.identifier,
                message: "Undeclared value reference.",
              });
            }
          }
        },
      };
    },
  },
};
export const bundledRules = customRules as unknown as Record<string, Rule.RuleModule>;
interface ValueRuleContext {
  readonly sourceCode: {
    readonly scopeManager: {
      readonly globalScope: {
        readonly through: readonly {
          readonly isValueReference: boolean;
          readonly identifier: object;
        }[];
      };
    };
  };
  report(diagnostic: ValueDiagnostic): void;
}
interface ValueDiagnostic {
  readonly node: object;
  readonly message: string;
}
for (const [name, rule] of Object.entries(bundledRules)) {
  coreRules.set(name, rule);
}
export const eslintRules = [...coreRules.keys()].sort();
const schemaValidator = new Validator();

type PolicyValue = string | number | boolean;
type Severity = "off" | "warn" | "error";
export const qualityOptions = [
  { key: "typeCheck", label: "TypeScript types across recipe code parts", default: "warn" },
  { key: "cssClasses", label: "Lowercase, hyphenated CSS class names", default: "error" },
  { key: "cssValidation", label: "CSS property and value validation", default: "error" },
] as const;
type QualityKey = (typeof qualityOptions)[number]["key"];
type PartName = "source" | "interface" | "tests";
export type Policy = {
  prettier: Record<string, PolicyValue>;
  eslint: ESLintConfig.RulesRecord;
  globals: NonNullable<ESLintConfig.LegacyConfig["globals"]>;
  settings: Record<string, unknown>;
  overrides: Partial<Record<PartName, ESLintConfig.RulesRecord>>;
  quality: Record<QualityKey, Severity> & { warningsAsErrors: boolean };
};

function options(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a settings object.");
  }
  return value as Record<string, unknown>;
}

function validateRules(eslint: Record<string, unknown>): Policy["eslint"] {
  const rules: Policy["eslint"] = Object.create(null);
  for (const [name, config] of Object.entries(eslint)) {
    const rule = coreRules.get(name);
    if (!rule) {
      throw new Error(`Unknown bundled ESLint rule ${name}.`);
    }
    const [rawSeverity, ...args] = Array.isArray(config) ? config : [config];
    const severity = typeof rawSeverity === "boolean" ? (rawSeverity ? 2 : 0) : rawSeverity;
    if (![0, 1, 2, "off", "warn", "error"].includes(severity)) {
      throw new Error(`Invalid severity for ${name}.`);
    }
    const schema = rule.meta?.schema;
    if (args.length && schema !== false) {
      const normalized = Array.isArray(schema)
        ? { type: "array", items: schema, additionalItems: false }
        : (schema ?? { type: "array", maxItems: 0 });
      const result = schemaValidator.validate(
        args,
        normalized as Parameters<Validator["validate"]>[1],
      );
      if (!result.valid) {
        throw new Error(`Invalid options for ${name}: ${result.errors[0].message}`);
      }
    }
    rules[name] = (
      Array.isArray(config) ? [severity, ...args] : severity
    ) as ESLintConfig.RuleEntry;
  }
  return rules;
}

function rejectKeys(input: Record<string, unknown>, keys: readonly string[], label: string) {
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) {
      throw new Error(`Unsupported ${label} field ${key}.`);
    }
  }
}

export function validateCodePolicy(value: unknown): Policy {
  const input = options(value);
  rejectKeys(
    input,
    ["prettier", "eslint", "globals", "settings", "overrides", "quality"],
    "code policy",
  );
  const prettier = options(input.prettier);
  const eslint = options(input.eslint);
  for (const key of Object.keys(prettier)) {
    if (!prettierOptions.some((option) => option.key === key)) {
      throw new Error(`Unsupported Prettier setting ${key}.`);
    }
  }
  const formatted: Policy["prettier"] = {};
  for (const option of prettierOptions) {
    const setting = Object.hasOwn(prettier, option.key) ? prettier[option.key] : option.default;
    const valid =
      "choices" in option
        ? option.choices.some((choice) => choice === setting)
        : "min" in option
          ? typeof setting === "number" &&
            Number.isInteger(setting) &&
            setting >= option.min &&
            setting <= option.max
          : typeof setting === "boolean";
    if (!valid) {
      throw new Error(`Invalid setting for ${option.label}.`);
    }
    formatted[option.key] = setting as PolicyValue;
  }
  const globals: Policy["globals"] = {};
  for (const [name, setting] of Object.entries(options(input.globals ?? {}))) {
    if ([true, false, "readonly", "writable", "off"].includes(setting as never)) {
      Object.defineProperty(globals, name, { value: setting, enumerable: true });
    } else {
      throw new Error(`Invalid ESLint global setting for ${name}.`);
    }
  }
  const overrides = options(input.overrides ?? {});
  rejectKeys(overrides, ["source", "interface", "tests"], "recipe override");
  const qualityInput = options(input.quality ?? {});
  rejectKeys(
    qualityInput,
    [...qualityOptions.map((option) => option.key), "warningsAsErrors"],
    "quality",
  );
  const warningsAsErrors = qualityInput.warningsAsErrors ?? false;
  if (typeof warningsAsErrors !== "boolean") {
    throw new Error("warningsAsErrors must be a boolean.");
  }
  const quality = { warningsAsErrors } as Policy["quality"];
  for (const option of qualityOptions) {
    const setting = Object.hasOwn(qualityInput, option.key)
      ? qualityInput[option.key]
      : option.default;
    if (setting !== "off" && setting !== "warn" && setting !== "error") {
      throw new Error(`Invalid severity for ${option.key}. Use off, warn, or error.`);
    }
    quality[option.key] = setting;
  }
  return {
    prettier: formatted,
    eslint: validateRules(eslint),
    globals,
    settings: options(input.settings ?? {}),
    overrides: Object.fromEntries(
      Object.entries(overrides).map(([part, rules]) => [part, validateRules(options(rules))]),
    ),
    quality,
  };
}

export const defaultCodePolicy = validateCodePolicy({
  prettier: Object.fromEntries(prettierOptions.map((option) => [option.key, option.default])),
  eslint: {
    ...Object.fromEntries(Object.keys(qualityRules).map((name) => ["quality/" + name, "warn"])),
    "quality/directives": "error",
    "quality/explicit-any": "warn",
    "quality/no-loose-return": "error",
    "quality/undeclared-value": "error",
    "quality/recipe-imports": "error",
    "quality/duplicate-code": "error",
    "quality/localize-jsx": "warn",
    "quality/browser-boundaries": "error",
    "no-unused-vars": [
      "warn",
      { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none" },
    ],
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "no-alert": "error",
    "no-const-assign": "error",
    "no-dupe-keys": "error",
    "no-debugger": "error",
    "no-sparse-arrays": "error",
    "no-unreachable": "error",
    "no-unsafe-finally": "error",
    curly: "error",
    "no-nested-ternary": "warn",
  },
  overrides: {
    interface: { "quality/duplicate-code": "off", "quality/file-size": "off" },
    tests: {
      "quality/duplicate-code": "warn",
      "quality/documentation": "off",
      "quality/document-throws": "off",
      "quality/function-size": "off",
      "quality/file-size": "off",
    },
  },
  globals: {
    alert: "readonly",
    console: "readonly",
    window: "readonly",
    document: "readonly",
    globalThis: "readonly",
    fetch: "readonly",
    URL: "readonly",
    Request: "readonly",
    Response: "readonly",
    TextEncoder: "readonly",
    TextDecoder: "readonly",
    ReadableStream: "readonly",
    crypto: "readonly",
    setTimeout: "readonly",
    clearTimeout: "readonly",
    structuredClone: "readonly",
    AbortController: "readonly",
  },
});
