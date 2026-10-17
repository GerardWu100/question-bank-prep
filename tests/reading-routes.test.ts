import { expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
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
    for (const path of ["..%2Fsecret.md", "link.md", "Kaplan%2Fassets%2Fa.svg"])
      expect(
        (await app.inject(`/api/reading/file?path=${path}`)).statusCode,
      ).toBe(400);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
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
