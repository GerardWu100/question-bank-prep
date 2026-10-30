import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { dirname } from 'node:path';
import type { Model } from '@earendil-works/pi-ai';
import { streamSimple as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { stream as completionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as responsesStream } from '@earendil-works/pi-ai/api/openai-responses';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { catalogWithExtras, DEFAULT_CODEX_MODELS, defaultCodexAuthFile, defaultEffort, MAX_PROMPT_LENGTH, modelEfforts, streamWithTools, SubscriptionProvider, type AccountStatus, type AIEvent, type AIRequest, type ModelCall, type ModelStatus, type StudyProvider } from './index.js';
import type { ModelUsageLimit } from './usage-limit.js';

/**
 * Kinds of AI connection: the ChatGPT subscription (a Codex-format auth.json), or an API
 * key for an endpoint. An API endpoint on api.anthropic.com uses Anthropic's Messages API,
 * one on api.openai.com OpenAI's Responses API (both with thinking levels for catalog
 * models); every other endpoint uses OpenAI-compatible Chat Completions.
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

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** Models a new Anthropic or OpenAI connection offers, in menu order (the first is its backup model). */
export const DEFAULT_ANTHROPIC_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];
export const DEFAULT_OPENAI_MODELS = ['gpt-6.1-sol', 'gpt-6.1-terra'];
/**
 * Connections before the user saves any, in fallback order: the ChatGPT subscription (no
 * per-token bill), then an Anthropic key, then an OpenAI key. The two API connections stay
 * unavailable, and are skipped, until a key is saved for them in Settings → AI provider.
 */
const DEFAULT_SETTINGS: AISettings = { connections: [
  { id: 'codex', kind: 'codex', baseUrl: '', apiKey: '', models: DEFAULT_CODEX_MODELS },
  { id: 'anthropic', kind: 'api', baseUrl: ANTHROPIC_BASE_URL, apiKey: '', models: DEFAULT_ANTHROPIC_MODELS },
  { id: 'openai', kind: 'api', baseUrl: OPENAI_BASE_URL, apiKey: '', models: DEFAULT_OPENAI_MODELS },
] };
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
/**
 * Link-local addresses (169.254.0.0/16, fe80::/10) and cloud metadata names (Google's,
 * AWS's IPv6 fd00:ec2::254), without brackets, refused as API destinations.
 */
const LINK_LOCAL_ADDRESS = /^(169\.254\.\d{1,3}\.\d{1,3}|fe[89ab][0-9a-f]:.*|metadata(\.google\.internal)?\.?|fd00:ec2::254)$/i;
/** IPv4-mapped IPv6 (::ffff:a.b.c.d), dotted or as two hex groups, the spelling the URL parser and resolvers give. */
const IPV4_MAPPED_DOTTED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const IPV4_MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
/** Hosts served through Anthropic's Messages API instead of Chat Completions. */
const ANTHROPIC_HOSTS = ['api.anthropic.com'];
/** Hosts served through OpenAI's Responses API, which carries reasoning, instead of Chat Completions. */
const OPENAI_HOSTS = ['api.openai.com'];
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
const isOpenAIEndpoint = (baseUrl: string) => OPENAI_HOSTS.includes(hostOf(baseUrl));

/**
 * Whether a URL host name or resolved address (IPv6 with or without brackets) is link-local
 * or a metadata name. An IPv4-mapped IPv6 address is classified as its IPv4 address, so
 * [::ffff:a9fe:a9fe] counts as 169.254.169.254. Loopback and private LAN addresses are not
 * link-local: local AI servers live there.
 */
export function isLinkLocalHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1');
  // Each hex group of a mapped address holds two IPv4 bytes: 0xa9fe → 169.254.
  const hex = IPV4_MAPPED_HEX.exec(bare)?.slice(1).map(group => parseInt(group, 16));
  const address = hex ? hex.flatMap(group => [group >> 8, group & 0xff]).join('.') : IPV4_MAPPED_DOTTED.exec(bare)?.[1] ?? bare;
  return LINK_LOCAL_ADDRESS.test(address);
}

/** Every address a host name resolves to (an IP literal resolves to itself). */
export type HostLookup = (hostname: string) => Promise<string[]>;
const systemLookup: HostLookup = async hostname => (await lookup(hostname, { all: true })).map(entry => entry.address);

/**
 * fetch for API connections. The saved-URL check sees only the host's spelling, so this also
 * refuses a host name that resolves to a link-local address and refuses redirects (an endpoint
 * could otherwise bounce the request, with its key, to a metadata service). Remaining gap: the
 * transport resolves the name again, so a DNS answer that changes in between (DNS rebinding)
 * is not caught.
 */
