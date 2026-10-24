import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AISettingsFile, ApiKeyProvider, ConfigurableProvider, endpointFetch, isLinkLocalHost } from "../apps/ai-runtime/api-key.js";
import { streamWithTools, type AIEvent, type ModelCall } from "../apps/ai-runtime/index.js";

/** Tool calls one model step may run (MAX_TOOL_CALLS_PER_STEP in index.ts). */
const TOOL_CALL_CAP = 8;
/** A model the pinned pi-ai Anthropic catalog knows, so it has thinking levels there and none elsewhere. */
const CATALOG_MODEL = "claude-sonnet-5-5";

/** A local OpenAI-compatible server that streams "Hello" as `model` and records each request path. */
async function completionsServer(model: string) {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.end(chunk({ role: "assistant", content: "Hello" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, paths, host: `127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function collect(stream: AsyncIterable<AIEvent>) {
  const events: AIEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("duplicate model IDs across connections", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  /** A ConfigurableProvider over `connections`, with no ChatGPT sign-in. */
  function provider(connections: object[]) {
    const directory = mkdtempSync(join(tmpdir(), "study-ai-owner-"));
    cleanup.push(() => rmSync(directory, { recursive: true }));
    const settings = new AISettingsFile(join(directory, "ai-settings.json"));
    settings.update({ connections });
    return new ConfigurableProvider(settings, join(directory, "missing-auth.json"));
  }

  it("serves and shows a model on the first enabled connection when the first listing is disabled", async () => {
    const local = await completionsServer(CATALOG_MODEL);
    cleanup.push(() => local.server.close());
    const ai = provider([
      { id: "anthropic", kind: "api", baseUrl: "https://api.anthropic.com", models: [CATALOG_MODEL] },
      { id: "local", kind: "api", baseUrl: `http://${local.host}/second`, models: [CATALOG_MODEL] },
    ]);
    const status = await ai.status();
    expect(status.available).toBe(true);
    // One menu entry, attributed to the connection that answers, with its thinking levels (none on Chat Completions).
    expect(status.models).toMatchObject([{ id: CATALOG_MODEL, enabled: true, name: `${CATALOG_MODEL} · ${local.host}`, efforts: [] }]);
    expect(status.models[0].defaultEffort).toBeUndefined();
    const events = await collect(ai.stream({ model: CATALOG_MODEL, prompt: "hi" }));
    expect(events.at(-1)).toEqual({ type: "done", model: CATALOG_MODEL, provider: local.host });
    expect(local.paths).toEqual(["/second/chat/completions"]);
  });

  it("keeps the first connection when both are enabled", async () => {
    const first = await completionsServer("same-model");
    const second = await completionsServer("same-model");
    cleanup.push(() => first.server.close(), () => second.server.close());
    const ai = provider([
      { id: "first", kind: "api", baseUrl: `http://${first.host}/first`, models: ["same-model"] },
      { id: "second", kind: "api", baseUrl: `http://${second.host}/second`, models: ["same-model"] },
    ]);
    expect((await ai.status()).models).toMatchObject([{ id: "same-model", enabled: true, name: `same-model · ${first.host}` }]);
    const events = await collect(ai.stream({ model: "same-model", prompt: "hi" }));
    expect(events.at(-1)).toEqual({ type: "done", model: "same-model", provider: first.host });
    expect(first.paths).toEqual(["/first/chat/completions"]);
    expect(second.paths).toEqual([]);
    // Thinking levels follow the owner too: an enabled Anthropic listing first keeps its levels (status only; no request is sent).
    const anthropicFirst = provider([
      { id: "anthropic", kind: "api", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-synthetic-test", models: [CATALOG_MODEL] },
      { id: "second", kind: "api", baseUrl: `http://${second.host}/second`, models: [CATALOG_MODEL] },
    ]);
    const [entry] = (await anthropicFirst.status()).models;
    expect(entry).toMatchObject({ enabled: true, name: `${CATALOG_MODEL} · api.anthropic.com` });
    expect(entry.efforts).toContain("high");
  });

  it("keeps one disabled entry with its reason when no connection can serve the model", async () => {
    const ai = provider([
      { id: "anthropic", kind: "api", baseUrl: "https://api.anthropic.com", models: [CATALOG_MODEL] },
      { id: "router", kind: "api", baseUrl: "https://router.example/v1", models: [CATALOG_MODEL] },
    ]);
    const status = await ai.status();
    expect(status.available).toBe(false);
    expect(status.models).toHaveLength(1);
    expect(status.models[0]).toMatchObject({ id: CATALOG_MODEL, enabled: false, name: `${CATALOG_MODEL} · api.anthropic.com` });
    expect(status.models[0].reason).toContain("Save an API key for api.anthropic.com");
    expect(status.models[0].efforts).toContain("high");
    // No connection is ready, so nothing is contacted.
    expect(await collect(ai.stream({ model: CATALOG_MODEL, prompt: "hi" }))).toMatchObject([{ type: "error", code: "setup_required" }]);
  });
});

