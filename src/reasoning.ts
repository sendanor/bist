const levels = ["low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof levels)[number] | "none";

const profiles = new Map<string, readonly ReasoningEffort[]>([
  ["gpt-6.2-astra", levels],
  ["gpt-6.2-sol", levels],
  ["gpt-6.1-terra", ["none", ...levels]],
  ["gpt-6-luna", ["none", ...levels]],
  ["gpt-6.1-sol", levels],
  ["gpt-6-sol", ["none", ...levels]],
  ["gpt-6-astra", levels],
]);

/**
 * Return supported reasoning choices for a known model alias or dated snapshot.
 * @param model OpenAI model identifier stored or selected by the maintainer.
 */
export function reasoningOptions(model: string): readonly ReasoningEffort[] {
  return profiles.get(model.replace(/-\d{4}-\d{2}-\d{2}$/u, "")) ?? [];
}

/**
 * Resolve the configured effort or use Bist's medium default for profiled models.
 * @param model Model chosen for this request.
 * @param effort Saved reasoning effort, or an empty string for the default.
 */
export function effectiveReasoning(model: string, effort: string) {
  const options = reasoningOptions(model);
  return options.find((level) => level === effort) ?? options.find((level) => level === "medium");
}

/**
 * Budget space for both the reasoning tokens and the visible response.
 * @param effort The effective reasoning effort sent to the provider.
 */
export function outputBudget(effort: ReasoningEffort | undefined) {
  const budgets = {
    none: 2_000,
    low: 4_096,
    medium: 8_192,
    high: 16_384,
    xhigh: 25_000,
    max: 25_000,
  };
  return effort ? budgets[effort] : 2_000;
}
