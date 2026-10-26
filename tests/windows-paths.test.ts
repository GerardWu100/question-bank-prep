import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Simulate Windows: relative() answers with "\" separators, as node:path does there.
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    sep: "\\",
    relative: (from: string, to: string) =>
      posix.relative(from, to).split("/").join("\\"),
  };
});

const { scanRoot } = await import("../apps/server/src/material-files.js");
const { listReadingFiles } = await import(
  "../apps/server/src/reading-routes.js"
);

let scratch = "";
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

describe("Windows folder paths", () => {
  it("are stored and listed with / so banks group by topic and notes form a tree", async () => {
    scratch = mkdtempSync(join(tmpdir(), "windows-paths-"));
    mkdirSync(join(scratch, "01 Quantitative Methods"), { recursive: true });
    writeFileSync(
      join(scratch, "01 Quantitative Methods", "Qbank 2025.md"),
      "# Notes\n",
    );
    expect((await scanRoot(scratch)).map((file) => file.path)).toEqual([
      "01 Quantitative Methods/Qbank 2025.md",
    ]);
    expect(await listReadingFiles(scratch)).toEqual([
      "01 Quantitative Methods/Qbank 2025.md",
    ]);
  });
});
