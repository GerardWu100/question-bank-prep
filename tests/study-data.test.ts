import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../apps/server/src/app.js";
import { AISettingsFile, ConfigurableProvider } from "../apps/ai-runtime/api-key.js";
import { SubscriptionProvider } from "../apps/ai-runtime/index.js";

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

  it("accepts the progress CSV and reports questions it cannot find", async () => {
    const target = await studyApp();
    const csv = 'topic,source,chapter,question,stem,result,your_answer,answer_key,confidence,flagged\n"quant","drills","Chapter 1","Q-1","What is ""2 + 2""?","correct","B","B","sure","yes"\n"quant","drills","Chapter 1","Q-9","Gone","wrong","A","B","sure",""\n';
    const response = await target.app.inject({ method: "POST", url: `/api/libraries/${target.libraryId}/import/study-data`, payload: { operationId: "c1", content: csv } });
    expect(response.json()).toMatchObject({ answers: 1, annotations: 1, unmatched: ["quant/drills Q-9"] });
    expect(target.byTitle("Q-1").state.selection).toBe("B");
    const bad = await target.app.inject({ method: "POST", url: `/api/libraries/${target.libraryId}/import/study-data`, payload: { operationId: "c2", content: "{}" } });
    expect(bad.statusCode).toBe(400);
    await target.app.close();
  });
});

describe("AI provider settings", () => {
  it("saves the API key owner-only and never sends it back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "study-ai-settings-"));
    try {
      const settingsPath = join(directory, "ai-settings.json");
      const provider = new ConfigurableProvider(new AISettingsFile(settingsPath), new SubscriptionProvider(directory));
      const { app } = await buildApp({ provider });
      expect((await app.inject({ url: "/api/ai-settings" })).json()).toMatchObject({ route: "codex", apiKeySaved: false });
      const saved = await app.inject({ method: "PUT", url: "/api/ai-settings", payload: { route: "api-key", baseUrl: "https://openrouter.ai/api/v1/", apiKey: "sk-test-value-1234", models: ["openrouter/free", "openrouter/free", "a/b:free"] } });
      expect(saved.body).not.toContain("sk-test");
      expect(saved.json()).toMatchObject({ route: "api-key", baseUrl: "https://openrouter.ai/api/v1", models: ["openrouter/free", "a/b:free"], apiKeySaved: true, apiKeyEnding: "1234" });
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(settingsPath, "utf8")).apiKey).toBe("sk-test-value-1234");
      // The model menu now lists the API models, and a blank key field keeps the saved key.
      expect((await app.inject({ url: "/api/models" })).json()).toMatchObject({ available: true, provider: "api-key", models: [{ id: "openrouter/free", enabled: true }, { id: "a/b:free" }] });
      await app.inject({ method: "PUT", url: "/api/ai-settings", payload: { models: ["openrouter/free"] } });
      expect(JSON.parse(readFileSync(settingsPath, "utf8")).apiKey).toBe("sk-test-value-1234");
      expect((await app.inject({ method: "PUT", url: "/api/ai-settings", payload: { baseUrl: "ftp://example.com" } })).statusCode).toBe(400);
      await app.close();
    } finally { rmSync(directory, { recursive: true }); }
  });
});
