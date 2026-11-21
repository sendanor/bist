export default {
  extends: ["stylelint-config-standard"],
  rules: {
    "selector-class-pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    "selector-id-pattern": null,
    "no-descending-specificity": null,
    "no-duplicate-selectors": [true, { severity: "warning" }],
    "media-feature-range-notation": "prefix",
  },
};
