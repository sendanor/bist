import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeStyles } from "../src/quality/css.ts";

describe("recipe stylesheets", () => {
  it("reports source locations for invalid class names and declarations", async () => {
    const { text, findings } = await normalizeStyles(".Bad_Name{\n color: sideways;\n}", {});
    assert.equal(text, ".Bad_Name {\n  color: sideways;\n}\n");
    assert.equal(findings[0].check, "cssClasses");
    assert.match(findings[0].message, /^styles:1:1 .*Bad_Name/u);
    assert.equal(findings[1].check, "cssValidation");
    assert.match(findings[1].message, /^styles:2:2 /u);
  });

  it("keeps custom properties, vendor prefixes and unresolved CSS variables", async () => {
    const rule = ".recipe-2{--accent:red;-webkit-user-select:none;color:var(--accent)}";
    const { text, findings } = await normalizeStyles(rule, {});
    assert.deepEqual(findings, []);
    assert.match(text, /color: var\(--accent\);/u);
  });

  it("rejects formatting and lint suppression directives at their source location", async () => {
    for (const directive of ["prettier-ignore", "stylelint-disable", "stylelint-enable"]) {
      await assert.rejects(normalizeStyles("\n/* " + directive + " */\na{color:red}", {}), {
        message: "Stylesheet formatting and lint overrides are prohibited.",
        line: 2,
        column: 1,
      });
    }
  });

  it("rejects syntax errors instead of returning the parser's recovered tree", async () => {
    await assert.rejects(normalizeStyles(".recipe { color red; }", {}), { name: "SyntaxError" });
  });
});
