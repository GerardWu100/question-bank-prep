import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { stream as codexStream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { normalizeContext, type Context, type Tool, type Message } from '@earendil-works/pi-ai';

const MAX_PROMPT_LENGTH = 80_000;
const MAX_REPLY_LENGTH = 100_000;
/** Output-token budget per request; reasoning tokens count against it, so keep it roomy. */
const MAX_OUTPUT_TOKENS = 32_000;
/** Thinking levels the pinned adapter accepts, lowest to highest. */
export const THINKING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];
type CatalogEntry = { slug: string; display_name?: string; visibility?: string; default_reasoning_level?: string; supported_reasoning_levels?: { effort: string }[] };
const REQUEST_TIMEOUT_MS = 120_000;
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export type AIEvent = { type: 'text'; text: string } | { type: 'done'; model: string; provider: string } | { type: 'error'; code: string; message: string };
export interface ModelStatus { id: string; name: string; enabled: boolean; reason?: string; efforts: ThinkingEffort[]; defaultEffort?: ThinkingEffort }
export interface AccountStatus { available: boolean; provider: string; route: string; reason?: string; models: ModelStatus[] }
export interface AIRequest { model: string; effort?: string; prompt: string; systemPrompt?: string; signal?: AbortSignal; history?: { role: 'user' | 'assistant'; content: string }[]; tools?: Tool[]; executeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown> }
export interface StudyProvider { status(): Promise<AccountStatus>; models(): Promise<ModelStatus[]>; stream(request: AIRequest): AsyncGenerator<AIEvent> }

/** Read existing subscription credentials without copying or refreshing Codex's rotating session. */
export class SubscriptionProvider implements StudyProvider {
  private readonly codexDirectory: string;
  constructor(codexDirectory = process.env.CODEX_HOME || join(homedir(), '.codex')) { this.codexDirectory = codexDirectory; }

