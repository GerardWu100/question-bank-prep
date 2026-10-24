import { homedir } from 'node:os';
import { join } from 'node:path';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { stream as codexStream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { createModels, getSupportedThinkingLevels, normalizeContext, type AssistantMessageEvent, type Context, type Model, type Tool } from '@earendil-works/pi-ai';
import { CODEX_PROVIDER_ID, CodexAuthFileStore } from './codex_auth_file_store.mjs';
import type { ModelUsageLimit } from './usage-limit.js';

export const MAX_PROMPT_LENGTH = 80_000;
const MAX_REPLY_LENGTH = 100_000;
/** Model calls one reply may make: the first answer plus up to five tool rounds. */
const MAX_MODEL_STEPS = 6;
const MAX_TOOL_CALLS_PER_STEP = 8;
/** Result sent for each tool call past MAX_TOOL_CALLS_PER_STEP, which is answered but not run. */
const SKIPPED_TOOL_CALL_RESULT = { error: 'Tool call limit reached; this call was not run.' };
const TOOL_RESULT_CHARACTERS = 24_000;
/** Thinking levels pi-ai can send, lowest to highest ("off" is never offered). */
export const THINKING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];
export const REQUEST_TIMEOUT_MS = 120_000;
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
            // Every call in the assistant message gets a result, or providers that pair calls
            // with results reject the next request; calls past the cap are answered, not run.
            for (const [index, toolCall] of event.message.content.filter(block => block.type === 'toolCall').entries()) {
              let result: unknown; let isError = false;
              if (index >= MAX_TOOL_CALLS_PER_STEP) { result = SKIPPED_TOOL_CALL_RESULT; isError = true; }
              else try { result = await request.executeTool(toolCall.name, toolCall.arguments); } catch { result = { error: 'Tool request denied or failed.' }; isError = true; }
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

/**
 * Where the ChatGPT sign-in file is: CODEX_AUTH_FILE, else $CODEX_HOME/auth.json, else
 * ~/.codex/auth.json. A file made by codex-auth-maker is app-owned and refreshed here; a
 * Codex CLI file is only read (see codex_auth_file_store.mjs).
 */
export function defaultCodexAuthFile(): string {
  return process.env.CODEX_AUTH_FILE || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
}

/** Codex models offered when the connection lists none, in menu order. */
export const DEFAULT_CODEX_MODELS = ['gpt-6.1-sol', 'gpt-6-luna'];
/** Effort sent when the request names none the model supports. */
const PREFERRED_DEFAULT_EFFORT: ThinkingEffort = 'medium';
/** A borrowed (Codex CLI) token closer than this to expiry counts as expired: this app cannot refresh it. */
const BORROWED_MIN_VALIDITY_MS = 60_000;

/** Thinking levels pi-ai can send for a model, in THINKING_EFFORTS order, without "off". */
export function modelEfforts(model: Model<any>): ThinkingEffort[] {
  const supported = new Set<string>(getSupportedThinkingLevels(model));
  return THINKING_EFFORTS.filter(effort => supported.has(effort));
}

/** The level to send: the requested one when supported, else "medium" when supported, else the lightest. */
export function defaultEffort(efforts: ThinkingEffort[]): ThinkingEffort | undefined {
  return efforts.includes(PREFERRED_DEFAULT_EFFORT) ? PREFERRED_DEFAULT_EFFORT : efforts[0];
}

/**
 * Tutor replies on a ChatGPT subscription through pi-ai's Codex transport.
 *
 * The sign-in is a Codex-format auth.json. Its `refresh_owner` marker decides who
 * refreshes it: app-owned files (codex-auth-maker) are refreshed here under the shared
 * lock; Codex CLI files are read only, so an expired one fails and the next connection
 * answers. The offered models are `modelIds` limited to the pinned pi-ai Codex catalog.
 */
export class SubscriptionProvider implements StudyProvider {
  constructor(
    private readonly authFile = defaultCodexAuthFile(),
    private readonly usageLimit?: ModelUsageLimit,
    private readonly modelIds: () => string[] = () => DEFAULT_CODEX_MODELS,
  ) {}

  /** Why the sign-in cannot be used now, without any network call; undefined when usable. */
  private async signInProblem(store: CodexAuthFileStore): Promise<string | undefined> {
    const credential = await store.read(CODEX_PROVIDER_ID).catch(() => undefined);
    if (!credential) return 'No ChatGPT sign-in found. Make one with codex-auth-maker (or `codex login`), or add an API key.';
    if (await store.isBorrowed() && credential.expires < Date.now() + BORROWED_MIN_VALIDITY_MS) return 'The Codex CLI sign-in expired. Open Codex to refresh it; this app never refreshes a Codex CLI login.';
    return undefined;
  }

  /** The access token, refreshed first when the sign-in is app-owned and due. Throws a safe message. */
  private async accessToken(): Promise<string> {
    const store = new CodexAuthFileStore(this.authFile);
    const problem = await this.signInProblem(store);
    if (problem) throw new Error(problem);
    const models = createModels({ credentials: store });
    models.setProvider(openaiCodexProvider());
    let resolved;
    try { resolved = await models.getAuth(CODEX_PROVIDER_ID); } catch { resolved = undefined; }
    if (!resolved?.auth.apiKey) throw new Error(store.borrowedRefreshAttempted ? 'The Codex CLI sign-in expired. Open Codex to refresh it.' : 'The ChatGPT sign-in could not be refreshed. Make a new one with codex-auth-maker.');
    return resolved.auth.apiKey;
  }

  async status(): Promise<AccountStatus> {
    const reason = await this.signInProblem(new CodexAuthFileStore(this.authFile));
    const catalog = new Map(openaiCodexProvider().getModels().map(model => [model.id, model]));
    const models = this.modelIds().map(id => {
      const model = catalog.get(id);
      const efforts = model ? modelEfforts(model) : [];
      return { id, name: model?.name ?? id, enabled: !reason && Boolean(model), reason: model ? undefined : 'Not in the pinned pi-ai Codex catalog.', efforts, defaultEffort: defaultEffort(efforts) };
    });
    return { available: models.some(model => model.enabled), provider: CODEX_PROVIDER_ID, route: 'ChatGPT subscription', reason, models };
  }

  async models(): Promise<ModelStatus[]> { return (await this.status()).models; }

  /** Stream through the subscription transport. Only a terminal success completes a reply. */
  async *stream(request: AIRequest): AsyncGenerator<AIEvent> {
    if (typeof request.prompt !== 'string' || request.prompt.length > MAX_PROMPT_LENGTH) { yield { type: 'error', code: 'invalid_prompt', message: 'Prompt exceeds the supported size.' }; return; }
    const account = await this.status();
    const status = account.models.find(model => model.id === request.model && model.enabled);
    if (!status) { yield { type: 'error', code: 'setup_required', message: account.reason ?? `Model ${request.model} is not offered on the ChatGPT subscription.` }; return; }
    const model = openaiCodexProvider().getModels().find(model => model.id === request.model)!;
    // Always send a level: without one pi-ai's Codex transport switches reasoning off. A
    // summary is requested ('auto') so the UI can show the reasoning; short reasoning may return none.
    const effort = status.efforts.find(level => level === request.effort) ?? status.defaultEffort;
    let access: string;
    try { access = await this.accessToken(); } catch (error) { yield { type: 'error', code: 'setup_required', message: (error as Error).message }; return; }
    const call: ModelCall = (context, signal) => codexStream(model, context, { apiKey: access, signal, transport: 'sse', ...(effort ? { reasoningEffort: effort, reasoningSummary: 'auto' as const } : {}) });
    yield* streamWithTools(request, call, { model: model.id, provider: model.provider }, this.usageLimit, () => 'Subscription request failed. Check the ChatGPT sign-in and account availability.');
  }
}
