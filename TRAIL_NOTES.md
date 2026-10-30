# TRAIL_NOTES

## Decisions

- 2026-10-30 — Default connections are the ChatGPT subscription, then Anthropic, then OpenAI (user's order, same as the other LLM projects). Keyless API connections stay in the list and are skipped, so a new install shows where a key goes; a user can delete them.
- 2026-10-30 — OpenAI keys use OpenAI's Responses API through pi-ai's catalog entry, not plain Chat Completions: Chat Completions here sends no reasoning settings, so GPT-6.1 never reasoned on the key route. Live: 100–170 reasoning tokens per reply at medium after the change.
- 2026-10-30 — `gpt-6.1-terra` is a copy of pi-ai 1.4.0's `gpt-6.1-sol` (`EXTRA_MODELS`), verified live on Codex and OpenAI with a tool round trip. The catalog entry wins once pi-ai lists Terra.
- 2026-10-30 — The tutor keeps `gpt-6.1-sol` as its default model: it is the stronger model, and a reply is one user waiting, not a high-volume batch. Terra is offered beside it.
- 2026-10-30 — Prompt caching is a per-chat `cacheKey`. On the subscription it decides whether anything is cached (second turn: 1,920 cached tokens with the key, 0 without, two runs); OpenAI and Anthropic cached the same prefix without it. No other token cut: the tutor already sends only the current question or section, the last 12 messages cut to 4,000 characters each, and tool results capped at 24,000 characters.

## Assumptions

- 2026-10-30 — Tutor answer quality on Terra matches Sol for CFA explanations. Only tool round trips were checked live, not answer quality. Check: ask the same 10 Explain requests on both and read them side by side.
- 2026-10-30 — The desktop app's bundled Node meets pi-ai 1.4.0's `node >= 22.19` (Electron 44.5.1). Check: run the packaged app and send one tutor message.

## Gotchas

- 2026-10-30 — pi-ai `usage.input` excludes cached tokens; the prompt size is `input + cacheRead`. The Codex route reports reasoning tokens only sometimes (0 on Terra in the live check).
