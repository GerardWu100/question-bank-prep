import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { registerMaterialRoutes } from "../apps/server/src/material-routes.js";
import {
  listReadingFilesWithSizes,
  readReadingLines,
  registerReadingRoutes,
  runRipgrep,
  searchReading,
} from "../apps/server/src/reading-routes.js";

test("reading folder lists Markdown and serves files read-only, refusing escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-reading-"));
  const outside = await mkdtemp(join(tmpdir(), "study-outside-"));
  const { app } = await buildApp();
  registerReadingRoutes(app, root);
  try {
    await mkdir(join(root, "Kaplan", "assets"), { recursive: true });
    await writeFile(
      join(root, "Kaplan", "notes.md"),
      "# Notes\n![x](assets/a.png)",
    );
    await writeFile(join(root, "Kaplan", "assets", "a.png"), "png");
    await writeFile(join(root, "Kaplan", "assets", "a.svg"), "<svg/>");
    await writeFile(join(root, "Kaplan", "assets", "a.html"), "<p>");
    await writeFile(join(outside, "secret.md"), "secret");
    await symlink(join(outside, "secret.md"), join(root, "link.md"));
    expect((await app.inject("/api/reading")).json()).toEqual({
      configured: true,
      files: ["Kaplan/notes.md"],
    });
    const file = await app.inject("/api/reading/file?path=Kaplan%2Fnotes.md");
    expect(file.body).toContain("# Notes");
    const image = await app.inject(
      "/api/reading/file?path=Kaplan%2Fassets%2Fa.png",
    );
    expect(image.headers["content-type"]).toBe("image/png");
    // SVG is served, but sandboxed so a script inside it cannot run.
    const svg = await app.inject(
      "/api/reading/file?path=Kaplan%2Fassets%2Fa.svg",
    );
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(svg.headers["content-security-policy"]).toContain("sandbox");
    for (const path of [
      "..%2Fsecret.md",
      "link.md",
      "Kaplan%2Fassets%2Fa.html",
    ])
      expect(
        (await app.inject(`/api/reading/file?path=${path}`)).statusCode,
      ).toBe(400);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("question-bank images load from the bank folder; questions name their bank file", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-bank-"));
  const data = await mkdtemp(join(tmpdir(), "study-data-"));
  const { app, store } = await buildApp();
  registerMaterialRoutes(app, store, root, data);
  try {
    await mkdir(join(root, "quant", "assets"), { recursive: true });
    await writeFile(join(root, "quant", "assets", "fan.svg"), "<svg/>");
    await writeFile(join(root, "quant", "drills.md"), "notes");
    const library = store.createLibrary("Study");
    const bank =
      "# Chapter 1\n### Question Q-1\n![Fan](assets/fan.svg)\n#### Choices\nA. 1\nB. 2\n#### Answer\nA\n";
    store.commit(
      library.id,
      store.preview(library.id, [{ path: "quant/drills.md", content: bank }])
        .id,
      true,
    );
    const [question] = store.list(library.id, "question");
    expect(store.question(library.id, question.id).path).toBe(
      "quant/drills.md",
    );
    const image = await app.inject(
      "/api/material-root/file?path=quant%2Fassets%2Ffan.svg",
    );
    expect(image.headers["content-type"]).toBe("image/svg+xml");
    // Images only: the bank's Markdown itself is not served here.
    for (const path of ["quant%2Fdrills.md", "..%2Fx.png"])
      expect(
        (await app.inject(`/api/material-root/file?path=${path}`)).statusCode,
      ).toBe(400);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("tutor search finds lines with every word and names their section", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-reading-"));
  try {
    await mkdir(join(root, "Kaplan"), { recursive: true });
    await writeFile(
      join(root, "Kaplan", "notes.md"),
      "# Module 3.2 Heteroskedasticity\nWhite-corrected standard errors fix inference.\n## Other\nStandard errors again.",
    );
    expect(await searchReading(root, "white standard errors")).toEqual([
      {
        path: "Kaplan/notes.md",
        line: 2,
        section: "Module 3.2 Heteroskedasticity",
        text: "White-corrected standard errors fix inference.",
      },
    ]);
    expect((await readReadingLines(root, "Kaplan/notes.md", 2, 1)).text).toBe(
      "2: White-corrected standard errors fix inference.",
    );
    await expect(
      readReadingLines(root, "../secret.md", 1, 5),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
