import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app.js";
import { parseQuestions } from "../packages/domain/src/index.js";
import { Store } from "../apps/server/src/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const bank = (key = "B") =>
  `# Chapter 1\n## Case 1\nA shared passage.\n### Question 1\nWhat is 2 + 2?\n#### Choices\nA. 3\nB. 4\nC. 5\n#### Answer\n${key}\n#### Solution\nAdd two and two.\n`;
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.open) store.db.close();
});
function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const library = store.createLibrary("Study");
  const preview = store.preview(library.id, [
    { path: "bank.md", content: bank() },
  ]);
  store.commit(library.id, preview.id, true);
  const q = store.list(library.id, "question")[0];
  return { store, libraryId: library.id, q };
}
describe("durable practice contract", () => {
  it("reopens persisted answers, cursor, source revisions and retry receipts", () => {
    const directory = mkdtempSync(join(tmpdir(), "study-persistence-"));
    const path = join(directory, "study.sqlite");
    const original = new Store(path);
    const library = original.createLibrary("Persistent");
    const preview = original.preview(library.id, [
      { path: "bank.md", content: bank() },
    ]);
    original.commit(library.id, preview.id, true);
    const question = original.list(library.id, "question")[0];
    original.put(library.id, "set", {
      id: "saved-set",
      cursor: 0,
      items: [{ questionId: question.id, submitted: false }],
    });
    const request = {
      operationId: "persistent-answer",
      expectedVersion: 0,
      selection: "B",
      setId: "saved-set",
    };
    original.answer(library.id, question.id, request);
    original.db.close();
    const reopened = new Store(path);
    try {
      expect(
        reopened.question(library.id, question.id, "saved-set"),
      ).toMatchObject({
        state: { selection: "B", answerSequence: 1 },
        setState: { submitted: true },
      });
      expect(
        reopened.answer(library.id, question.id, request).answerSequence,
      ).toBe(1);
      expect(reopened.list(library.id, "fileRevision")[0].content).toBe(bank());
      expect(reopened.search(library.id, "shared")).toHaveLength(1);
    } finally {
      reopened.db.close();
      rmSync(directory, { recursive: true });
    }
  });
  it("grades sure/unsure, clears wrong confidence, deduplicates retries and rejects stale writes", () => {
    const { store, libraryId, q } = fixture();
    const request = {
      operationId: "first",
      expectedVersion: 0,
      selection: "B",
      confidence: "unsure",
    };
    expect(store.answer(libraryId, q.id, request)).toMatchObject({
      status: "unsure",
      answerSequence: 1,
    });
    expect(store.answer(libraryId, q.id, request).answerSequence).toBe(1);
    expect(() =>
      store.answer(libraryId, q.id, { ...request, operationId: "stale" }),
    ).toThrow("newer answer");
    expect(
      store.answer(libraryId, q.id, {
        operationId: "second",
        expectedVersion: 1,
        selection: "A",
        confidence: "unsure",
      }),
    ).toMatchObject({ confidence: null, status: "wrong", answerSequence: 2 });
    expect(
      store.answer(libraryId, q.id, {
        operationId: "third",
        expectedVersion: 2,
        selection: "B",
      }),
    ).toMatchObject({ confidence: "sure", status: "correct" });
  });
  it("preserves stable identity and recency after key correction and file rename", () => {
    const { store, libraryId, q } = fixture();
    store.answer(libraryId, q.id, {
      operationId: "first",
      expectedVersion: 0,
      selection: "A",
    });
    const preview = store.preview(libraryId, [
      { path: "bank.md", content: bank("A") },
    ]);
    store.commit(libraryId, preview.id, true);
    expect(store.question(libraryId, q.id)).toMatchObject({
      status: "correct",
      state: { answerSequence: 1, confidence: "sure" },
    });
    const rename = store.preview(libraryId, [
      { path: "renamed.md", content: bank("A") },
    ]);
    store.commit(libraryId, rename.id, true);
    expect(
      store
        .list(libraryId, "question")
        .filter((q) => q.active)
        .map((q) => q.id),
    ).toEqual([q.id]);
    expect(store.list(libraryId, "file")[0].path).toBe("renamed.md");
  });
  it("carries the latest answer into a new set and keeps each set's own later answers", () => {
    const { store, libraryId, q } = fixture();
    expect(store.question(libraryId, q.id)).not.toHaveProperty("answerKey");
    const first = store.put(libraryId, "set", {
      id: "set1",
      items: [{ questionId: q.id, submitted: false }],
    });
    store.answer(libraryId, q.id, {
      operationId: "first",
      expectedVersion: 0,
      selection: "B",
      setId: first.id,
    });
    store.put(libraryId, "set", {
      id: "set2",
      items: [{ questionId: q.id, submitted: false }],
    });
    expect(store.question(libraryId, q.id, "set2")).toMatchObject({
      revealed: true,
      setState: { submitted: true, selection: "B" },
    });
    store.answer(libraryId, q.id, {
      operationId: "second",
      expectedVersion: 1,
      selection: "C",
      setId: "set2",
    });
    expect(store.question(libraryId, q.id, "set1")).toMatchObject({
      state: { selection: "C" },
      setState: { selection: "B" },
    });
  });
  it("rejects stale previews and retains old active imports on structural failure", () => {
    const { store, libraryId, q } = fixture();
    const old = store.preview(libraryId, [
      { path: "bank.md", content: bank("A") },
    ]);
    const current = store.preview(libraryId, [
      { path: "bank.md", content: bank("C") },
    ]);
    store.commit(libraryId, current.id, true);
    expect(() => store.commit(libraryId, old.id, true)).toThrow(
      "changed since preview",
    );
    const invalid = store.preview(libraryId, [
      { path: "bank.md", content: "# Just a heading" },
    ]);
    expect(() => store.commit(libraryId, invalid.id, true)).toThrow(
      "structural errors",
    );
    expect(store.get(libraryId, q.id).answerKey).toBe("C");
  });
  it("applies explicit compatible identity decisions and rejects changed choice semantics", () => {
    const { store, libraryId, q } = fixture();
    store.answer(libraryId, q.id, {
      operationId: "first",
      expectedVersion: 0,
      selection: "B",
    });
    const edited = store.preview(libraryId, [
      {
        path: "bank.md",
        content: bank().replace(
          "What is 2 + 2?",
          "Calculate the sum of 2 and 2.",
        ),
      },
    ]);
    expect(edited.identityProposals[0].candidates[0].choicesCompatible).toBe(
      true,
    );
    store.commit(libraryId, edited.id, true, {
      [edited.identityProposals[0].key]: q.id,
    });
    expect(store.question(libraryId, q.id)).toMatchObject({
      stem: "Calculate the sum of 2 and 2.",
      state: { selection: "B", answerSequence: 1 },
    });
    const incompatible = store.preview(libraryId, [
      { path: "bank.md", content: bank().replace("B. 4", "B. 99") },
    ]);
    expect(() =>
      store.commit(libraryId, incompatible.id, true, {
        [incompatible.identityProposals[0].key]: q.id,
      }),
    ).toThrow("Choice labels or meanings changed");
    expect(store.question(libraryId, q.id).active).toBe(true);
  });
  it("regrades saved set confidence after key repair and preserves immutable revisions across a move", () => {
    const { store, libraryId, q } = fixture();
    store.put(libraryId, "set", {
      id: "repair-set",
      items: [{ questionId: q.id, submitted: false }],
    });
    store.answer(libraryId, q.id, {
      operationId: "wrong-in-set",
      expectedVersion: 0,
      selection: "A",
      setId: "repair-set",
    });
    const repair = store.preview(libraryId, [
      { path: "bank.md", content: bank("A") },
    ]);
    store.commit(libraryId, repair.id, true);
    expect(
      store.question(libraryId, q.id, "repair-set").setState,
    ).toMatchObject({ confidence: "sure", answerSequence: 1 });
    const moved = store.preview(libraryId, [
      {
        path: "elsewhere.md",
        content: bank("A").replace("What is 2 + 2?", "Compute 2 + 2."),
      },
    ]);
    store.commit(libraryId, moved.id, true, {
      [moved.identityProposals[0].key]: q.id,
    });
    expect(store.get(libraryId, `${q.id}:1`, "questionRevision").stem).toBe(
      "What is 2 + 2?",
    );
    expect(store.get(libraryId, `${q.id}:3`, "questionRevision").stem).toBe(
      "Compute 2 + 2.",
    );
  });
  it("supports explicitly configured numerical choice labels", () => {
    const content = bank()
      .replace("A. 3", "1. 3")
      .replace("B. 4", "2. 4")
      .replace("C. 5", "3. 5")
      .replace("#### Answer\nB", "#### Answer\n2");
    expect(
      parseQuestions(content, "bank.md", ["1", "2", "3"]).questions[0]
        .answerKey,
    ).toBe("2");
  });
  it("parses fenced fake headings and multiline choices without inventing questions", () => {
    const parsed = parseQuestions(bank() + "\n```md\n### Question 99\n```");
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions[0].caseText).toBe("A shared passage.");
    expect(parseQuestions(bank("A or B")).questions[0].answerKey).toBeNull();
  });
});
describe("HTTP boundaries", () => {
  it("archives libraries without losing readable history and unarchives with a guarded write", async () => {
    const { app, store } = await buildApp();
    const library = store.createLibrary("Archive");
    const prefix = `/api/libraries/${library.id}`;
    let response = await app.inject({
      method: "PATCH",
      url: `${prefix}/settings`,
      payload: { operationId: "archive", expectedVersion: 0, archived: true },
    });
    expect(response.json().archived).toBe(true);
    expect((await app.inject(`${prefix}/overview`)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${prefix}/notes`,
          payload: { title: "Blocked", content: "No" },
        })
      ).statusCode,
    ).toBe(409);
    response = await app.inject({
      method: "PATCH",
      url: `${prefix}/settings`,
      payload: {
        operationId: "unarchive",
        expectedVersion: 1,
        archived: false,
        settings: { choiceLabels: ["A", "B", "C"] },
      },
    });
    expect(response.json().archived).toBe(false);
    await app.close();
  });
  it("enforces login and rejects cross-origin changes", async () => {
    const { app } = await buildApp({ password: "test-password" });
    expect((await app.inject("/api/libraries")).statusCode).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/session",
      payload: { password: "test-password" },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies[0];
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/libraries",
          headers: {
            cookie: `${cookie.name}=${cookie.value}`,
            origin: "https://evil.example",
          },
          payload: { name: "Bad" },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
  });
  it("scope-checks records, protects search spoilers and preserves Focus suppressions", async () => {
    const { app, store } = await buildApp();
    const one = store.createLibrary("One"),
      two = store.createLibrary("Two");
    const preview = store.preview(one.id, [
      { path: "bank.md", content: bank() },
    ]);
    store.commit(one.id, preview.id, true);
    const q = store.list(one.id, "question")[0];
    const prefix = `/api/libraries/${one.id}`;
    expect(
      (await app.inject(`/api/libraries/${two.id}/questions/${q.id}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject(`${prefix}/search?q=Add%20two`)).json().results,
    ).toEqual([]);
    store.answer(one.id, q.id, {
      operationId: "wrong",
      expectedVersion: 0,
      selection: "A",
    });
    let response = await app.inject({
      method: "POST",
      url: `${prefix}/focus/refresh`,
    });
    const focus = response.json().items[0];
    await app.inject({
      method: "PATCH",
      url: `${prefix}/focus/${focus.id}`,
      payload: { status: "resolved" },
    });
    response = await app.inject({
      method: "POST",
      url: `${prefix}/focus/refresh`,
    });
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].status).toBe("resolved");
    const set = await app.inject({
      method: "POST",
      url: `${prefix}/sets`,
      payload: { title: "Frozen" },
    });
    await app.inject({ method: "DELETE", url: `${prefix}/files/${q.fileId}` });
    const removed = await app.inject(
      `${prefix}/questions/${q.id}?setId=${set.json().id}`,
    );
    // Answered earlier in another context, so the new set carries that answer and its key.
    expect(removed.json()).toMatchObject({ active: false, revealed: true });
    expect(store.select(one.id, {})).toEqual([]);
    await app.close();
  });
  it("returns actionable validation errors for corrupt import and set inputs", async () => {
    const { app, store } = await buildApp();
    const library = store.createLibrary("Bad inputs");
    const prefix = `/api/libraries/${library.id}`;
    for (const files of [
      [null],
      [{ path: "../outside.md", content: bank() }],
      [{ path: "bank.md", content: 42 }],
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${prefix}/imports/preview`,
            payload: { files },
          })
        ).statusCode,
      ).toBe(400);
    for (const body of [
      { limit: 0 },
      { limit: -1 },
      { filters: { statuses: "wrong" } },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${prefix}/sets/preview`,
            payload: body,
          })
        ).statusCode,
      ).toBe(400);
    await app.close();
  });
});