export function endpointFetch(lookupHost: HostLookup = systemLookup): typeof fetch {
  return async (input, init) => {
    const { hostname } = new URL(input instanceof Request ? input.url : input);
    const addresses = await lookupHost(hostname.replace(/^\[(.*)\]$/, '$1'));
    if ([hostname, ...addresses].some(isLinkLocalHost)) throw new Error('The API endpoint resolves to a link-local address.');
    return fetch(input, { ...init, redirect: 'error' });
  };
}
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
      // Cloud metadata services live on link-local addresses and hand out machine credentials.
      if (isLinkLocalHost(url.hostname)) throw new Error('Base URL cannot be a link-local address.');
      const baseUrl = url.toString().replace(/\/+$/, '');
      const previous = saved.get(id);
      // A saved key goes only to the address it was saved for; otherwise anyone who can
      // change settings could point the connection at their own server and receive the key.
      if (input.apiKey === undefined && previous?.apiKey && previous.baseUrl !== baseUrl)
        throw new Error('Enter the API key again after changing the base URL.');
      let apiKey = previous?.apiKey ?? '';
      if (input.apiKey !== undefined) {
        apiKey = String(input.apiKey).trim();
        if (apiKey.length > MAX_API_KEY_LENGTH || /\s/.test(apiKey)) throw new Error('API key must be one line without spaces.');
      }
      return { id, kind: 'api', baseUrl, apiKey, models };
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
 * api.anthropic.com, OpenAI's Responses API on api.openai.com, else any OpenAI-compatible
 * Chat Completions endpoint (OpenRouter, DeepSeek, Groq, a local Ollama, ...).
 *
 * Anthropic and OpenAI models pi-ai knows (plus EXTRA_MODELS) get their catalog entry, so
 * their thinking levels apply and a reasoning summary streams. Other models are sent without
 * reasoning parameters, so models that do not reason still work; the system prompt goes as
 * a `system` message, which every compatible server accepts.
 *
 * Prompt caching: Anthropic marks the prompt prefix for caching by itself; the Responses
 * API gets the request's `cacheKey` as `prompt_cache_key`.
 */
export class ApiKeyProvider implements StudyProvider {
  constructor(private readonly connection: Connection, private readonly usageLimit?: ModelUsageLimit) {}

  /** pi-ai model for an ID on this connection. */
  private model(id: string): Model<'anthropic-messages'> | Model<'openai-responses'> | Model<'openai-completions'> {
    const { baseUrl } = this.connection;
    const common = { id, name: id, baseUrl, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: ASSUMED_CONTEXT_WINDOW, maxTokens: ASSUMED_MAX_OUTPUT_TOKENS };
    if (isOpenAIEndpoint(baseUrl)) {
      // An OpenAI model the catalog lacks falls through to plain Chat Completions below.
      const known = catalogWithExtras('openai', openaiProvider().getModels()).get(id) as Model<'openai-responses'> | undefined;
      if (known) return { ...known, baseUrl };
    }
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
    const guardedFetch = endpointFetch();
    // A local server without a key still needs a non-empty bearer value for the OpenAI client.
    const call: ModelCall = model.api === 'anthropic-messages'
      ? (context, signal) => anthropicStream(model as Model<'anthropic-messages'>, context, { apiKey, signal, fetch: guardedFetch, ...(effort ? { reasoning: effort } : {}) })
      : model.api === 'openai-responses'
        ? (context, signal) => responsesStream(model as Model<'openai-responses'>, context, { apiKey, signal, fetch: guardedFetch, ...(request.cacheKey ? { sessionId: request.cacheKey } : {}), ...(effort ? { reasoningEffort: effort, reasoningSummary: 'auto' as const } : {}) })
        : (context, signal) => completionsStream(model as Model<'openai-completions'>, context, { apiKey: apiKey || 'local', signal, fetch: guardedFetch });
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
    const response = await endpointFetch()(`${baseUrl}${anthropic ? '/v1' : ''}/models`, { headers, signal: AbortSignal.timeout(REMOTE_MODELS_TIMEOUT_MS) });
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
/** The connection that serves a model ID, and that connection's status for the model. */
interface ModelOwner { state: ConnectionState; model: ModelStatus }

/**
 * Who serves each model ID, also one listed on several connections: the first connection,
 * in fallback order, that offers it enabled; when none does, the first that lists it, whose
 * entry stays disabled. Keys are in menu order (first listing). The menu and the reply
 * both use this, so the shown availability, connection and thinking levels are the ones
 * a reply gets.
 */
function modelOwners(states: ConnectionState[]): Map<string, ModelOwner> {
  const owners = new Map<string, ModelOwner>();
  for (const state of states) for (const model of state.status.models) {
    const owner = owners.get(model.id);
    // Map.set on an existing key keeps its position, so the menu order does not change.
    if (!owner || (!owner.model.enabled && model.enabled)) owners.set(model.id, { state, model });
  }
  return owners;
}

/**
 * The provider the server uses: every connection in the settings file at once, in
 * fallback order. Reads the file on every call, so a change applies at once.
 *
 * The model menu lists each connection's models (a model ID listed twice is served by the
 * highest connection that has it enabled; see modelOwners). A reply goes first to the
 * connection that serves the chosen model; if that fails before any text or reasoning reaches the user, each other ready connection
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
    // A disabled entry carries its connection's reason when the model itself has none (a missing key, say).
    const models: ModelStatus[] = [...modelOwners(states).values()].map(({ state, model }) => ({
      ...model, name: `${model.name} · ${state.label}`, reason: model.reason ?? (model.enabled ? undefined : state.status.reason),
    }));
    const ready = states.filter(state => state.status.available);
    const reason = ready.length ? undefined : states.length ? states.map(state => `${state.label}: ${state.status.reason}`).join(' ') : 'Add an AI connection in Settings → AI provider.';
    return { available: ready.length > 0, provider: ready[0]?.status.provider ?? 'none', route: states.map(state => state.label).join(' → '), reason, models };
  }

  async models(): Promise<ModelStatus[]> { return (await this.status()).models; }

  async *stream(request: AIRequest): AsyncGenerator<AIEvent> {
    const states = await this.states();
    const chosen = modelOwners(states).get(request.model);
    const owner = chosen?.model.enabled ? chosen.state : undefined;
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