describe("tool-call cap", () => {
  /**
   * A transport whose first answer asks for `count` tool calls (call0, call1, ...) and whose
   * second answer stops; `requests` holds the messages each request carried.
   */
  function toolCallingModel(count: number) {
    const requests: any[][] = [];
    const call: ModelCall = async function* (context) {
      requests.push(structuredClone(context.messages));
      const toolUse = requests.length === 1 && count > 0;
      const content = toolUse ? Array.from({ length: count }, (_, index) => ({ type: "toolCall", id: `call${index}`, name: "lookup", arguments: { index } })) : [{ type: "text", text: "Answer" }];
      if (!toolUse) yield { type: "text_delta", delta: "Answer" } as any;
      yield { type: "done", reason: toolUse ? "toolUse" : "stop", message: { role: "assistant", content, stopReason: toolUse ? "toolUse" : "stop" } } as any;
    };
    return { call, requests };
  }

  it.each([0, 1, TOOL_CALL_CAP, TOOL_CALL_CAP + 1])("answers every one of %i tool calls before the next request", async (count) => {
    const model = toolCallingModel(count);
    const executed: unknown[] = [];
    const events = await collect(streamWithTools(
      { model: "m", prompt: "hi", executeTool: async (_name, args) => { executed.push(args.index); return { ok: args.index }; } },
      model.call, { model: "m", provider: "test" }, undefined, () => "failed",
    ));
    expect(events.at(-1)).toEqual({ type: "done", model: "m", provider: "test" });
    expect(executed).toEqual(Array.from({ length: Math.min(count, TOOL_CALL_CAP) }, (_, index) => index));
    expect(model.requests).toHaveLength(count ? 2 : 1);
    if (!count) return;
    const results = model.requests[1].filter((message) => message.role === "toolResult");
    expect(results.map((result) => result.toolCallId)).toEqual(Array.from({ length: count }, (_, index) => `call${index}`));
    for (const result of results.slice(TOOL_CALL_CAP)) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Tool call limit reached; this call was not run.");
    }
    expect(results.slice(0, TOOL_CALL_CAP).every((result) => !result.isError)).toBe(true);
  });

  it("still stops on cancel and on the usage limit after a capped tool round", async () => {
    const controller = new AbortController();
    const cancelled = toolCallingModel(TOOL_CALL_CAP + 1);
    const cancelCall: ModelCall = async function* (context, signal) {
      if (signal.aborted) { yield { type: "error", error: { errorMessage: "aborted" } } as any; return; }
      yield* cancelled.call(context, signal);
    };
    const stopped = await collect(streamWithTools(
      { model: "m", prompt: "hi", signal: controller.signal, executeTool: async () => { controller.abort(); return {}; } },
      cancelCall, { model: "m", provider: "test" }, undefined, () => "failed",
    ));
    expect(stopped).toEqual([{ type: "error", code: "cancelled", message: "Generation stopped." }]);
    // One model request allowed: the tool round's follow-up request is refused, not sent.
    const limited = toolCallingModel(TOOL_CALL_CAP + 1);
    let slots = 1;
    const usageLimit = { take: () => (slots-- > 0 ? { allowed: true } : { allowed: false, limit: 1, window: "hour", retryAt: new Date(0) }) } as any;
    const events = await collect(streamWithTools({ model: "m", prompt: "hi", executeTool: async () => ({}) }, limited.call, { model: "m", provider: "test" }, usageLimit, () => "failed"));
    expect(events).toMatchObject([{ type: "error", code: "usage_limit" }]);
    expect(limited.requests).toHaveLength(1);
  });
});

