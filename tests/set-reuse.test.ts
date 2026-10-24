import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app.js";

/** One Markdown question per entry: [stem, choice B text, answer key]. */
const bankOf = (questions: [string, string, string][]) =>
  `# Chapter 1\n${questions
    .map(
      ([stem, choiceB, key], index) =>
        `## Question ${index + 1}\n${stem}\n### Choices\nA. 1\nB. ${choiceB}\nC. 3\n### Answer\n${key}\n### Solution\nWorked.\n`,
    )
    .join("")}`;
const apps: Awaited<ReturnType<typeof buildApp>>["app"][] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function libraryWith(content: string) {
  const { app, store } = await buildApp();
  apps.push(app);
  const library = store.createLibrary("Reuse");
  const prefix = `/api/libraries/${library.id}`;
  const importBank = (bankContent: string) =>
    store.commit(
      library.id,
      store.preview(library.id, [{ path: "drills/bank.md", content: bankContent }])
        .id,
      true,
    );
  importBank(content);
  let operations = 0;
  /** A fresh Start: reuse an earlier set only when it holds exactly these questions. */
  const start = async (body: Record<string, unknown>) => {
    const response = await app.inject({
      method: "POST",
      url: `${prefix}/sets`,
      payload: { operationId: `start-${++operations}`, reuse: true, ...body },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const activeIds = () =>
    store
      .list(library.id, "question")
      .filter((q) => q.active)
      .map((q) => q.id);
  return { app, store, libraryId: library.id, prefix, importBank, start, activeIds };
}

describe("fresh Start resolves or creates a set by its exact questions", () => {
  it("reuses unchanged membership and builds a new set after a same-size bank replacement", async () => {
    const { app, prefix, importBank, start, activeIds } = await libraryWith(
      bankOf([["What is one plus one?", "2", "B"]]),
    );
    const filters = { topic: "drills", source: "", chapter: "" };
    const first = await start({ title: "Drills", filters, order: "source" });
    const [oldQuestionId] = activeIds();
    expect(first.questionIds).toEqual([oldQuestionId]);
    // Same filters, same questions: the earlier set (and its place) is reopened.
    expect((await start({ title: "Drills", filters, order: "source" })).id).toBe(
      first.id,
    );

    // A materially different question with the same count, imported without a mapping.
    importBank(bankOf([["Which planet is largest?", "Jupiter", "B"]]));
    const [newQuestionId] = activeIds();
    expect(newQuestionId).not.toBe(oldQuestionId);
    const fresh = await start({ title: "Drills", filters, order: "source" });
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.questionIds).toEqual([newQuestionId]);

    // The frozen set stays as history with its original question.
    const old = await app.inject(`${prefix}/sets/${first.id}`);
    expect(old.statusCode).toBe(200);
    expect(old.json().questionIds).toEqual([oldQuestionId]);
  });

  it("refreshes a one-question Mistakes set when its wrong member changes", async () => {
    const { store, libraryId, start, activeIds } = await libraryWith(
      bankOf([
        ["First stem?", "2", "B"],
        ["Second stem?", "4", "B"],
      ]),
    );
    const [firstId, secondId] = activeIds();
    const answer = (questionId: string, selection: string, operationId: string) =>
      store.answer(libraryId, questionId, {
        operationId,
        expectedVersion: store.get(libraryId, questionId, "question").state.version,
        selection,
      });
    const filters = { topic: "", statuses: ["wrong"], flagged: false, sources: [] };
    answer(firstId, "A", "first-wrong");
    const mistakes = await start({ title: "Mistakes", filters, order: "source" });
    expect(mistakes.questionIds).toEqual([firstId]);
    expect((await start({ title: "Mistakes", filters, order: "source" })).id).toBe(
      mistakes.id,
    );
    answer(firstId, "B", "first-fixed");
    answer(secondId, "C", "second-wrong");
    const refreshed = await start({ title: "Mistakes", filters, order: "source" });
    expect(refreshed.id).not.toBe(mistakes.id);
    expect(refreshed.questionIds).toEqual([secondId]);
  });

  it("respects the selected order and keeps retry receipts", async () => {
    const { app, prefix, store, libraryId, start } = await libraryWith(
      bankOf([
        ["Alpha?", "2", "B"],
        ["Beta?", "4", "B"],
        ["Gamma?", "6", "B"],
        ["Delta?", "8", "B"],
      ]),
    );
    const filters = { topic: "drills", chapter: "" };
    const inSourceOrder = await start({ title: "All", filters, order: "source" });
    // Find a shuffle seed whose order differs from source order.
    let seed = 0;
    while (
      JSON.stringify(store.select(libraryId, { filters, order: "shuffle", seed })) ===
      JSON.stringify(inSourceOrder.questionIds)
    )
      seed++;
    const shuffled = await start({ title: "All", filters, order: "shuffle", seed });
    expect(shuffled.id).not.toBe(inSourceOrder.id);
    expect(shuffled.questionIds).toEqual(
      store.select(libraryId, { filters, order: "shuffle", seed }),
    );
    // Filters stored with another key order still name the same deck.
    expect(
      (
        await start({
          title: "All",
          filters: { chapter: "", topic: "drills" },
          order: "source",
        })
      ).id,
    ).toBe(inSourceOrder.id);

    const retried = {
      method: "POST" as const,
      url: `${prefix}/sets`,
      payload: { operationId: "retry-me", reuse: true, title: "All", filters: {} },
    };
    const firstTry = (await app.inject(retried)).json();
    const secondTry = (await app.inject(retried)).json();
    expect(secondTry.id).toBe(firstTry.id);
    // Without reuse, Start still creates a separate set.
    const separate = await app.inject({
      method: "POST",
      url: `${prefix}/sets`,
      payload: { operationId: "no-reuse", title: "All", filters },
    });
    expect(separate.json().id).not.toBe(inSourceOrder.id);
  });
});
