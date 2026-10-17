# Native validation record

Date: 2026-10-15. User requested implementation of the supplied plan, relaxed calculator isolation, no Docker, commit and push.

## Confirmed

- Native install, TypeScript check, Vite production build and SQLite execution on macOS/Node 26.
- State tests: graded confidence, key regrading, transaction retries, stale versions, source identity, set isolation, persisted cursor, removed placeholders, FTS search and import issues.
- Actual online SQLite snapshot, checksummed restore into a new location, and corruption rejection.
- Configured-root path/symlink rejection, stale preview refusal, external-file conflict checks, local edit/import and journal inspection.
- Chromium practice flow: import, wrong answer, correction, confidence, annotations, restart of page state, and blank new set retaining overall status. Mobile page overflow checked.
- Live subscription response using the exact requested Luna model and a completed tool round trip. No credential refresh or writes, and no API-key fallback.
- Synthetic 10,000-question import: 7.5 s; indexed search p95: 3.5 ms; peak RSS: 409 MiB. Native machine-specific result.

## Docker validation, 2026-10-16

Requested: simplify the code, fix bugs found, and test with Docker. The `test` image (Node 24, Debian bookworm) passed the type check, 35 unit tests, the production build and both Chromium browser tests. The `app` image started with a password, rejected unauthenticated and cross-origin requests (including `Origin: null`), imported `examples/case-bank.md` without issues and served the web page with no server errors logged.

Fixed in that pass (each has a regression test in `tests/question-format.test.ts` where it is parser or store behaviour): case passages leaking into later questions and dropping exhibits; solutions swallowing later sections; lowercase, parenthesised and annotated answer keys; extra choice labels merged into the last choice; setext heading titles; removed files not restored by re-import; every question in an edited file getting a new content version; "source order" following import history; editor saves blocked by warnings with no way to accept; identity choices required for every re-imported question; stale identity mappings carried into the next import; Focus cards showing no text; the practice count disagreeing with the set the server builds; `Origin: null` returning 500.

## Limits

The full original release acceptance matrix is not certified. There was no original design file or representative private bank in this folder. Firefox, WebKit, physical-device checks, Linux hosting, HTTPS proxy deployment, 100,000 sections/messages, human grounding review and all account expiration/revocation modes remain unverified. The calculator is a local bounded worker, not a container sandbox.

The app uses SQLite JSON records for versioned objects and whole-record FTS entries. This differs from the proposed fully normalized schema and section chunking. Future work should target observed performance or retrieval failures rather than add infrastructure speculatively.

## Commands

`npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`; `tsx scripts/benchmark.ts` for the synthetic corpus. Detailed transient run output is retained in ignored `logs/` with date/sequence filenames. Browser screenshots and traces stay in ignored test outputs.

A combined run reported an approximately 15-minute wall-clock delay and calculator timeout although a 30-second timer was configured. Do not count that run as passing. The calculator supervisor was reviewed and subsequent clean runs are the verification source; suspected machine suspension is not a proven cause.

GitHub rejected the initial push containing `.github/workflows/check.yml` because the existing OAuth login lacks `workflow` scope. The unchanged workflow is retained as `ops/github-actions-check.yml`; it is an inactive template. No account scopes were changed.
