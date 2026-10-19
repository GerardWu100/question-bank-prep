# AI adapters

`ConfigurableProvider` (`api-key.ts`) is what the server uses. It reads the connection list from `ai-settings.json` in the data folder on every call (Settings → AI provider). Each connection is one of:

- **ChatGPT subscription** — `SubscriptionProvider` (`index.ts`), pinned `@earendil-works/pi-ai` 1.3.0 through its `openai-codex-responses` transport.
- **API key** — `ApiKeyProvider` (`api-key.ts`): Anthropic's Messages API when the base URL is `api.anthropic.com`, else OpenAI-compatible Chat Completions against any base URL.

All share `streamWithTools` (tool rounds, size limits, timeout) and the project-wide `ModelUsageLimit`.

## Fallback

The list order is the fallback order. A reply goes to the connection that offers the chosen model. If it fails before any text or reasoning reaches the user (`setup_required`, `provider_error`, `interrupted`, `incomplete`), each other connection with an enabled model answers in turn with its first model. `done` names the model and connection that answered, and the chat saves those. Usage limits, a cancel, the output limit and the tool-step limit are final. When every connection fails, one error lists each connection's reason.

## ChatGPT sign-in

The sign-in is a Codex-format `auth.json`: `CODEX_AUTH_FILE`, else `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. `codex_auth_file_store.mjs` is an unchanged copy of the canonical store in `one-time-projects/codex-auth-maker` (keep them equal; `.d.mts` holds its types):

- A file with `"refresh_owner": "pi-ai"` (made by codex-auth-maker) is app-owned. pi-ai refreshes it through the store under a cross-process lock beside the file, which every app sharing the file uses. This is how a server runs without the Codex CLI.
- A file without the marker belongs to the Codex CLI and is only read. An expired one disables the connection until Codex refreshes it.
- A Codex `apikey` login is never read; add an API-key connection instead.

Offered ChatGPT models are the IDs listed on the connection that the pinned pi-ai Codex catalog knows (default `gpt-6.1-sol`, `gpt-6-luna`). Codex's own `models_cache.json` is not read. Every request sends a thinking level (requested, else `medium`, else the lightest the model supports), because the transport turns reasoning off without one, and asks for a reasoning summary, which streams as `thinking` events.

Tokens and keys are never returned to the browser, saved to the database or included in error messages.

Replies finish only on the transport's terminal `done` event with a stop reason. Partial text remains marked failed, interrupted or cancelled otherwise. Library tools are server-scoped and bounded to six tool rounds. Hint mode excludes keys, solutions, notes and solved prior conversations from retrieval. The model can independently solve a visible question; this filtering is not a guarantee about model behavior.

Live check 2026-10-18: with an invalid Anthropic key first and the ChatGPT subscription second, the Anthropic request failed and `gpt-6-luna` answered through the fallback. A real refresh of an app-owned sign-in has not been exercised yet.
