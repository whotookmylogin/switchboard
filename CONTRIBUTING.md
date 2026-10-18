# Contributing

Small, focused pull requests are easiest to review.

- **Tests**: run `npm test` before sending a PR. It runs everything under `test/` with
  `node --test`. Add a test when you change behavior.
- **Docs**: keep the JSDoc headers at the top of each `src/` file accurate when you change what a
  module does. The docs under `docs/` are hand-written; keep them in sync with the code when
  behavior changes.
- **No secrets in tests.** Test tokens, keys and fixtures must be obviously fake (`tok-...`,
  `sb_...` generated at runtime). `gitleaks` runs in CI; fake values belong under `test/` only.
- **Big changes**: open an issue first to discuss the approach before writing a lot of code.