describe("API base URL destinations", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); vi.restoreAllMocks(); });
  const settings = () => {
    const directory = mkdtempSync(join(tmpdir(), "study-ai-url-"));
    directories.push(directory);
    return new AISettingsFile(join(directory, "ai-settings.json"));
  };
  const save = (baseUrl: string) => settings().update({ connections: [{ id: "x", kind: "api", baseUrl, apiKey: "", models: ["m"] }] });

  it.each([
    "http://169.254.169.254/latest",
    "http://[::ffff:169.254.169.254]",
    "http://[::ffff:a9fe:a9fe]",
    "http://[::FFFF:A9FE:A9FE]",
    "http://[0:0:0:0:0:ffff:a9fe:a9fe]",
    "http://[fe80::1]",
    "http://[febf::1]:8080",
    "http://metadata.google.internal",
    "http://[fd00:ec2::254]",
  ])("refuses the link-local or metadata address %s", (baseUrl) => {
    expect(() => save(baseUrl)).toThrow("link-local");
  });

  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://[::1]:8080/v1",
    "http://192.168.1.20:11434/v1",
    "http://[::ffff:192.168.1.20]:11434/v1",
    "https://openrouter.ai/api/v1",
  ])("accepts the local, LAN or public address %s", (baseUrl) => {
    expect(save(baseUrl).connections[0].baseUrl).toBe(new URL(baseUrl).toString().replace(/\/+$/, ""));
  });

  it("classifies resolver answers, which come without brackets", () => {
    for (const address of ["169.254.169.254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "fe80::1", "FE80::1"]) expect(isLinkLocalHost(address), address).toBe(true);
    for (const address of ["127.0.0.1", "::1", "10.0.0.5", "192.168.1.20", "fd12::1", "::ffff:7f00:1", "203.0.113.9"]) expect(isLinkLocalHost(address), address).toBe(false);
  });

  it("refuses a host name that resolves to a link-local address before connecting", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const guarded = endpointFetch(async () => ["203.0.113.9", "::ffff:a9fe:a9fe"]);
    await expect(guarded("https://alias.example/v1/models")).rejects.toThrow("link-local");
    expect(network).not.toHaveBeenCalled();
  });

  it("does not follow an endpoint's redirect", async () => {
    const paths: string[] = [];
    const server: Server = createServer((request, response) => {
      paths.push(request.url ?? "");
      if (request.url?.startsWith("/landed")) { response.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"leaked"}]}'); return; }
      response.writeHead(302, { location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/landed` }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const connection = { id: "x", kind: "api" as const, baseUrl, apiKey: "", models: ["m"] };
      await expect(new ApiKeyProvider(connection).remoteModels()).rejects.toThrow();
      const events = await collect(new ApiKeyProvider(connection).stream({ model: "m", prompt: "hi" }));
      expect(events).toMatchObject([{ type: "error", code: "provider_error" }]);
      expect(paths).toEqual(["/v1/models", "/v1/chat/completions"]);
    } finally { server.close(); }
  });
});
