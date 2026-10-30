# AI adapters

`ConfigurableProvider` (`api-key.ts`) is what the server uses. It reads the connection list from `ai-settings.json` in the data folder on every call (Settings → AI provider). Each connection is one of:

- **ChatGPT subscription** — `SubscriptionProvider` (`index.ts`), pinned `@earendil-works/pi-ai` 1.4.0 through its `openai-codex-responses` transport.
- **API key** — `ApiKeyProvider` (`api-key.ts`): Anthropic's Messages API when the base URL is `api.anthropic.com`, OpenAI's Responses API when it is `api.openai.com` (catalog models only; others there use Chat Completions), else OpenAI-compatible Chat Completions against any base URL.

Without a settings file the list is the ChatGPT subscription (`gpt-6.1-sol`, `gpt-6.1-terra`), an Anthropic connection (`claude-sonnet-5-5`, `claude-haiku-5-5`) and an OpenAI connection (`gpt-6.1-sol`, `gpt-6.1-terra`), in that fallback order; the two API connections are skipped until a key is saved.

`EXTRA_MODELS` (`index.ts`) adds models newer than the pinned catalog as copies of a catalog model: `gpt-6.1-terra` is `gpt-6.1-sol` with its id replaced, on both the Codex and OpenAI providers. When pi-ai lists the id itself, its entry wins.

All share `streamWithTools` (tool rounds, size limits, timeout) and the project-wide `ModelUsageLimit`.

## Fallback

The list order is the fallback order. A reply goes to the connection that offers the chosen model; when several list it, the highest one with it enabled serves it, and the model menu shows that connection's name and thinking levels (`modelOwners`). If it fails before any text or reasoning reaches the user (`setup_required`, `provider_error`, `interrupted`, `incomplete`), each other connection with an enabled model answers in turn with its first model. `done` names the model and connection that answered, and the chat saves those. Usage limits, a cancel, the output limit and the tool-step limit are final. When every connection fails, one error lists each connection's reason.

## ChatGPT sign-in

The sign-in is a Codex-format `auth.json`: `CODEX_AUTH_FILE`, else `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. `codex_auth_file_store.mjs` is an unchanged copy of the canonical store in `one-time-projects/codex-auth-maker` (keep them equal; `.d.mts` holds its types):

- A file with `"refresh_owner": "pi-ai"` (made by codex-auth-maker) is app-owned. pi-ai refreshes it through the store under a cross-process lock beside the file, which every app sharing the file uses. This is how a server runs without the Codex CLI.
- A file without the marker belongs to the Codex CLI and is only read. An expired one disables the connection until Codex refreshes it.
- A Codex `apikey` login is never read; add an API-key connection instead.

Offered ChatGPT models are the IDs listed on the connection that the pinned pi-ai Codex catalog (plus `EXTRA_MODELS`) knows (default `gpt-6.1-sol`, `gpt-6.1-terra`). Codex's own `models_cache.json` is not read. Every request sends a thinking level (requested, else `medium`, else the lightest the model supports), because the transport turns reasoning off without one, and asks for a reasoning summary, which streams as `thinking` events.

API-key base URLs may be localhost or a private LAN address (local AI servers), never link-local or a metadata name, also when spelled as IPv4-mapped IPv6. Every API-key request goes through `endpointFetch`, which refuses a host name that resolves to such an address and does not follow redirects. A DNS answer that changes between that check and the transport's own lookup is not caught.

Tokens and keys are never returned to the browser, saved to the database or included in error messages.

## Prompt caching and token counts

Every request carries `cacheKey` (`question-bank-prep:<chat id>`). The Codex and OpenAI Responses transports send it as `prompt_cache_key` (Codex over SSE: with a session id pi-ai's WebSocket transport stays open after the reply); Anthropic caches the prompt start by itself; Chat Completions ignores it. `done` carries `usage` summed over the reply's model calls (`input` excludes cached tokens), and the server saves it on the run. Live check 2026-10-30, two turns with a tool round and a ~1,900-token system prompt: the second turn read 1,920 cached tokens on Codex with the key and 0 without it (two runs); OpenAI and Anthropic read 2,054 and 3,633 either way.

Replies finish only on the transport's terminal `done` event with a stop reason. Partial text remains marked failed, interrupted or cancelled otherwise. Library tools are server-scoped and bounded to six model calls per reply and eight tool runs per call; each call past the eight still gets an error result ("Tool call limit reached"), so the next request pairs every tool call with a result. Hint mode excludes keys, solutions, notes and solved prior conversations from retrieval. The model can independently solve a visible question; this filtering is not a guarantee about model behavior.

Live check 2026-10-18: with an invalid Anthropic key first and the ChatGPT subscription second, the Anthropic request failed and `gpt-6-luna` answered through the fallback. Live check 2026-10-30: every default slot (Codex `gpt-6.1-sol` and `gpt-6.1-terra`, Anthropic `claude-sonnet-5-5` and `claude-haiku-5-5`, OpenAI `gpt-6.1-sol` and `gpt-6.1-terra`) completed a tool round trip at medium thinking; the OpenAI route reported 100–170 reasoning tokens per reply. A real refresh of an app-owned sign-in has not been exercised yet.
