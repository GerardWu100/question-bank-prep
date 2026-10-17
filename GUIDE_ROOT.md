# Developer guide

## Start here

Read README.md for running, docs/user/question-format.md (with examples/) for bank syntax, and ops/RECOVERY.md for recovery. The original implementation plan remains unchanged as the intended product contract. The app runs natively or from the `app` target of the Dockerfile; the `test` target is the reproducible Linux check. The user explicitly relaxed strict calculator isolation.

The application is a TypeScript workspace: React/Vite in `apps/web`, Fastify in `apps/server`, a subscription adapter in `apps/ai-runtime`, and a disposable Pyodide worker in `apps/calculator`. `packages/domain` owns Markdown parsing and grading. Root scripts own reproducible tests, a synthetic scale benchmark, backup/restore, `find-duplicates` (near-duplicate candidates: stem/choice Jaccard plus a case-passage gate, within a topic), and `check-bank` (runs `parseQuestions` on bank files outside the app, for AI extraction loops).

## Durable state and behavior

`Store` uses one SQLite database, WAL and transactions. It also owns the shared write rules, so routes should call these instead of repeating them: `sql()` (cached prepared statements), `receipt()`/`operation()` (idempotency), `mutation()` (operationId optional) and `idempotent()` (operationId required), `putIndexed()` (any write that changes searchable text or `active`; plain `put()` does not touch the search index), `saveNote()` (note plus `id:version` revision), `deactivateFile()`, and `presentQuestion()` (the only serializer that hides keys; its `revealed` flag is what AI hint mode checks). Libraries, operation receipts and schema versions use relational tables; versioned domain objects use JSON records keyed by library and kind. This is smaller than the normalized schema proposed in the plan. FTS5 stores permitted question text and notes separately from answers and solutions. Do not make the public practice serializer depend on a client-side hidden-answer flag.

Questions carry `topic` and `source` from `pathLabels(file.path)` in `store.ts` (first folder, file name without `.md`); `syncPathLabels` refreshes them on every folder sync because unchanged files skip import. The overview returns a `catalog` of topic/source/chapter rows with answered and total counts for the practice filters, and set responses come from `presentSet`, which adds `itemStatuses` (one grade per question) for the number strip. The client keeps the view in the URL hash (`#/practice/<setId>`, `#/notes`, …) and pushes a history entry per view change. `Markdown.tsx` hides `\$` from remark-math before parsing, because remark-math would otherwise end a formula at an escaped dollar sign.

`reading-routes.ts` serves READING_ROOT read-only (Markdown list, Markdown and raster images by path; traversal, symlinks and SVG refused); `Markdown` resolves relative images against it only when given `readingDirectory`, and the client splits long files at #/## headings into sections of at least 150 lines. A reading chat (`readingPath` + `readingTitle` = "N. heading") is reused per section; each message sends that section's text as `material` (capped at 40,000 characters) and the system prompt uses it instead of a question. KaTeX is pinned to the version rehype-katex uses (0.16.47): the stylesheet must match the markup, or subscripts render at full size on the baseline. `Markdown` repairs common `$$` fence slips from converted notes (see `prepareMarkdown`), wraps `&`-aligned display math in `aligned`, renders ```mermaid blocks with a lazily loaded, strict-mode Mermaid, turns `<br>` into breaks and drops HTML comments; other raw HTML stays escaped. Colours are CSS tokens named after their light value; dark values mirror lightness (`[data-theme]` or the system preference). Font size is the `--font-size` variable set from the header.

Hooks in `app.ts` read route config instead of URL strings: `config.public` skips sign-in, `config.allowWhenArchived` permits writes to an archived library. The overview returns only counts and set summaries; the client asks `POST /sets/preview` for the practice count, so the server's `Store.select` is the single filter implementation.

A question has overall state; each saved set has its own response. `Store.question` and `presentSet` fall back to the overall answer when a set has none, so a new set never looks blank for a question answered elsewhere. The client reuses a set whose filters and size match (chapter decks and custom sets) instead of creating copies, and hides the set list; source editing and the Focus page are gone from the UI (their server routes remain). Answer writes atomically update both, advance the library sequence once, and store an idempotent receipt. Record versions reject stale tabs. Import key corrections derive grades and normalize confidence without advancing answer recency. Frozen sets retain deleted-source placeholders. "Source order" sorts by file path, then position in the file.

Focus items have one shape: `links: [{questionId, contentVersion, answerVersion, annotationVersion?}]`. `Store.focus()` drops deleted items and derives `stale` from those versions; staleness is never stored. Deterministic refresh items also keep `questionId` to find their previous item.

An `Answer (AI)` heading sets `answerByAI` (part of `CONTENT_FIELDS`, so a source key replacing an AI key makes a new revision); the UI badges it. The parser uses a Markdown syntax tree for headings and retains original content slices. A case passage runs to its first Question heading (so exhibits stay in it) and ends at the next heading of the same or shallower depth. Fingerprints include case, stem and choice semantics, exclude keys/solutions, and preserve numbers/operators.

