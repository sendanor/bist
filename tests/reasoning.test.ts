import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectiveReasoning, outputBudget, reasoningOptions } from "../src/reasoning.ts";

describe("OpenAI reasoning configuration", () => {
  it("uses the same levels for a known alias and its dated snapshot", () => {
    const levels = ["low", "medium", "high", "xhigh", "max"];
    assert.deepEqual(reasoningOptions("gpt-6.2-sol"), levels);
    assert.deepEqual(reasoningOptions("gpt-6.2-sol-2026-11-01"), levels);
    assert.deepEqual(reasoningOptions("gpt-6-luna"), ["none", ...levels]);
    assert.deepEqual(reasoningOptions("custom-model"), []);
  });

  it("uses supported explicit preferences and falls back to medium when available", () => {
    assert.equal(effectiveReasoning("gpt-6-luna", "none"), "none");
    assert.equal(effectiveReasoning("gpt-6.2-astra", "high"), "high");
    assert.equal(effectiveReasoning("gpt-6.2-astra", "none"), "medium");
    assert.equal(effectiveReasoning("gpt-6.2-sol", ""), "medium");
    assert.equal(effectiveReasoning("custom-model", "low"), undefined);
  });

  it("budgets separately for short and extended reasoning", () => {
    assert.equal(outputBudget(undefined), 2_000);
    assert.equal(outputBudget("none"), 2_000);
    assert.equal(outputBudget("low"), 4_096);
    assert.equal(outputBudget("medium"), 8_192);
    assert.equal(outputBudget("high"), 16_384);
    assert.equal(outputBudget("xhigh"), 25_000);
    assert.equal(outputBudget("max"), 25_000);
  });
});
