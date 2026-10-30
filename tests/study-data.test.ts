import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../apps/server/src/app.js";
import { AISettingsFile, ConfigurableProvider } from "../apps/ai-runtime/api-key.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const bank = `# Chapter 1\n### Question Q-1\nWhat is 2 + 2?\n#### Choices\nA. 3\nB. 4\n#### Answer\nB\n#### Solution\nAdd.\n### Question Q-2\nWhat is 3 + 3?\n#### Choices\nA. 6\nB. 7\n#### Answer\nA\n#### Solution\nAdd.\n`;

/** An app with one library holding `bank` at quant/drills.md (topic "quant", source "drills"). */
async function studyApp() {
  const { app, store } = await buildApp();
  const library = store.createLibrary("Study");
  store.commit(library.id, store.preview(library.id, [{ path: "quant/drills.md", content: bank }]).id, true);
  const byTitle = (title: string) => store.list(library.id, "question").find((q) => q.title.endsWith(title));
  return { app, store, libraryId: library.id, byTitle };
}

describe("study data export and import", () => {
  it("moves answers, flags, question notes and notes to another install", async () => {
    const source = await studyApp();
    const q1 = source.byTitle("Q-1");
    const q2 = source.byTitle("Q-2");
    source.store.answer(source.libraryId, q2.id, { operationId: "a1", expectedVersion: 0, selection: "B", confidence: "sure" });
    source.store.answer(source.libraryId, q1.id, { operationId: "a2", expectedVersion: 0, selection: "B", confidence: "unsure" });
    await source.app.inject({ method: "PATCH", url: `/api/libraries/${source.libraryId}/questions/${q2.id}/annotation`, payload: { operationId: "f1", expectedVersion: 0, flagged: true, note: "Watch the sign." } });
    await source.app.inject({ method: "POST", url: `/api/libraries/${source.libraryId}/notes`, payload: { title: "Rules", content: "Always add." } });
    const exported = await source.app.inject({ url: `/api/libraries/${source.libraryId}/export/study-data` });
    expect(exported.headers["content-disposition"]).toContain("study-data.json");

    const target = await studyApp();
    const imported = await target.app.inject({ method: "POST", url: `/api/libraries/${target.libraryId}/import/study-data`, payload: { operationId: "i1", content: exported.body } });
    expect(imported.json()).toMatchObject({ answers: 2, annotations: 1, notes: 1, unmatched: [] });
    const [t1, t2] = [target.byTitle("Q-1"), target.byTitle("Q-2")];
    expect(t1.state).toMatchObject({ selection: "B", confidence: "unsure" });
    expect(t2.state).toMatchObject({ selection: "B", confidence: null });
    expect(t2.annotation).toMatchObject({ flagged: true, note: "Watch the sign." });
    // Original answer order survives: Q-2 was answered first.
    expect(t2.state.answerSequence).toBeLessThan(t1.state.answerSequence);

    // Importing the same file again changes nothing and copies no note twice.
    const again = await target.app.inject({ method: "POST", url: `/api/libraries/${target.libraryId}/import/study-data`, payload: { operationId: "i2", content: exported.body } });
    expect(again.json()).toMatchObject({ answers: 0, annotations: 0, notes: 0, unchanged: 2 });
    await Promise.all([source.app.close(), target.app.close()]);
  });

  it("reports questions the library lacks and refuses files from elsewhere", async () => {
    const target = await studyApp();
    const file = JSON.stringify({ format: "question-bank-prep/study-data", version: 1, notes: [], questions: [
      { topic: "quant", source: "drills", question: "Q-1", selection: "B", confidence: "sure", answerSequence: 1, flagged: true, note: "" },
      { topic: "quant", source: "drills", question: "Q-9", selection: "A", confidence: "sure", answerSequence: 2, flagged: false, note: "" },
    ] });
    const response = await target.app.inject({ method: "POST", url: `/api/libraries/${target.libraryId}/import/study-data`, payload: { operationId: "c1", content: file } });
    expect(response.json()).toMatchObject({ answers: 1, annotations: 1, unmatched: ["quant/drills Q-9"] });
    expect(target.byTitle("Q-1").state.selection).toBe("B");
    for (const content of ["{}", "topic,source\nquant,drills"]) {
      const bad = await target.app.inject({ method: "POST", url: `/api/libraries/${target.libraryId}/import/study-data`, payload: { operationId: `bad-${content.length}`, content } });
      expect(bad.statusCode).toBe(400);
    }
    await target.app.close();
  });
});