Re-import identity: an incoming question continues an old one automatically when exactly one same-file question has its fingerprint (ties break on title, chapter and case). Previews report this as `identityProposals[].automatic`; the UI asks only about proposals without one, and an unanswered proposal becomes a new question. A question keeps its `contentVersion` (and writes no new revision) unless fingerprint, key, solution, title, chapter or case title changed. A changed choice meaning cannot reuse the old selected label silently. Re-importing an inactive file with identical bytes reactivates it.

## Source ownership

Uploaded Markdown and immutable revisions live in SQLite. Configured-folder imports read existing `.md` files in place. `material-files.ts` rejects traversal/symlinks and checks file hashes. `material-routes.ts` rechecks preview bytes, marks removed sources inactive, and exposes journal recovery. `POST /imports/root-sync` (called by the client whenever a library opens) previews and commits the folder in one step, skips the commit when every active local file hash is unchanged, accepts warnings, and turns unmatched identities into new questions; structural errors leave the library unchanged and come back as issues. Local source editing is a human route, never an AI tool. Filesystem writes and SQLite commits cannot share one atomic transaction; the durable journal handles that gap. External processes can still race the final rename.

AI notes are distinct records with persistent origin labels and revisions. Original material is not rewritten by AI. Backups capture the imported bytes and database records, not unimported external-file edits or credentials.

## AI boundary

The adapter reads existing Codex ChatGPT credentials and its account model catalog without copying or refreshing either. The exact requested models are `gpt-6.1-sol` and `gpt-6-luna`. No API-key or model fallback is installed. Codex is the single refresh owner. Account errors disable AI but leave practice usable.

The practice page and the Ask AI page render the same conversation block (`tutorConversation` in `main.tsx`); under a question it loads that question's saved chat and sends with the active set's ID, which `visibleChat` uses to filter hint-mode messages. The runtime offers every non-hidden model in Codex's account catalog (enabled when the pinned adapter supports it); the chosen model is `library.settings.model` (default `gpt-6.1-sol`), and the client sends it with each message. Set filters accept `sources: string[]` for the Practice source toggles. The client polls `GET /runs/:id` while a reply streams; there is no server-sent-events route. Durable chat runs retain partial text, terminal status, model, source handles and tool summaries. Restart marks unfinished runs interrupted. The hint tool surface omits keys/solutions, previous solved chats and overall responses. Full tutoring can use library-scoped retrieval and bounded calculator calls. AI writes require separate explicit user actions. Source handles resolve retained revisions; their existence does not prove that a model's claim is correct.

The calculator has one active disposable worker, startup/execution timeouts and bounded output. It is not an OS sandbox and has no proven hard process-memory bound. Do not describe the relaxed local design as equivalent to network-isolated containers.

## Validation evidence

`docker build --target test -t question-bank-prep-test . && docker run --rm question-bank-prep-test` runs `npm run typecheck`, `npm test`, `npm run build` and `npm run test:e2e` on Node 24. `tests/question-format.test.ts` parses every file in `examples/`, so the format guide fails tests when it drifts from the parser. Browser tests run Chromium against isolated local services. The test provider is injected only by tests; normal UI does not fabricate AI responses. Native install/build logs are in ignored `logs/`.

`tsx scripts/benchmark.ts` imports 10,000 synthetic questions in 100 files and measures indexed search. On this Mac the initial measured import was 7.5 seconds, search p95 was 3.5 ms, peak resident memory about 409 MiB. These are synthetic results, not guarantees for other banks or hardware.

## Open issues and verification limits

Last checked: 2026-10-16, Docker Node 24 (Debian bookworm); earlier native macOS/Node 26.

- Original design document and a real question bank were not present. Parser compatibility is established with synthetic fixtures only. Import a representative real chapter before migrating the full library.
- The complete proposed release matrix is not certified: Firefox/WebKit, physical devices, HTTPS deployment, 100,000-section/chat loads, retrieval grounding quality and provider refresh/revocation scenarios need separate checks. AI inside the Docker image (Codex login mount) is untested.
- Local-file save recovery has API routes but no Settings screen yet (see ops/RECOVERY.md).
- Changing choice labels does not reparse files whose bytes are unchanged; re-import after editing them.
- Route bodies are still checked by hand plus a global field-type hook, not per-route Fastify schemas.
- Search indexes whole question/note records rather than heading-based bounded chunks. Large notes and unsegmented Chinese need measured retrieval evaluation before claiming complete search coverage.
- State uses JSON records instead of the plan's normalized schema. Large-library overview/set serialization and chat-history scans may need pagination and more relational indexes at larger loads.
- Subscription reuse uses the adapter's legacy Codex transport, not the newer application-specific token-sharing registration. A minimal live response and a tool round trip succeeded; upstream changes may require an adapter update. Expired credentials require refresh through Codex.
- The local calculator isolation is deliberately relaxed. Timeout and cleanup tests do not establish hard host memory/network isolation.

Keep this section current: distinguish completed local functionality from unverified release targets. Do not mark the full original acceptance matrix complete based only on the happy-path browser test.

- GitHub Actions is supplied as `ops/github-actions-check.yml`, not an active workflow. The initial push was rejected because the existing OAuth login lacks `workflow` scope. All checks ran locally; enabling hosted CI requires a separately authorized credential with workflow permission.
