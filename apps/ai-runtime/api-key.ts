import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Model } from '@earendil-works/pi-ai';
import { stream as completionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { MAX_PROMPT_LENGTH, streamWithTools, SubscriptionProvider, type AccountStatus, type AIEvent, type AIRequest, type ModelCall, type ModelStatus, type StudyProvider } from './index.js';
import type { ModelUsageLimit } from './usage-limit.js';

/** Where tutor requests go: the read-only Codex ChatGPT login, or an API key for an OpenAI-compatible endpoint. */
export const AI_ROUTES = ['codex', 'api-key'] as const;
export type AIRoute = (typeof AI_ROUTES)[number];
/**
 * Stored AI settings, one JSON file per data folder (mode 0600, never in the database or
 * its backups). `models` are the model IDs offered for the API-key route, in menu order.
 */
export interface AISettings { route: AIRoute; baseUrl: string; apiKey: string; models: string[] }
/** What the browser may see: everything except the key itself. */
export interface PublicAISettings { route: AIRoute; baseUrl: string; models: string[]; apiKeySaved: boolean; apiKeyEnding: string }
/** One model offered by an endpoint's `GET /models`; `free` and `tools` only when the endpoint reports them (OpenRouter does). */
export interface RemoteModel { id: string; name: string; free?: boolean; tools?: boolean }

const DEFAULT_SETTINGS: AISettings = { route: 'codex', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', models: [] };
const MAX_MODELS = 50;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_API_KEY_LENGTH = 500;
const MAX_REMOTE_MODELS = 1000;
/** Characters of a provider error shown to the user. */
const PROVIDER_ERROR_CHARACTERS = 300;
/** Characters of the saved key shown back (its ending) so the user can tell which key is saved. */
const KEY_ENDING_CHARACTERS = 4;
const REMOTE_MODELS_TIMEOUT_MS = 15_000;
/** Context size assumed for API-key models; pi-ai uses it only for bookkeeping, nothing is truncated by it. */
const ASSUMED_CONTEXT_WINDOW = 128_000;
const ASSUMED_MAX_OUTPUT_TOKENS = 16_384;
/** Hosts where a local server (Ollama, LM Studio, llama.cpp) may run without a key. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const isLocalEndpoint = (baseUrl: string) => { try { return LOCAL_HOSTS.includes(new URL(baseUrl).hostname); } catch { return false; } };

/** Read and write the AI settings file. Reads happen per request, so a change applies at once. */
export class AISettingsFile {
  constructor(private readonly path: string) {}

  read(): AISettings {
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8'));
      return {
        route: AI_ROUTES.includes(saved.route) ? saved.route : DEFAULT_SETTINGS.route,
        baseUrl: typeof saved.baseUrl === 'string' && saved.baseUrl ? saved.baseUrl : DEFAULT_SETTINGS.baseUrl,
        apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '',
        models: Array.isArray(saved.models) ? saved.models.filter((model: unknown) => typeof model === 'string') : [],
      };
    } catch { return { ...DEFAULT_SETTINGS }; }
  }

  publicView(settings = this.read()): PublicAISettings {
    return { route: settings.route, baseUrl: settings.baseUrl, models: settings.models, apiKeySaved: Boolean(settings.apiKey), apiKeyEnding: settings.apiKey.slice(-KEY_ENDING_CHARACTERS) };
  }

  /**
   * Validate and save a change. `apiKey` undefined keeps the saved key; an empty string
   * removes it. Throws an Error whose message is safe to show.
   */
  update(change: { route?: unknown; baseUrl?: unknown; apiKey?: unknown; models?: unknown }): PublicAISettings {
    const next = this.read();
    if (change.route !== undefined) {
      if (!AI_ROUTES.includes(change.route as AIRoute)) throw new Error('Route must be codex or api-key.');
      next.route = change.route as AIRoute;
    }
    if (change.baseUrl !== undefined) {
      let url: URL;
      try { url = new URL(String(change.baseUrl).trim()); } catch { throw new Error('Base URL must be a full http(s) address, for example https://openrouter.ai/api/v1.'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL must start with http:// or https://.');
      next.baseUrl = url.toString().replace(/\/+$/, '');
    }
    if (change.apiKey !== undefined) {
      const key = String(change.apiKey).trim();
      if (key.length > MAX_API_KEY_LENGTH || /\s/.test(key)) throw new Error('API key must be one line without spaces.');
      next.apiKey = key;
    }
    if (change.models !== undefined) {
      if (!Array.isArray(change.models)) throw new Error('Models must be a list of model IDs.');
      const models = [...new Set(change.models.map(model => String(model).trim()).filter(Boolean))];
      if (models.length > MAX_MODELS || models.some(model => model.length > MAX_MODEL_ID_LENGTH || /\s/.test(model))) throw new Error(`List at most ${MAX_MODELS} model IDs, one per line, without spaces.`);
      next.models = models;
    }
    // Write a temporary file, then rename, so a crash never leaves half a file; only the owner may read the key.
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
    chmodSync(this.path, 0o600);
    return this.publicView(next);
  }
}

/**
 * Tutor replies through any OpenAI-compatible Chat Completions endpoint (OpenRouter,
 * OpenAI, DeepSeek, Groq, a local Ollama, ...) with the user's own API key.
 *
 * Models are sent without reasoning parameters, so models that do not reason still work;
 * reasoning text an endpoint returns anyway is shown. The system prompt goes as a `system`
 * message, which every compatible server accepts.
 */
export class ApiKeyProvider implements StudyProvider {
  constructor(private readonly settings: () => AISettings, private readonly usageLimit?: ModelUsageLimit) {}

  async status(): Promise<AccountStatus> {
    const { baseUrl, apiKey, models } = this.settings();
    const reason = !apiKey && !isLocalEndpoint(baseUrl) ? 'Save an API key in Settings → AI provider.' : !models.length ? 'Add at least one model ID in Settings → AI provider.' : undefined;
    const statuses: ModelStatus[] = models.map(id => ({ id, name: id, enabled: !reason, efforts: [] }));
    return { available: !reason, provider: 'api-key', route: `API key · ${new URL(baseUrl).host}`, reason, models: statuses };
  }

  async models(): Promise<ModelStatus[]> { return (await this.status()).models; }

  async *stream(request: AIRequest): AsyncGenerator<AIEvent> {
    if (typeof request.prompt !== 'string' || request.prompt.length > MAX_PROMPT_LENGTH) { yield { type: 'error', code: 'invalid_prompt', message: 'Prompt exceeds the supported size.' }; return; }
    const account = await this.status();
    if (!account.models.some(model => model.id === request.model && model.enabled)) { yield { type: 'error', code: 'setup_required', message: account.reason ?? `Model ${request.model} is not in your API model list. Pick one in Settings.` }; return; }
    const { baseUrl, apiKey } = this.settings();
    const model: Model<'openai-completions'> = {
      id: request.model, name: request.model, api: 'openai-completions', provider: 'api-key', baseUrl,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: ASSUMED_CONTEXT_WINDOW, maxTokens: ASSUMED_MAX_OUTPUT_TOKENS,
      compat: { supportsStore: false, supportsDeveloperRole: false },
    };
    // A local server without a key still needs a non-empty bearer value for the OpenAI client.
    const call: ModelCall = (context, signal) => completionsStream(model, context, { apiKey: apiKey || 'local', signal });
    // Provider errors (rate limits, "model does not support tools", ...) are shown, with the key removed.
    const failureMessage = (detail: string | undefined) => detail
      ? `API request failed: ${(apiKey ? detail.replaceAll(apiKey, '[key]') : detail).slice(0, PROVIDER_ERROR_CHARACTERS)}`
      : 'API request could not complete. Check the base URL, key and model ID in Settings.';
    yield* streamWithTools(request, call, { model: request.model, provider: new URL(baseUrl).host }, this.usageLimit, failureMessage);
  }

  /** The endpoint's own model list (`GET <baseUrl>/models`), free models first. */
  async remoteModels(): Promise<RemoteModel[]> {
    const { baseUrl, apiKey } = this.settings();
    const response = await fetch(`${baseUrl}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(REMOTE_MODELS_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`The endpoint answered ${response.status} for its model list.`);
    const body = await response.json() as { data?: any[] };
    // OpenRouter adds `pricing` (USD per token as strings) and `supported_parameters`; plain OpenAI lists only IDs.
    return (Array.isArray(body.data) ? body.data : [])
      .filter(entry => typeof entry?.id === 'string')
      .map(entry => ({
        id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id,
        ...(entry.pricing ? { free: Number(entry.pricing.prompt) === 0 && Number(entry.pricing.completion) === 0 } : {}),
        ...(Array.isArray(entry.supported_parameters) ? { tools: entry.supported_parameters.includes('tools') } : {}),
      }))
      .sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)) || a.id.localeCompare(b.id))
      .slice(0, MAX_REMOTE_MODELS);
  }
}

/** The provider the server uses: reads the settings file on every call and follows its route. */
export class ConfigurableProvider implements StudyProvider {
  readonly apiKey: ApiKeyProvider;
  constructor(readonly settingsFile: AISettingsFile, private readonly codex: SubscriptionProvider, usageLimit?: ModelUsageLimit) {
    this.apiKey = new ApiKeyProvider(() => settingsFile.read(), usageLimit);
  }
  private active(): StudyProvider { return this.settingsFile.read().route === 'api-key' ? this.apiKey : this.codex; }
  status() { return this.active().status(); }
  models() { return this.active().models(); }
  stream(request: AIRequest) { return this.active().stream(request); }
}
