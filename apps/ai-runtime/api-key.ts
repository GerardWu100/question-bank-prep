import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Model } from '@earendil-works/pi-ai';
import { streamSimple as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { stream as completionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { DEFAULT_CODEX_MODELS, defaultCodexAuthFile, defaultEffort, MAX_PROMPT_LENGTH, modelEfforts, streamWithTools, SubscriptionProvider, type AccountStatus, type AIEvent, type AIRequest, type ModelCall, type ModelStatus, type StudyProvider } from './index.js';
import type { ModelUsageLimit } from './usage-limit.js';

/**
 * Kinds of AI connection: the ChatGPT subscription (a Codex-format auth.json), or an API
 * key for an endpoint. An API endpoint on api.anthropic.com uses Anthropic's Messages API;
 * every other endpoint uses OpenAI-compatible Chat Completions.
 */
export const CONNECTION_KINDS = ['codex', 'api'] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];
/**
 * One connection. `models` are the model IDs it offers, in menu order; the first is the
 * model it answers with when it stands in for another connection.
 */
export interface Connection { id: string; kind: ConnectionKind; baseUrl: string; apiKey: string; models: string[] }
/**
 * Stored AI settings, one JSON file per data folder (mode 0600, never in the database or
 * its backups). Connection order is fallback order: a reply goes to the connection that
 * offers the chosen model, and when it fails before any text arrives, to each other
 * connection from the top.
 */
export interface AISettings { connections: Connection[] }
/** What the browser may see of a connection: everything except the key itself. */
export interface PublicConnection { id: string; kind: ConnectionKind; baseUrl: string; models: string[]; apiKeySaved: boolean; apiKeyEnding: string }
export interface PublicAISettings { connections: PublicConnection[] }
/** One model offered by an endpoint's model list; `free` and `tools` only when the endpoint reports them (OpenRouter does). */
export interface RemoteModel { id: string; name: string; free?: boolean; tools?: boolean }

const CODEX_CONNECTION: Connection = { id: 'codex', kind: 'codex', baseUrl: '', apiKey: '', models: DEFAULT_CODEX_MODELS };
const DEFAULT_SETTINGS: AISettings = { connections: [CODEX_CONNECTION] };
const MAX_CONNECTIONS = 8;
const MAX_CONNECTION_ID_LENGTH = 64;
const MAX_MODELS = 50;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_API_KEY_LENGTH = 500;
const MAX_REMOTE_MODELS = 1000;
/** Characters of a provider error shown to the user. */
const PROVIDER_ERROR_CHARACTERS = 300;
/** Characters of the saved key shown back (its ending) so the user can tell which key is saved. */
const KEY_ENDING_CHARACTERS = 4;
const REMOTE_MODELS_TIMEOUT_MS = 15_000;
/** Context size assumed for unknown API models; pi-ai uses it only for bookkeeping, nothing is truncated by it. */
const ASSUMED_CONTEXT_WINDOW = 128_000;
const ASSUMED_MAX_OUTPUT_TOKENS = 16_384;
/** Hosts where a local server (Ollama, LM Studio, llama.cpp) may run without a key. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
/** Hosts served through Anthropic's Messages API instead of Chat Completions. */
const ANTHROPIC_HOSTS = ['api.anthropic.com'];
/** Anthropic API version header for the model list (the Messages transport sets its own). */
const ANTHROPIC_API_VERSION = '2023-06-01';
/**
 * Error codes after which the next connection is tried, provided no text or reasoning has
 * reached the user yet. Limits (usage, output, tool steps), a cancel and an oversized
 * prompt are final: another connection would hit the same wall.
 */
const FALLBACK_CODES = new Set(['setup_required', 'provider_error', 'interrupted', 'incomplete']);

const hostOf = (baseUrl: string) => { try { return new URL(baseUrl).hostname; } catch { return ''; } };
const isLocalEndpoint = (baseUrl: string) => LOCAL_HOSTS.includes(hostOf(baseUrl));
const isAnthropicEndpoint = (baseUrl: string) => ANTHROPIC_HOSTS.includes(hostOf(baseUrl));
/** Name shown for a connection in the model menu and in errors. */
export const connectionLabel = (connection: Connection) => connection.kind === 'codex' ? 'ChatGPT subscription' : (new URL(connection.baseUrl).host);

/** Check and tidy a model-ID list. Throws an Error whose message is safe to show. */
function cleanModels(models: unknown): string[] {
  if (!Array.isArray(models)) throw new Error('Models must be a list of model IDs.');
  const cleaned = [...new Set(models.map(model => String(model).trim()).filter(Boolean))];
  if (cleaned.length > MAX_MODELS || cleaned.some(model => model.length > MAX_MODEL_ID_LENGTH || /\s/.test(model))) throw new Error(`List at most ${MAX_MODELS} model IDs, one per line, without spaces.`);
  return cleaned;
}

/** Read and write the AI settings file. Reads happen per request, so a change applies at once. */
export class AISettingsFile {
  constructor(private readonly path: string) {}

  read(): AISettings {
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!Array.isArray(saved.connections)) return structuredClone(DEFAULT_SETTINGS);
      const connections = saved.connections
        .filter((connection: any) => CONNECTION_KINDS.includes(connection?.kind) && typeof connection.id === 'string')
        .map((connection: any): Connection => ({
          id: connection.id, kind: connection.kind,
          baseUrl: typeof connection.baseUrl === 'string' ? connection.baseUrl : '',
          apiKey: typeof connection.apiKey === 'string' ? connection.apiKey : '',
          models: Array.isArray(connection.models) ? connection.models.filter((model: unknown) => typeof model === 'string') : [],
        }));
      return { connections };
    } catch { return structuredClone(DEFAULT_SETTINGS); }
  }

  publicView(settings = this.read()): PublicAISettings {
    return { connections: settings.connections.map(({ apiKey, ...connection }) => ({ ...connection, apiKeySaved: Boolean(apiKey), apiKeyEnding: apiKey.slice(-KEY_ENDING_CHARACTERS) })) };
  }

  /**
   * Validate and save the whole connection list, in fallback order. A connection's
   * `apiKey` undefined keeps the key saved under the same `id`; an empty string removes
   * it. Throws an Error whose message is safe to show.
   */
  update(change: { connections?: unknown }): PublicAISettings {
    const saved = new Map(this.read().connections.map(connection => [connection.id, connection]));
    if (!Array.isArray(change.connections)) throw new Error('Send the connection list.');
    if (change.connections.length > MAX_CONNECTIONS) throw new Error(`Add at most ${MAX_CONNECTIONS} connections.`);
    const connections = change.connections.map((input: any): Connection => {
      if (!CONNECTION_KINDS.includes(input?.kind)) throw new Error('Connection kind must be codex or api.');
      const id = typeof input.id === 'string' && input.id && input.id.length <= MAX_CONNECTION_ID_LENGTH ? input.id : randomUUID();
      const models = cleanModels(input.models ?? []);
      if (input.kind === 'codex') return { id, kind: 'codex', baseUrl: '', apiKey: '', models: models.length ? models : DEFAULT_CODEX_MODELS };
      let url: URL;
      try { url = new URL(String(input.baseUrl ?? '').trim()); } catch { throw new Error('Base URL must be a full http(s) address, for example https://openrouter.ai/api/v1.'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL must start with http:// or https://.');
      let apiKey = saved.get(id)?.apiKey ?? '';
      if (input.apiKey !== undefined) {
        apiKey = String(input.apiKey).trim();
        if (apiKey.length > MAX_API_KEY_LENGTH || /\s/.test(apiKey)) throw new Error('API key must be one line without spaces.');
      }
      return { id, kind: 'api', baseUrl: url.toString().replace(/\/+$/, ''), apiKey, models };
    });
    if (connections.filter(connection => connection.kind === 'codex').length > 1) throw new Error('Add the ChatGPT subscription once.');
    if (new Set(connections.map(connection => connection.id)).size !== connections.length) throw new Error('Connection IDs must be different.');
    const next: AISettings = { connections };
    // Write a temporary file, then rename, so a crash never leaves half a file; only the owner may read keys.
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
    chmodSync(this.path, 0o600);
    return this.publicView(next);
  }
}

/**
 * Tutor replies through one API-key connection: Anthropic's Messages API on
 * api.anthropic.com, else any OpenAI-compatible Chat Completions endpoint (OpenRouter,
 * OpenAI, DeepSeek, Groq, a local Ollama, ...).
 *
 * Anthropic models pi-ai knows get its catalog entry, so their thinking levels apply.
 * Chat Completions models are sent without reasoning parameters, so models that do not
 * reason still work; the system prompt goes as a `system` message, which every
 * compatible server accepts.
 */
export class ApiKeyProvider implements StudyProvider {
  constructor(private readonly connection: Connection, private readonly usageLimit?: ModelUsageLimit) {}

  /** pi-ai model for an ID on this connection. */
  private model(id: string): Model<'anthropic-messages'> | Model<'openai-completions'> {
    const { baseUrl } = this.connection;
    const common = { id, name: id, baseUrl, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: ASSUMED_CONTEXT_WINDOW, maxTokens: ASSUMED_MAX_OUTPUT_TOKENS };
    if (isAnthropicEndpoint(baseUrl)) {
      const known = anthropicProvider().getModels().find(model => model.id === id) as Model<'anthropic-messages'> | undefined;
      return known ? { ...known, baseUrl } : { ...common, api: 'anthropic-messages', provider: 'anthropic', reasoning: false };
    }
    return { ...common, api: 'openai-completions', provider: 'api-key', reasoning: false, compat: { supportsStore: false, supportsDeveloperRole: false } };
  }

  async status(): Promise<AccountStatus> {
    const { baseUrl, apiKey, models } = this.connection;
    const reason = !apiKey && !isLocalEndpoint(baseUrl) ? `Save an API key for ${connectionLabel(this.connection)} in Settings → AI provider.` : !models.length ? `Add at least one model ID for ${connectionLabel(this.connection)} in Settings → AI provider.` : undefined;
    const statuses: ModelStatus[] = models.map(id => {
      const efforts = this.model(id).reasoning ? modelEfforts(this.model(id)) : [];
      return { id, name: id, enabled: !reason, efforts, defaultEffort: defaultEffort(efforts) };
    });
    return { available: !reason, provider: 'api-key', route: `API key · ${connectionLabel(this.connection)}`, reason, models: statuses };
  }

  async models(): Promise<ModelStatus[]> { return (await this.status()).models; }

  async *stream(request: AIRequest): AsyncGenerator<AIEvent> {
    if (typeof request.prompt !== 'string' || request.prompt.length > MAX_PROMPT_LENGTH) { yield { type: 'error', code: 'invalid_prompt', message: 'Prompt exceeds the supported size.' }; return; }
    const account = await this.status();
    const status = account.models.find(model => model.id === request.model && model.enabled);
    if (!status) { yield { type: 'error', code: 'setup_required', message: account.reason ?? `Model ${request.model} is not in the model list of ${connectionLabel(this.connection)}.` }; return; }
    const { apiKey } = this.connection;
    const model = this.model(request.model);
    const effort = status.efforts.find(level => level === request.effort) ?? status.defaultEffort;
    // A local server without a key still needs a non-empty bearer value for the OpenAI client.
    const call: ModelCall = model.api === 'anthropic-messages'
      ? (context, signal) => anthropicStream(model as Model<'anthropic-messages'>, context, { apiKey, signal, ...(effort ? { reasoning: effort } : {}) })
      : (context, signal) => completionsStream(model as Model<'openai-completions'>, context, { apiKey: apiKey || 'local', signal });
    // Provider errors (rate limits, "model does not support tools", ...) are shown, with the key removed.
    const failureMessage = (detail: string | undefined) => detail
      ? `API request failed: ${(apiKey ? detail.replaceAll(apiKey, '[key]') : detail).slice(0, PROVIDER_ERROR_CHARACTERS)}`
      : 'API request could not complete. Check the base URL, key and model ID in Settings.';
    yield* streamWithTools(request, call, { model: request.model, provider: connectionLabel(this.connection) }, this.usageLimit, failureMessage);
  }

  /** The endpoint's own model list (`GET <baseUrl>/models`, Anthropic: `/v1/models`), free models first. */
  async remoteModels(): Promise<RemoteModel[]> {
    const { baseUrl, apiKey } = this.connection;
    const anthropic = isAnthropicEndpoint(baseUrl);
    const headers: Record<string, string> = anthropic
      ? { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_API_VERSION }
      : apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const response = await fetch(`${baseUrl}${anthropic ? '/v1' : ''}/models`, { headers, signal: AbortSignal.timeout(REMOTE_MODELS_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`The endpoint answered ${response.status} for its model list.`);
    const body = await response.json() as { data?: any[] };
    // OpenRouter adds `pricing` (USD per token as strings) and `supported_parameters`; OpenAI and Anthropic list IDs and names.
    return (Array.isArray(body.data) ? body.data : [])
      .filter(entry => typeof entry?.id === 'string')
      .map(entry => ({
        id: entry.id, name: typeof entry.name === 'string' ? entry.name : typeof entry.display_name === 'string' ? entry.display_name : entry.id,
        ...(entry.pricing ? { free: Number(entry.pricing.prompt) === 0 && Number(entry.pricing.completion) === 0 } : {}),
        ...(Array.isArray(entry.supported_parameters) ? { tools: entry.supported_parameters.includes('tools') } : {}),
      }))
      .sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)) || a.id.localeCompare(b.id))
      .slice(0, MAX_REMOTE_MODELS);
  }
}

