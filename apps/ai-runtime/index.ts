import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { stream as codexStream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { normalizeContext, type AssistantMessageEvent, type Context, type Tool } from '@earendil-works/pi-ai';
import type { ModelUsageLimit } from './usage-limit.js';

export const MAX_PROMPT_LENGTH = 80_000;
const MAX_REPLY_LENGTH = 100_000;
/** Model calls one reply may make: the first answer plus up to five tool rounds. */
const MAX_MODEL_STEPS = 6;
const MAX_TOOL_CALLS_PER_STEP = 8;
const TOOL_RESULT_CHARACTERS = 24_000;
/** Thinking levels the pinned adapter accepts, lowest to highest. */
export const THINKING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];
type CatalogEntry = { slug: string; display_name?: string; visibility?: string; default_reasoning_level?: string; supported_reasoning_levels?: { effort: string }[] };
export const REQUEST_TIMEOUT_MS = 120_000;
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export type AIEvent = { type: 'text'; text: string } | { type: 'thinking'; text: string } | { type: 'done'; model: string; provider: string } | { type: 'error'; code: string; message: string };
export interface ModelStatus { id: string; name: string; enabled: boolean; reason?: string; efforts: ThinkingEffort[]; defaultEffort?: ThinkingEffort }
export interface AccountStatus { available: boolean; provider: string; route: string; reason?: string; models: ModelStatus[] }
export interface AIRequest { model: string; effort?: string; prompt: string; systemPrompt?: string; signal?: AbortSignal; history?: { role: 'user' | 'assistant'; content: string }[]; tools?: Tool[]; executeTool?: (name: string, args: Record<string, unknown>) => Promise<unknown> }
export interface StudyProvider { status(): Promise<AccountStatus>; models(): Promise<ModelStatus[]>; stream(request: AIRequest): AsyncGenerator<AIEvent> }

/** One model call: the transport's event stream for this (normalized) context. */
export type ModelCall = (context: ReturnType<typeof normalizeContext>, signal: AbortSignal) => AsyncIterable<AssistantMessageEvent>;

/**
 * Run one tutor reply over any pi-ai transport: stream text, run requested tools, and
 * call the model again with their results, at most MAX_MODEL_STEPS times. Every call
 * first takes a slot from the shared usage cap. Only a terminal `stop` completes a reply.
 *
 * `failureMessage` turns a provider error (pi-ai's `errorMessage`, possibly undefined)
 * into the text shown to the user; it must not echo credentials.
 */
