import { expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app.js";
const content =
  "# Chapter\n## Question 1\nWhat is 1 + 1?\n### Choices\nA. 1\nB. 2\n### Answer\nB\n### Solution\nOne plus one equals two.";
it("validates AI Focus evidence and preserves suppressions without duplicate synthesis writes", async () => {
  let questionId = "",
    calls = 0,
    forged = false;
  const provider = {
    async *stream() {
      calls++;
      yield {
        type: "text",
        text: JSON.stringify({
          items: [
            {
              conceptKey: "addition",
              title: "Addition",
              body: "Review the arithmetic shown in the source solution.",
              questionIds: [forged ? "foreign-id" : questionId],
            },
          ],
        }),
      };
      yield { type: "done" };
    },
  };
  const { app, store } = await buildApp({ provider });
  try {
    const library = store.createLibrary("Focus");
    const prefix = `/api/libraries/${library.id}`;
    const preview = store.preview(library.id, [{ path: "bank.md", content }]);
    store.commit(library.id, preview.id, true);
    questionId = store.list(library.id, "question")[0].id;
    store.answer(library.id, questionId, {
      operationId: "answer",
      expectedVersion: 0,
      selection: "A",
    });
    const body = { operationId: "focus-one", model: "fake-model" };
    const first = await app.inject({
      method: "POST",
      url: `${prefix}/focus/synthesize`,
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    const item = first.json().items[0];
    expect(item.links[0].questionId).toBe(questionId);
    await app.inject({
      method: "POST",
      url: `${prefix}/focus/synthesize`,
      payload: body,
    });
    expect(calls).toBe(1);
    await app.inject({
      method: "PATCH",
      url: `${prefix}/focus/${item.id}`,
      payload: { status: "resolved", expectedVersion: item.version },
    });
    const again = await app.inject({
      method: "POST",
      url: `${prefix}/focus/synthesize`,
      payload: { operationId: "focus-two", model: "fake-model" },
    });
    expect(again.json().items[0].status).toBe("resolved");
    expect(store.list(library.id, "focus")).toHaveLength(1);
    forged = true;
    const bad = await app.inject({
      method: "POST",
      url: `${prefix}/focus/synthesize`,
      payload: { operationId: "focus-three", model: "fake-model" },
    });
    expect(bad.statusCode).toBe(502);
    expect(store.list(library.id, "focus")).toHaveLength(1);
    expect(
      store.list(library.id, "focusRun").find((run) => run.status === "failed"),
    ).toBeDefined();
  } finally {
    await app.close();
  }
});