/** One configured connection with its provider and current status. */
interface ConnectionState { connection: Connection; label: string; provider: StudyProvider; status: AccountStatus }

/**
 * The provider the server uses: every connection in the settings file at once, in
 * fallback order. Reads the file on every call, so a change applies at once.
 *
 * The model menu lists each connection's models (a model ID listed twice is served by the
 * higher connection). A reply goes first to the connection that offers the chosen model;
 * if that fails before any text or reasoning reaches the user, each other ready connection
 * is tried from the top with its first model. The `done` event names the model and
 * connection that actually answered, and the chat saves those.
 */
export class ConfigurableProvider implements StudyProvider {
  constructor(readonly settingsFile: AISettingsFile, private readonly codexAuthFile = defaultCodexAuthFile(), private readonly usageLimit?: ModelUsageLimit) {}

  private provider(connection: Connection): StudyProvider {
    return connection.kind === 'codex'
      ? new SubscriptionProvider(this.codexAuthFile, this.usageLimit, () => connection.models)
      : new ApiKeyProvider(connection, this.usageLimit);
  }

  private async states(): Promise<ConnectionState[]> {
    return Promise.all(this.settingsFile.read().connections.map(async connection => {
      const provider = this.provider(connection);
      return { connection, label: connectionLabel(connection), provider, status: await provider.status() };
    }));
  }

