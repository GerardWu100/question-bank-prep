# Trail notes

## Decisions

- 2026-10-31: `cfa-study-app-implementation-plan.md` stays unchanged as the intended product contract. Known deviations are deliberate: state is JSON records per library and kind, not the plan's normalized schema.
- 2026-10-31: The user relaxed strict calculator isolation. The boundary is Node's permission model (the Python AST filter is only a first fence); network and WebAssembly memory stay open on purpose. The permission boundary was checked by hand on Node 22 only; `tests/security.test.ts` covers just the Python filter.
- 2026-10-31: Answer keys are hidden on the server only. Never make practice serialization or hint mode depend on a client-side flag. AI never edits source files or writes without a separate user action.
- 2026-10-31: The set list, source editing and the Focus page were removed from the UI by choice; their server routes remain. Do not delete the routes or bring the UI back unasked.
- 2026-10-31: The accent is a deep, low-saturation slate teal on purpose; keep it low-key. Text colour pairs keep at least 4.5:1 contrast (WCAG AA) in every theme.
- 2026-10-24: AI settings security: a saved key is dropped when its base URL changes, link-local hosts are refused, and redirects are never followed. Keep all three.
- 2026-10-24: Docker binds use `create_host_path: false`. A missing bank folder would otherwise mount empty, and the root sync would read it as "every bank removed".
- 2026-10-18: The desktop app saves and reuses its local port, because browser preferences and Resume live in per-origin `localStorage`.
- 2026-10-31: Browser tests run one spec file per server so test traffic stays under the production limit of 300 requests a minute. Do not raise the production limit to fix test failures.
- 2026-10-31: `apps/ai-runtime/codex_auth_file_store.mjs` is an unchanged copy of the canonical store in `one-offs/codex-auth-maker`. Change it there, then copy.
- 2026-10-30: Default connections are the ChatGPT subscription, then Anthropic, then OpenAI (the user's order). Keyless API connections stay listed and are skipped, so a new install shows where a key goes.
- 2026-10-30: OpenAI keys use the Responses API through pi-ai's catalog, not Chat Completions: Chat Completions sent no reasoning settings, so GPT-6.1 never reasoned.
- 2026-10-30: `gpt-6.1-sol` stays the tutor default (stronger; one user waits per reply). `gpt-6.1-terra` is a copy of pi-ai 1.4.0's Sol entry until pi-ai lists it.
- 2026-10-30: Prompt caching is a per-chat `cacheKey`; on the subscription it decides whether anything is cached. No further token cuts are needed: prompts already carry only the current question or section and capped history.

## Assumptions

- 2026-10-31: The plan's full release matrix is not certified: Firefox/WebKit, phones, HTTPS deployment, very large libraries and AI inside Docker are untested. Do not call it complete from the happy-path browser test.
- 2026-10-18: Desktop installers for macOS and Windows (unsigned, from the release workflow) work on real machines. Only Linux x64 was run; the release job was checked against a fake `gh` only. Check: tag a release and install each.
- 2026-10-24: Desktop server mode and the calculator inside Electron work. Server mode passed a syntax check only. Check: run the packaged app in both modes.
- 2026-10-30: The desktop app's Electron 44.5.1 Node meets pi-ai 1.4.0's `node >= 22.19`. Check: send one tutor message from the packaged app.
- 2026-10-30: An app-owned (codex-auth-maker) ChatGPT login refreshes correctly here; no real refresh has run. The legacy Codex transport may break with upstream changes.
- 2026-10-18: OpenAI-compatible endpoints other than OpenRouter (DeepSeek, Groq, Gemini, Ollama) work; each may need its own compat flags. Check: one reply with a tool round trip each.
- 2026-10-30: Terra answers CFA explanations as well as Sol; only tool round trips were checked. Check: run the same 10 Explain requests on both and compare.

## Gotchas

- 2026-10-31: Fastify `trustProxy` with a hop count (`1`) trusts nothing in this version; it needs the address ranges.
- 2026-10-31: `Referrer-Policy: no-referrer` makes browsers send `Origin: null`, which the origin check refuses. Keep `same-origin`.
- 2026-10-31: KaTeX is pinned to the version rehype-katex uses (0.16.47). A mismatched stylesheet renders subscripts at full size.
- 2026-10-31: `crypto.randomUUID` exists only in secure contexts, so a plain-HTTP server reached by IP breaks it. Use `randomId()`.
- 2026-10-31: Codex runs over SSE, because a session id keeps pi-ai's WebSocket open. Docker mounts the Codex sign-in folder read-write, because a refresh renames a file into place and takes a lock folder beside it.
- 2026-10-30: pi-ai `usage.input` excludes cached tokens; prompt size is `input + cacheRead`. Codex reports reasoning tokens only sometimes.
- 2026-10-31: Changing choice labels does not reparse files whose bytes are unchanged; re-import after editing them.
- 2026-10-17: The partial index `records_question_file` is used only when a query keeps the literal `kind='question'`; a bound `kind=?` parameter silently falls back to a scan.
- 2026-10-24: Route bodies have no per-route Fastify schemas, only hand checks plus a global field-type hook; validate every new route's body by hand.
- 2026-10-24: Redirects are refused for API-key endpoints, so an endpoint that redirects (for example http to https) fails instead of being followed.

## Failed approaches

- 2026-10-17: Deleting FTS entries by an UNINDEXED `id` column scanned the whole index and made imports quadratic. *Disproved*; entries are now keyed by rowid.
- 2026-10-31: Matching only active questions when a removed file returned gave it new, unanswered identities. *Disproved*; reactivation uses the file's last active question IDs.
- 2026-10-24: A second DOMPurify pass over Mermaid SVG (default options) stripped the `<foreignObject>` labels. *Disproved*; Mermaid strict mode plus the CSP is the defence.

## Open blockers

## Untried ideas

- 2026-10-24: Close DNS rebinding on API-key requests with an undici `Agent` whose `connect.lookup` refuses link-local addresses; today the host is checked, then resolved again. Small change, needs a test with a fake resolver.
- 2026-10-24: Upgrade KaTeX to 0.19 to clear GHSA-238p-pmpm-9mq7 (low risk: needs a separate prototype-pollution bug). Moderate cost: rehype-katex, remark-math and the CSS must be rechecked together.
- 2026-10-31: Index search by heading-based chunks instead of whole records, so large notes and unsegmented Chinese retrieve well. Needs a retrieval evaluation first; moderate cost.
