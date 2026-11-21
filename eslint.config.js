import eslint from "@eslint/js";
import typescript from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { qualityRules } from "./src/quality/rules.js";

const shared = Object.fromEntries(
  Object.keys(qualityRules).map((name) => [`quality/${name}`, "warn"]),
);

export default [
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  {
    files: ["**/*.{js,mjs,jsx,ts,tsx}"],
    languageOptions: {
      parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.node,
    },
    plugins: {
      "@typescript-eslint": typescript,
      "react-hooks": hooks,
      quality: { rules: qualityRules },
    },
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
    rules: {
      ...eslint.configs.recommended.rules,
      ...shared,
      "quality/directives": "error",
      "quality/no-loose-return": "error",
      "quality/explicit-any": "error",
      "quality/localize-jsx": "error",
      "quality/browser-boundaries": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-unused-vars": "off",
      "no-alert": "error",
      curly: "error",
      "no-nested-ternary": "warn",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: { "no-undef": "off", "no-redeclare": "off" },
  },
  {
    files: ["src/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ["scripts/**", "tests/**", "**/*.config.js", "src/quality/**", "src/assets.d.ts"],
    rules: {
      "quality/documentation": "off",
      "quality/document-throws": "off",
      "quality/named-guards": "off",
    },
  },
  {
    files: ["tests/**", "scripts/smoke.mjs", "src/assets.d.ts"],
    rules: { "quality/function-size": "off", "quality/file-size": "off" },
  },
];