describe("AI provider settings", () => {
  it("saves API keys owner-only, never sends them back, and keeps a key when the box is left empty", async () => {
    const directory = mkdtempSync(join(tmpdir(), "study-ai-settings-"));
    try {
      const settingsPath = join(directory, "ai-settings.json");
      const provider = new ConfigurableProvider(new AISettingsFile(settingsPath), join(directory, "auth.json"));
      const { app } = await buildApp({ provider });
      expect((await app.inject({ url: "/api/ai-settings" })).json()).toMatchObject({ connections: [{ id: "codex", kind: "codex", models: ["gpt-6.1-sol", "gpt-6.1-terra"] }, { id: "anthropic", kind: "api", apiKeySaved: false }, { id: "openai", kind: "api", apiKeySaved: false }] });
      const saved = await app.inject({ method: "PUT", url: "/api/ai-settings", payload: { connections: [
        { id: "anthropic", kind: "api", baseUrl: "https://api.anthropic.com/", apiKey: "sk-test-value-1234", models: ["claude-sonnet-5-5", "claude-sonnet-5-5"] },
        { id: "codex", kind: "codex", models: [] },
      ] } });
      expect(saved.body).not.toContain("sk-test");
      expect(saved.json()).toMatchObject({ connections: [
        { id: "anthropic", baseUrl: "https://api.anthropic.com", models: ["claude-sonnet-5-5"], apiKeySaved: true, apiKeyEnding: "1234" },
        { id: "codex", models: ["gpt-6.1-sol", "gpt-6.1-terra"] },
      ] });
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(settingsPath, "utf8")).connections[0].apiKey).toBe("sk-test-value-1234");
      // The model menu lists every connection's models; the Codex ones are off without a sign-in.
      const models = (await app.inject({ url: "/api/models" })).json();
      expect(models).toMatchObject({ available: true, route: "api.anthropic.com → ChatGPT subscription" });
      expect(models.models.map((m: any) => [m.id, m.enabled])).toEqual([["claude-sonnet-5-5", true], ["gpt-6.1-sol", false], ["gpt-6.1-terra", false]]);
      expect(models.models[0].name).toBe("claude-sonnet-5-5 · api.anthropic.com");
      expect(models.models[0].efforts).toContain("high");
      // A blank key keeps the saved key; reordering keeps it too.
      await app.inject({ method: "PUT", url: "/api/ai-settings", payload: { connections: [{ id: "codex", kind: "codex" }, { id: "anthropic", kind: "api", baseUrl: "https://api.anthropic.com", models: ["claude-haiku-5-5"] }] } });
      expect(JSON.parse(readFileSync(settingsPath, "utf8")).connections[1].apiKey).toBe("sk-test-value-1234");
      expect((await app.inject({ method: "PUT", url: "/api/ai-settings", payload: { connections: [{ kind: "api", baseUrl: "ftp://example.com" }] } })).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: "/api/ai-settings", payload: { connections: [{ kind: "codex" }, { kind: "codex" }] } })).statusCode).toBe(400);
      await app.close();
    } finally { rmSync(directory, { recursive: true }); }
  });

  it("falls back down the connection list until one answers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "study-ai-fallback-"));
    // A local OpenAI-compatible server: /broken answers 500, /ok streams "Hello".
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/broken")) { response.writeHead(500, { "content-type": "application/json" }).end('{"error":{"message":"upstream down"}}'); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "local-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.end(chunk({ role: "assistant", content: "Hello" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const settings = new AISettingsFile(join(directory, "ai-settings.json"));
      settings.update({ connections: [
        { id: "codex", kind: "codex" },
        { id: "broken", kind: "api", baseUrl: `${base}/broken`, models: ["broken-model"] },
        { id: "ok", kind: "api", baseUrl: `${base}/ok`, models: ["local-model"] },
      ] });
      const provider = new ConfigurableProvider(settings, join(directory, "missing-auth.json"));
      const events: any[] = [];
      for await (const event of provider.stream({ model: "gpt-6.1-sol", prompt: "hi" })) events.push(event);
      // No ChatGPT sign-in and a failing endpoint: the third connection answers, and `done` names it.
      expect(events).toMatchObject([{ type: "text", text: "Hello" }, { type: "done", model: "local-model", provider: "127.0.0.1:" + base.split(":")[2] }]);
      settings.update({ connections: [{ id: "broken", kind: "api", baseUrl: `${base}/broken`, models: ["broken-model"] }] });
      const failed: any[] = [];
      for await (const event of provider.stream({ model: "broken-model", prompt: "hi" })) failed.push(event);
      expect(failed).toMatchObject([{ type: "error", code: "provider_error" }]);
      expect(failed[0].message).toContain("Every AI connection failed");
    } finally { server.close(); rmSync(directory, { recursive: true }); }
  });
});