  /** The API-key provider for one connection, for its endpoint's model list. */
  apiConnection(id: string): ApiKeyProvider | undefined {
    const connection = this.settingsFile.read().connections.find(entry => entry.id === id && entry.kind === 'api');
    return connection && new ApiKeyProvider(connection, this.usageLimit);
  }

  async status(): Promise<AccountStatus> {
    const states = await this.states();
    const seen = new Set<string>();
    const models: ModelStatus[] = [];
    for (const { label, status } of states) for (const model of status.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push({ ...model, name: `${model.name} · ${label}` });
    }
    const ready = states.filter(state => state.status.available);
    const reason = ready.length ? undefined : states.length ? states.map(state => `${state.label}: ${state.status.reason}`).join(' ') : 'Add an AI connection in Settings → AI provider.';
    return { available: ready.length > 0, provider: ready[0]?.status.provider ?? 'none', route: states.map(state => state.label).join(' → '), reason, models };
  }

  async models(): Promise<ModelStatus[]> { return (await this.status()).models; }

  async *stream(request: AIRequest): AsyncGenerator<AIEvent> {
    const states = await this.states();
    const owner = states.find(state => state.status.models.some(model => model.id === request.model && model.enabled));
    // Attempt order: the chosen model on its connection, then every other ready connection from the top with its first model.
    const attempts = [
      ...(owner ? [{ state: owner, model: request.model }] : []),
      ...states.filter(state => state !== owner).flatMap(state => {
        const first = state.status.models.find(model => model.enabled);
        return first ? [{ state, model: first.id }] : [];
      }),
    ];
    const failures: string[] = [];
    for (const { state, model } of attempts) {
      let delivered = false;
      let failure: string | undefined;
      for await (const event of state.provider.stream({ ...request, model })) {
        if (event.type === 'error' && !delivered && FALLBACK_CODES.has(event.code)) { failure = event.message; break; }
        if (event.type === 'text' || event.type === 'thinking') delivered = true;
        yield event;
        if (event.type === 'error' || event.type === 'done') return;
      }
      if (failure === undefined) return;
      failures.push(`${state.label} (${model}): ${failure}`);
      if (request.signal?.aborted) { yield { type: 'error', code: 'cancelled', message: 'Generation stopped.' }; return; }
    }
    yield failures.length
      ? { type: 'error', code: 'provider_error', message: `Every AI connection failed. ${failures.join(' · ')}` }
      : { type: 'error', code: 'setup_required', message: (await this.status()).reason ?? 'No AI connection is ready.' };
  }
}