  private async credentials(): Promise<{ access: string; catalog: CatalogEntry[] }> {
    let auth;
    let catalog;
    try {
      auth = JSON.parse(await readFile(join(this.codexDirectory, 'auth.json'), 'utf8'));
      catalog = JSON.parse(await readFile(join(this.codexDirectory, 'models_cache.json'), 'utf8'));
    } catch { throw new Error('Codex subscription credentials or account model catalog are unavailable. Sign in with ChatGPT in Codex and refresh its model list.'); }
    if (auth.auth_mode !== 'chatgpt' || typeof auth.tokens?.access_token !== 'string') throw new Error('A ChatGPT subscription login is required. API keys are never used.');
    let claims;
    try { claims = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString()); }
    catch { throw new Error('Codex subscription token format is unsupported.'); }
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now() + 60_000) throw new Error('Codex subscription token expired. Refresh your sign-in in Codex; this app does not rotate its credentials.');
    if (!Array.isArray(catalog.models) || !Number.isFinite(Date.parse(catalog.fetched_at)) || Date.now() - Date.parse(catalog.fetched_at) > CATALOG_MAX_AGE_MS) throw new Error('Codex account model catalog is missing or stale. Open Codex to refresh it.');
    return { access: auth.tokens.access_token, catalog: catalog.models };
  }

  async status(): Promise<AccountStatus> {
    let reason: string | undefined;
    let catalog: CatalogEntry[] = [];
    try { catalog = (await this.credentials()).catalog; } catch (error) { reason = (error as Error).message; }
    // Every model Codex lists for this account (hidden internal ones skipped), in Codex's
    // order; usable only when the pinned adapter can call it.
    const supported = new Set(openaiCodexProvider().getModels().map(model => model.id));
    const models = catalog
      .filter(entry => entry.visibility !== 'hide')
      .map(entry => {
        // Thinking levels: what Codex lists for the model, limited to what the adapter can send.
        const efforts = THINKING_EFFORTS.filter(effort => (entry.supported_reasoning_levels ?? []).some(level => level.effort === effort));
        const defaultEffort = efforts.find(effort => effort === entry.default_reasoning_level);
        return { id: entry.slug, name: entry.display_name || entry.slug, enabled: !reason && supported.has(entry.slug), reason: supported.has(entry.slug) ? undefined : 'Not supported by the pinned subscription adapter.', efforts, defaultEffort };
      });
    return { available: models.some(model => model.enabled), provider: 'openai-codex', route: 'ChatGPT subscription · read-only Codex login', reason, models };
  }

  async models(): Promise<ModelStatus[]> { return (await this.status()).models; }

  /** Stream through the subscription transport. Only a terminal success completes a reply. */
  async *stream(request: AIRequest): AsyncGenerator<AIEvent> {
    if (typeof request.prompt !== 'string' || request.prompt.length > MAX_PROMPT_LENGTH) { yield { type: 'error', code: 'invalid_prompt', message: 'Prompt exceeds the supported size.' }; return; }
    const account = await this.status();
    if (!account.models.some(model => model.id === request.model && model.enabled)) { yield { type: 'error', code: 'setup_required', message: account.reason ?? 'Selected model is unavailable. No model was substituted.' }; return; }
    const model = openaiCodexProvider().getModels().find(model => model.id === request.model)!;
    // Without an explicit level the adapter switches reasoning off, so always send one:
    // the requested level when the model supports it, else the model's catalog default.
    const status = account.models.find(entry => entry.id === request.model)!;
    const effort = status.efforts.find(level => level === request.effort) ?? status.defaultEffort;
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) controller.abort();
    const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
    try {
      const { access } = await this.credentials();
      const history = (request.history ?? []).map(message => ({ role: 'user' as const, content: `Prior ${message.role} message (conversation data):\n${message.content}`, timestamp: Date.now() }));
      const context: Context = { systemPrompt: request.systemPrompt, messages: [...history, { role: 'user', content: request.prompt, timestamp: Date.now() }], tools: request.tools };
      let length = 0;
      for (let step = 0; step < 6; step++) {
      let terminal = false;
      let continueTools = false;
      // Direct API adapter bypasses pi-ai credential/environment resolution and token refresh.
      for await (const event of codexStream(model, normalizeContext(context), { apiKey: access, signal: controller.signal, transport: 'sse', maxTokens: MAX_OUTPUT_TOKENS, ...(effort ? { reasoningEffort: effort } : {}) })) {
        if (event.type === 'text_delta') {
          length += event.delta.length;
          if (length > MAX_REPLY_LENGTH) { controller.abort(); yield { type: 'error', code: 'output_limit', message: 'Reply exceeded the output limit.' }; return; }
          yield { type: 'text', text: event.delta };
        } else if (event.type === 'error') {
          yield { type: 'error', code: controller.signal.aborted ? 'cancelled' : 'provider_error', message: controller.signal.aborted ? 'Generation stopped.' : 'Subscription request failed. Check Codex sign-in and account availability.' };
          return;
        } else if (event.type === 'done') {
          terminal = true;
          if (event.reason === 'toolUse' && request.executeTool) {
            context.messages.push(event.message);
            for (const call of event.message.content.filter(block => block.type === 'toolCall').slice(0, 8)) {
              let result: unknown; let isError = false;
              try { result = await request.executeTool(call.name, call.arguments); } catch { result = { error: 'Tool request denied or failed.' }; isError = true; }
              context.messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: JSON.stringify(result).slice(0, 24_000) }], isError, timestamp: Date.now() });
            }
            continueTools = true;
          } else if (event.reason !== 'stop') { yield { type: 'error', code: 'incomplete', message: 'Provider did not finish a complete reply.' }; return; }
          else {
          yield { type: 'done', model: model.id, provider: model.provider };
          return;
          }
        }
      }
      if (!terminal) { yield { type: 'error', code: 'interrupted', message: 'Provider stream ended before completion.' }; return; }
      if (!continueTools) return;
      }
      yield { type: 'error', code: 'tool_limit', message: 'Tutor reached the bounded tool-step limit.' };
    } catch { yield { type: 'error', code: controller.signal.aborted ? 'cancelled' : 'provider_error', message: 'Subscription request could not complete. No API-key fallback was attempted.' }; }
    finally { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); }
  }
}
