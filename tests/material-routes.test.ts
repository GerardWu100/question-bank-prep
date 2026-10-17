import { expect, test } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { registerMaterialRoutes } from "../apps/server/src/material-routes.js";
const content =
  "# Chapter 1\n## Question 1\nPick two\n### Choices\nA. One\nB. Two\nC. Three\n### Answer\nB\n### Solution\nTwo is two.";
test("root import refuses stale source bytes, then saves to the original file and commits a new revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-root-"));
  const { app, store } = await buildApp();
  registerMaterialRoutes(app, store, root, join(root, ".data"));
  try {
    await writeFile(join(root, "bank.md"), content);
    const library = store.createLibrary("Local");
    const base = `/api/libraries/${library.id}`;
    let preview = (
      await app.inject({
        method: "POST",
        url: base + "/imports/root-preview",
        payload: {},
      })
    ).json();
    await writeFile(join(root, "bank.md"), content + "\nChanged");
    expect(
      (
        await app.inject({
          method: "POST",
          url: base + `/imports/${preview.id}/root-commit`,
          payload: { acceptWarnings: true },
        })
      ).statusCode,
    ).toBe(409);
    preview = (
      await app.inject({
        method: "POST",
        url: base + "/imports/root-preview",
        payload: {},
      })
    ).json();
    expect(
      (
        await app.inject({
          method: "POST",
          url: base + `/imports/${preview.id}/root-commit`,
          payload: { acceptWarnings: true },
        })
      ).statusCode,
    ).toBe(200);
    const file = store.list(library.id, "file")[0];
    expect(file.local).toBe(true);
    const response = await app.inject({
      method: "PUT",
      url: base + `/files/${file.id}/local-save`,
      payload: {
        operationId: "local-save-test",
        expectedHash: file.hash,
        content: content.replace("### Answer\nB", "### Answer\nC"),
        acceptWarnings: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().version).toBe(2);
    expect(store.list(library.id, "question")[0].answerKey).toBe("C");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("root sync imports the folder, skips unchanged bytes, and follows edits and removals", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-root-"));
  const { app, store } = await buildApp();
  registerMaterialRoutes(app, store, root, join(root, ".data"));
  try {
    await writeFile(join(root, "bank.md"), content);
    const library = store.createLibrary("Local");
    const sync = async () =>
      (
        await app.inject({
          method: "POST",
          url: `/api/libraries/${library.id}/imports/root-sync`,
          payload: {},
        })
      ).json();
    expect((await sync()).changed).toBe(true);
    expect((await sync()).changed).toBe(false);
    await writeFile(
      join(root, "bank.md"),
      content.replace("### Answer\nB", "### Answer\nC"),
    );
    expect((await sync()).changed).toBe(true);
    const question = store
      .list(library.id, "question")
      .find((q: any) => q.active);
    expect(question.answerKey).toBe("C");
    await rm(join(root, "bank.md"));
    await writeFile(join(root, "other.md"), content);
    await sync();
    const active = store.list(library.id, "file").filter((f: any) => f.active);
    expect(active.map((f: any) => f.path)).toEqual(["other.md"]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
