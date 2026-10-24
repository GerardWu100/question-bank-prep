import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { registerMaterialRoutes } from "../apps/server/src/material-routes.js";

/** A one-chapter bank; `stem` sets the searchable text and the fingerprint. */
const bankOf = (stem: string, solution = "Worked.") =>
  `# Chapter 1\n## Question 1\n${stem}\n### Choices\nA. One\nB. Two\n### Answer\nB\n### Solution\n${solution}\n` +
  `## Question 2\n${stem} again\n### Choices\nA. One\nB. Two\n### Answer\nA\n### Solution\n${solution}\n`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A library synced from a temporary configured folder, through the real routes. */
async function folderLibrary() {
  const root = await mkdtemp(join(tmpdir(), "study-root-sync-"));
  const { app, store } = await buildApp();
  registerMaterialRoutes(app, store, root, join(root, ".data"));
  cleanups.push(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const library = store.createLibrary("Local");
  const base = `/api/libraries/${library.id}`;
  let operations = 0;
  const sync = async () => {
    const response = await app.inject({ method: "POST", url: `${base}/imports/root-sync`, payload: {} });
    return { status: response.statusCode, body: response.json() };
  };
  const generation = () => store.library(library.id).generation;
  const questionsOf = (path: string) => {
    const file = store.list(library.id, "file", ["content"]).find((f) => f.path === path);
    return file ? store.questionsInFile(library.id, file.id) : [];
  };
  const activeQuestions = () => store.list(library.id, "question").filter((q) => q.active);
  const search = async (query: string) =>
    (await app.inject({ url: `${base}/search?q=${encodeURIComponent(query)}` })).json().results;
  const operationId = () => `op-${++operations}`;
  return { app, store, root, libraryId: library.id, base, sync, generation, questionsOf, activeQuestions, search, operationId };
}

describe("root sync of an emptied folder", () => {
  it("deactivates the last local file, once, and keeps old sets readable", async () => {
    const lib = await folderLibrary();
    await writeFile(join(lib.root, "bank.md"), bankOf("Lonely sentinel"));
    expect((await lib.sync()).body.changed).toBe(true);
    const [first] = lib.questionsOf("bank.md");
    const set = (
      await lib.app.inject({ method: "POST", url: `${lib.base}/sets`, payload: { operationId: lib.operationId(), title: "Old" } })
    ).json();
    expect(await lib.search("sentinel")).toHaveLength(2);

    await rm(join(lib.root, "bank.md"));
    const before = lib.generation();
    const emptied = await lib.sync();
    expect(emptied.status, JSON.stringify(emptied.body)).toBe(200);
    expect(emptied.body).toMatchObject({ changed: true, issues: [], questions: 0 });
    expect(lib.generation()).toBe(before + 1);
    expect(lib.activeQuestions()).toHaveLength(0);
    expect(lib.store.list(lib.libraryId, "file").every((f: any) => !f.active)).toBe(true);
    expect(await lib.search("sentinel")).toHaveLength(0);
    // The frozen set still opens, with its removed-source question.
    expect((await lib.app.inject({ url: `${lib.base}/sets/${set.id}` })).statusCode).toBe(200);
    expect((await lib.app.inject({ url: `${lib.base}/questions/${first.id}?setId=${set.id}` })).json()).toMatchObject({ active: false });

    // Syncing the still-empty folder again changes nothing.
    expect((await lib.sync()).body).toMatchObject({ changed: false, issues: [] });
    expect(lib.generation()).toBe(before + 1);
  });

  it("deactivates many local files at once and keeps uploaded files", async () => {
    const lib = await folderLibrary();
    await mkdir(join(lib.root, "quant"));
    await writeFile(join(lib.root, "quant", "a.md"), bankOf("Alpha stem"));
    await writeFile(join(lib.root, "quant", "b.md"), bankOf("Beta stem"));
    await lib.sync();
    const uploaded = await lib.app.inject({
      method: "POST",
      url: `${lib.base}/imports/preview`,
      payload: { files: [{ path: "uploaded.md", content: bankOf("Uploaded stem") }] },
    });
    await lib.app.inject({ method: "POST", url: `${lib.base}/imports/${uploaded.json().id}/commit`, payload: { acceptWarnings: true } });
    expect(lib.activeQuestions()).toHaveLength(6);

    await rm(join(lib.root, "quant"), { recursive: true });
    const before = lib.generation();
    expect((await lib.sync()).body).toMatchObject({ changed: true, questions: 2 });
    expect(lib.generation()).toBe(before + 1);
    const activeFiles = lib.store.list(lib.libraryId, "file").filter((f: any) => f.active);
    expect(activeFiles.map((f: any) => [f.path, f.local])).toEqual([["uploaded.md", false]]);
    expect(lib.activeQuestions().every((q) => q.source === "uploaded")).toBe(true);
    expect(await lib.search("Uploaded")).toHaveLength(2);
    expect(await lib.search("Alpha")).toHaveLength(0);
  });

  it("leaves a library synced to an empty folder unchanged", async () => {
    const lib = await folderLibrary();
    expect(await lib.sync()).toEqual({ status: 200, body: { changed: false, issues: [] } });
    expect(lib.generation()).toBe(0);
  });

  it("treats a missing folder as an error, and an empty manual upload as invalid", async () => {
    const lib = await folderLibrary();
    await writeFile(join(lib.root, "bank.md"), bankOf("Kept stem"));
    await lib.sync();
    const before = lib.generation();
    await rm(lib.root, { recursive: true });
    const missing = await lib.sync();
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe("ROOT_UNAVAILABLE");
    expect(lib.activeQuestions()).toHaveLength(2);
    expect(lib.generation()).toBe(before);

    const empty = await lib.app.inject({ method: "POST", url: `${lib.base}/imports/preview`, payload: { files: [] } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe("FILES_REQUIRED");
  });
});

describe("restoring a removed folder file", () => {
  it("brings back the same questions with their answers, flags, notes, chats and set links, cycle after cycle", async () => {
    const lib = await folderLibrary();
    const bytes = bankOf("Restored stem");
    await writeFile(join(lib.root, "bank.md"), bytes);
    await writeFile(join(lib.root, "other.md"), bankOf("Other stem"));
    await lib.sync();
    const [first, second] = lib.questionsOf("bank.md");
    await lib.app.inject({ method: "POST", url: `${lib.base}/questions/${second.id}/answer`, payload: { operationId: lib.operationId(), expectedVersion: 0, selection: "A", confidence: "sure" } });
    await lib.app.inject({ method: "POST", url: `${lib.base}/questions/${first.id}/answer`, payload: { operationId: lib.operationId(), expectedVersion: 0, selection: "B", confidence: "unsure" } });
    await lib.app.inject({ method: "PATCH", url: `${lib.base}/questions/${first.id}/annotation`, payload: { operationId: lib.operationId(), expectedVersion: 0, flagged: true, note: "Remember me." } });
    const chat = (await lib.app.inject({ method: "POST", url: `${lib.base}/chats`, payload: { questionId: first.id } })).json();
    const set = (await lib.app.inject({ method: "POST", url: `${lib.base}/sets`, payload: { operationId: lib.operationId(), title: "Kept" } })).json();
    const original = lib.questionsOf("bank.md");

    for (let cycle = 0; cycle < 2; cycle++) {
      await rm(join(lib.root, "bank.md"));
      await lib.sync();
      expect(lib.questionsOf("bank.md").every((q) => !q.active)).toBe(true);
      await writeFile(join(lib.root, "bank.md"), bytes);
      expect((await lib.sync()).body).toMatchObject({ changed: true, questions: 4 });

      const restored = lib.questionsOf("bank.md");
      // Same identities, nothing accumulated, and the same content version, state and annotation.
      expect(restored.map((q) => q.id).sort()).toEqual(original.map((q) => q.id).sort());
      expect(restored.every((q) => q.active)).toBe(true);
      for (const q of original)
        expect(restored.find((r) => r.id === q.id)).toMatchObject({ contentVersion: q.contentVersion, state: q.state, annotation: q.annotation });
      // Answer order survives: the second question was answered first.
      const byId = new Map(restored.map((q) => [q.id, q]));
      expect(byId.get(second.id).state.answerSequence).toBeLessThan(byId.get(first.id).state.answerSequence);
      expect((await lib.app.inject({ method: "POST", url: `${lib.base}/chats`, payload: { questionId: first.id } })).json().id).toBe(chat.id);
      expect((await lib.app.inject({ url: `${lib.base}/questions/${first.id}?setId=${set.id}` })).json()).toMatchObject({ active: true, setState: { selection: "B" } });
      expect(await lib.search("Restored")).toHaveLength(2);
    }
  });

  it("gives altered restored content new identities after its own review", async () => {
    const lib = await folderLibrary();
    await writeFile(join(lib.root, "bank.md"), bankOf("Edited stem"));
    await writeFile(join(lib.root, "other.md"), bankOf("Other stem"));
    await lib.sync();
    const [first] = lib.questionsOf("bank.md");
    await lib.app.inject({ method: "POST", url: `${lib.base}/questions/${first.id}/answer`, payload: { operationId: lib.operationId(), expectedVersion: 0, selection: "B" } });
    await rm(join(lib.root, "bank.md"));
    await lib.sync();

    // Same headings and stems, different solution bytes: not an exact restoration.
    await writeFile(join(lib.root, "bank.md"), bankOf("Edited stem", "Reworked."));
    const preview = (await lib.app.inject({ method: "POST", url: `${lib.base}/imports/root-preview`, payload: {} })).json();
    expect(preview.identityProposals.filter((p: any) => p.path === "bank.md").every((p: any) => p.automatic === null)).toBe(true);
    await lib.sync();
    const active = lib.questionsOf("bank.md").filter((q) => q.active);
    expect(active).toHaveLength(2);
    expect(active.map((q) => q.id)).not.toContain(first.id);
    expect(lib.store.get(lib.libraryId, first.id, "question")).toMatchObject({ active: false, state: { selection: "B" } });
  });

  it("restores a file removed before membership was recorded only when one old identity fits", async () => {
    const lib = await folderLibrary();
    const bytes = bankOf("Legacy stem");
    await writeFile(join(lib.root, "bank.md"), bytes);
    await writeFile(join(lib.root, "other.md"), bankOf("Other stem"));
    await lib.sync();
    const [first, second] = lib.questionsOf("bank.md");
    await rm(join(lib.root, "bank.md"));
    await lib.sync();
    // An older database: the removed file has no recorded membership, and an earlier
    // restoration left a second inactive identity with exactly the first question's content.
    const file = lib.store.list(lib.libraryId, "file").find((f: any) => f.path === "bank.md");
    const { removedQuestionIds, ...legacyFile } = file;
    expect(removedQuestionIds).toEqual(expect.arrayContaining([first.id, second.id]));
    lib.store.put(lib.libraryId, "file", legacyFile);
    lib.store.put(lib.libraryId, "question", { ...lib.store.get(lib.libraryId, first.id, "question"), id: "competing-identity" });

    await writeFile(join(lib.root, "bank.md"), bytes);
    // The preview shows the tie for review instead of picking one.
    const preview = (await lib.app.inject({ method: "POST", url: `${lib.base}/imports/root-preview`, payload: {} })).json();
    const [contested, unique] = preview.identityProposals.filter((p: any) => p.path === "bank.md");
    expect(unique.automatic).toMatchObject({ id: second.id });
    expect(contested.automatic).toBeNull();
    expect(contested.candidates.map((c: any) => c.id)).toEqual(expect.arrayContaining([first.id, "competing-identity"]));
    expect(preview.issues.some((issue: any) => issue.path === "bank.md" && issue.message.includes("identity requires review"))).toBe(true);
    await lib.sync();
    const active = lib.questionsOf("bank.md").filter((q) => q.active);
    expect(active).toHaveLength(2);
    // The unique fit comes back; the contested one is not merged into either old identity.
    expect(active.map((q) => q.id)).toContain(second.id);
    expect(active.map((q) => q.id)).not.toContain(first.id);
    expect(active.map((q) => q.id)).not.toContain("competing-identity");
  });

  it("brings back the same questions when a removed upload is uploaded again", async () => {
    const lib = await folderLibrary();
    const upload = async () => {
      const preview = await lib.app.inject({ method: "POST", url: `${lib.base}/imports/preview`, payload: { files: [{ path: "uploaded.md", content: bankOf("Upload stem") }] } });
      expect(preview.json().identityProposals.every((p: any) => p.candidates.length === 0)).toBe(true);
      return lib.app.inject({ method: "POST", url: `${lib.base}/imports/${preview.json().id}/commit`, payload: { acceptWarnings: true } });
    };
    await upload();
    const original = lib.questionsOf("uploaded.md").map((q) => q.id).sort();
    const file = lib.store.list(lib.libraryId, "file").find((f: any) => f.path === "uploaded.md");
    expect((await lib.app.inject({ method: "DELETE", url: `${lib.base}/files/${file.id}` })).statusCode).toBe(200);
    expect((await upload()).statusCode).toBe(200);
    expect(lib.questionsOf("uploaded.md").filter((q) => q.active).map((q) => q.id).sort()).toEqual(original);
    expect(lib.store.get(lib.libraryId, file.id, "file")).toMatchObject({ active: true, version: 1 });
  });
});
