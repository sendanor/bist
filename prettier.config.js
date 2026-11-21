export default {
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  endOfLine: "lf",
  printWidth: 100,
  singleAttributePerLine: true,
  bracketSameLine: false,
  plugins: ["./scripts/prettier-declaration-spacing.mjs"],
  blankLinesBetweenDeclarations: true,
};
