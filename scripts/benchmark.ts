import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/server/src/store.js";
const QUESTION_COUNT = Number(process.argv[2] || 10000),
  FILE_BATCH = 100;
const directory = await mkdtemp(join(tmpdir(), "study-benchmark-"));
const store = new Store(join(directory, "study.sqlite"));
try {
  const library = store.createLibrary("Synthetic benchmark");
  const files = Array.from(
    { length: Math.ceil(QUESTION_COUNT / FILE_BATCH) },
    (_, file) => ({
      path: `chapter-${file}.md`,
      content:
        "# Chapter " +
        file +
        "\n" +
        Array.from(
          { length: Math.min(FILE_BATCH, QUESTION_COUNT - file * FILE_BATCH) },
          (_, i) =>
            `\n## Question ${i + 1}\nWhat is the value for synthetic bond ${file * FILE_BATCH + i}?\n### Choices\nA. One\nB. Two\nC. Three\n### Answer\nB\n### Solution\nA synthetic fixture explanation.\n`,
        ).join(""),
    }),
  );
  const started = performance.now();
  const preview = store.preview(library.id, files);
  store.commit(library.id, preview.id, true);
  const importMs = performance.now() - started;
  const latencies = Array.from({ length: 100 }, () => {
    const start = performance.now();
    store.search(library.id, "synthetic bond");
    return performance.now() - start;
  }).sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        questions: QUESTION_COUNT,
        importMs: Math.round(importMs),
        searchP95Ms: Math.round(latencies[94] * 100) / 100,
        peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
      },
      null,
      2,
    ),
  );
} finally {
  store.db.close();
  await rm(directory, { recursive: true, force: true });
}