describe("login cookie behind an HTTPS proxy", () => {
  it("is Secure only when the proxy is trusted and says HTTPS", async () => {
    const login = async (trustProxy: boolean) => {
      const { app } = await buildApp({ password: "pw", trustProxy });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/session",
          headers: { "x-forwarded-proto": "https" },
          payload: { password: "pw" },
        });
        return String(response.headers["set-cookie"]);
      } finally {
        await app.close();
      }
    };
    expect(await login(true)).toContain("Secure");
    expect(await login(false)).not.toContain("Secure");
  });
});

describe("login sessions", () => {
  it("survive a restart, renew on open, and use SameSite=Lax", async () => {
    const directory = mkdtempSync(join(tmpdir(), "study-session-"));
    const databasePath = join(directory, "study.sqlite");
    try {
      const first = await buildApp({ databasePath, password: "pw" });
      const login = await first.app.inject({
        method: "POST",
        url: "/api/session",
        payload: { password: "pw" },
      });
      const cookie = String(login.headers["set-cookie"]);
      expect(cookie).toContain("SameSite=Lax");
      const token = /study_session=([^;]+)/.exec(cookie)![1];
      await first.app.close();
      const second = await buildApp({ databasePath, password: "pw" });
      const reopened = await second.app.inject({
        url: "/api/session",
        cookies: { study_session: token },
      });
      expect(reopened.json()).toEqual({ authenticated: true });
      expect(String(reopened.headers["set-cookie"])).toContain(
        "Max-Age=2592000",
      );
      const stranger = await second.app.inject({
        url: "/api/session",
        cookies: { study_session: "not-a-session" },
      });
      expect(stranger.json()).toEqual({ authenticated: false });
      await second.app.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
