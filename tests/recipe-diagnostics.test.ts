import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeRecipeDiagnostic, recipeErrorMessage } from "../src/quality/recipe-diagnostics.ts";

describe("recipe validation diagnostics", () => {
  it("labels errors without source coordinates as parser failures at the start of the part", () => {
    assert.equal(
      describeRecipeDiagnostic("source", "Parser unavailable"),
      "source:1:1 Parser unavailable (parse)",
    );
    assert.equal(
      describeRecipeDiagnostic("tests", "Unexpected token", { line: 3 }),
      "tests:3:1 Unexpected token (parse)",
    );
    assert.equal(
      describeRecipeDiagnostic("interface", "Unexpected token", { column: 4 }, null),
      "interface:1:4 Unexpected token (parse)",
    );
  });

  it("preserves lint rule names and coordinates", () => {
    assert.equal(
      describeRecipeDiagnostic(
        "source",
        "Undeclared value reference.",
        { line: 2, column: 7 },
        "quality/undeclared-value",
      ),
      "source:2:7 Undeclared value reference. (quality/undeclared-value)",
    );
  });

  it("keeps validation error detail without disclosing non-Error thrown values", () => {
    assert.equal(
      recipeErrorMessage(new Error("Provide at least one part.")),
      "Provide at least one part.",
    );
    assert.equal(
      recipeErrorMessage({ message: "Fixture with an untrusted message" }),
      "Recipe validation failed.",
    );
  });
});
