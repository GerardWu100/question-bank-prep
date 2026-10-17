# Subscription adapter

The server uses pinned `@earendil-works/pi-ai` 1.2.0 through its legacy `openai-codex-responses` transport. It reads the existing Codex ChatGPT access token and recent Codex account model cache on each request. It neither copies credentials nor refreshes them; Codex remains the only refresh owner. Missing, expired, unsupported or API-key credentials disable generation. Every request sends a reasoning level (the library's choice when the model supports it, else the model's catalog default): without one the adapter turns reasoning off. The output budget is 32,000 tokens because reasoning tokens count against it. Every model in the Codex account catalog that is not marked hidden is offered; a model is usable only when the pinned adapter also supports it. No environment API key is read and no model fallback is performed.

The model catalog is Codex's account cache, with a 24-hour freshness bound, rather than a fresh entitlement guarantee. A provider rejection still fails the run. Open Codex to refresh an expired session or stale catalog. Operating-system-only credential storage is not supported by this adapter. Tokens are never returned to the browser, saved to the database or included in error messages.

The newer pi-ai OpenAI subscription OAuth flow has a separate issued client identifier and direct-token scope. This app does not silently initiate that flow or move the user's session into a second refresh owner.

Replies finish only on the transport's terminal `done` event with a stop reason. Partial text remains marked failed, interrupted or cancelled otherwise. Library tools are server-scoped and bounded to six tool rounds. Hint mode excludes keys, solutions, notes and solved prior conversations from retrieval. The model can independently solve a visible question; this filtering is not a guarantee about model behavior.

Sources checked during implementation:

- [pi-ai provider and credential documentation](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)
- [Official Codex authentication documentation](https://developers.openai.com/codex/auth)
- Installed package source: `dist/providers/openai-codex.js`, `dist/api/openai-codex-responses.js`, and `dist/auth/oauth/openai-chatgpt.js`.

Live validation completed with the existing subscription: GPT-6 Luna and GPT-6.1 Sol each streamed a response to completion; Luna also performed a tool round trip. Revoked-session and refresh behavior are covered by fail-closed handling, but no real session was revoked or rotated for a test.