export async function* streamWithTools(
  request: AIRequest,
  call: ModelCall,
  done: { model: string; provider: string },
  usageLimit: ModelUsageLimit | undefined,
  failureMessage: (detail: string | undefined) => string,
): AsyncGenerator<AIEvent> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  if (request.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  try {
    // Earlier turns go in as user-role data, so a stored reply can never act as an instruction.
    const history = (request.history ?? []).map(message => ({ role: 'user' as const, content: `Prior ${message.role} message (conversation data):\n${message.content}`, timestamp: Date.now() }));
    const context: Context = { systemPrompt: request.systemPrompt, messages: [...history, { role: 'user', content: request.prompt, timestamp: Date.now() }], tools: request.tools };
    let length = 0;
    for (let step = 0; step < MAX_MODEL_STEPS; step++) {
      let terminal = false;
      let continueTools = false;
      const usage = usageLimit?.take();
      if (usage && !usage.allowed) { yield { type: 'error', code: 'usage_limit', message: `AI usage limit reached: ${usage.limit} model requests per ${usage.window}. Try again after ${usage.retryAt.toLocaleString()}.` }; return; }
      for await (const event of call(normalizeContext(context), controller.signal)) {
        if (event.type === 'text_delta') {
          length += event.delta.length;
          if (length > MAX_REPLY_LENGTH) { controller.abort(); yield { type: 'error', code: 'output_limit', message: 'Reply exceeded the output limit.' }; return; }
          yield { type: 'text', text: event.delta };
        } else if (event.type === 'thinking_delta') {
          // Reasoning summary text (providers expose summaries or reasoning text, never hidden tokens).
          yield { type: 'thinking', text: event.delta };
        } else if (event.type === 'error') {
          yield { type: 'error', code: controller.signal.aborted ? 'cancelled' : 'provider_error', message: controller.signal.aborted ? 'Generation stopped.' : failureMessage(event.error.errorMessage) };
          return;
        } else if (event.type === 'done') {
          terminal = true;
          if (event.reason === 'toolUse' && request.executeTool) {
            context.messages.push(event.message);
            for (const toolCall of event.message.content.filter(block => block.type === 'toolCall').slice(0, MAX_TOOL_CALLS_PER_STEP)) {
              let result: unknown; let isError = false;
              try { result = await request.executeTool(toolCall.name, toolCall.arguments); } catch { result = { error: 'Tool request denied or failed.' }; isError = true; }
              context.messages.push({ role: 'toolResult', toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: 'text', text: JSON.stringify(result).slice(0, TOOL_RESULT_CHARACTERS) }], isError, timestamp: Date.now() });
            }
            continueTools = true;
          } else if (event.reason !== 'stop') { yield { type: 'error', code: 'incomplete', message: 'Provider did not finish a complete reply.' }; return; }
          else { yield { type: 'done', ...done }; return; }
        }
      }
      if (!terminal) { yield { type: 'error', code: 'interrupted', message: 'Provider stream ended before completion.' }; return; }
      if (!continueTools) return;
    }
    yield { type: 'error', code: 'tool_limit', message: 'Tutor reached the bounded tool-step limit.' };
  } catch { yield { type: 'error', code: controller.signal.aborted ? 'cancelled' : 'provider_error', message: failureMessage(undefined) }; }
  finally { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); }
}

/** Read existing subscription credentials without copying or refreshing Codex's rotating session. */
export class SubscriptionProvider implements StudyProvider {
  private readonly codexDirectory: string;
  /** Every model request, tool rounds included, passes this project-wide cap first. */
  private readonly usageLimit?: ModelUsageLimit;
  constructor(codexDirectory = process.env.CODEX_HOME || join(homedir(), '.codex'), usageLimit?: ModelUsageLimit) { this.codexDirectory = codexDirectory; this.usageLimit = usageLimit; }

  private async credentials(): Promise<{ access: string; catalog: CatalogEntry[] }> {
    let auth;
    let catalog;
    try {
      auth = JSON.parse(await readFile(join(this.codexDirectory, 'auth.json'), 'utf8'));
      catalog = JSON.parse(await readFile(join(this.codexDirectory, 'models_cache.json'), 'utf8'));
    } catch { throw new Error('Codex subscription credentials or account model catalog are unavailable. Sign in with ChatGPT in Codex and refresh its model list, or choose an API key in Settings.'); }
    if (auth.auth_mode !== 'chatgpt' || typeof auth.tokens?.access_token !== 'string') throw new Error('Codex is not signed in with ChatGPT. This route never reads a Codex API key; choose an API key in Settings instead.');
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
    // Always send a level so the library's choice applies: the requested level when the
    // model supports it, else the model's catalog default. A summary is requested ('auto')
    // so the UI can show the reasoning; short reasoning may return none.
    const status = account.models.find(entry => entry.id === request.model)!;
    const effort = status.efforts.find(level => level === request.effort) ?? status.defaultEffort;
    let access: string;
    try { ({ access } = await this.credentials()); } catch (error) { yield { type: 'error', code: 'setup_required', message: (error as Error).message }; return; }
    // Direct API adapter bypasses pi-ai credential/environment resolution and token refresh.
    const call: ModelCall = (context, signal) => codexStream(model, context, { apiKey: access, signal, transport: 'sse', ...(effort ? { reasoningEffort: effort, reasoningSummary: 'auto' as const } : {}) });
    yield* streamWithTools(request, call, { model: model.id, provider: model.provider }, this.usageLimit, () => 'Subscription request failed. Check Codex sign-in and account availability.');
  }
}
