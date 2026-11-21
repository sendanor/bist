const secretPatterns = [
  ["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/u],
  ["OpenAI API key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/u],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ["Slack token", /\bxox[baprs]-[A-Za-z\d-]{12,}\b/u],
  [
    "authenticated URL",
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/:]+:[^\s/@]+@/iu,
  ],
];

export function secretKinds(text) {
  return secretPatterns.filter(([, expression]) => expression.test(text)).map(([kind]) => kind);
}
