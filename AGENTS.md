# Working on Bist

Bist is a public, open-source project. Treat everything in Git and every artifact
built for release as public.

- Never commit secrets. This includes API keys, access tokens, passwords, private
  keys, session cookies, database credentials, and environment files with real
  values. The same rule applies to fixtures, logs, documentation, and build output.
- Store real values in the hosting platform's secret store or in ignored local
  configuration. Use clearly synthetic values or placeholders in examples.
  Names of required environment variables may be documented.
- Run `npm run check:secrets` before staging or committing changes. A clean scan
  does not replace reviewing the diff. If a real secret reaches Git, revoke or
  rotate it promptly and coordinate removal from history. Deleting the current
  file leaves earlier copies in Git.
- Run `npm run check` and `npm test` for code changes. See [QUALITY.md](QUALITY.md)
  for the checks and their scope.
