# Working on Bist

Bist is a public, open-source project. Treat everything in Git and every artifact
built for release as public.

- Never commit secrets. This includes API keys, access tokens, passwords, private
  keys, session cookies, database credentials, and environment files with real
  values. The same rule applies to fixtures, logs, documentation, and build output.
- Store deployment-only secrets in the hosting platform's secret store or in
  ignored local configuration. Encrypt administrator-editable credentials
  before saving them to the application database. Use synthetic values or
  placeholders in examples. Document environment variable names only.
- Run `npm run check:secrets` before staging or committing changes. A clean scan
  does not replace reviewing the diff. If a real secret reaches Git, revoke or
  rotate it promptly and coordinate removal from history. Deleting the current
  file leaves earlier copies in Git.
- Document named JS and TS callables, including methods and test helpers, with JSDoc.
  Explain their purpose and each parameter. Describe applicable constraints, side
  effects, and explicit exceptions.
- Run `npm run check` and `npm test` for code changes. See [QUALITY.md](QUALITY.md)
  for the checks and their scope.
- Always stage and commit your changes when the task is complete. Keep each
  commit small and focused, and use a message that describes what it changes.
- After validating and committing application changes, deploy the matching
  source to the existing [Code Cookbook test site](https://adaptable-code-cookbook.jheusala.chatgpt.site/).
  Preserve its access settings and confirm the new version is live.
