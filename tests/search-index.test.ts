import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/server/src/store.js";

const bank = (answer: string) =>
  `## Question 1\nWhich bond has convexity?\n### Choices\nA. One\nB. Two\n### Answer\n${answer}\n`;

test("an old search index is rebuilt by rowid, and edits keep one entry per question", async () => {
  const directory = await mkdtemp(join(tmpdir(), "study-search-"));
  const path = join(directory, "study.sqlite");
  try {
    let store = new Store(path);
    const library = store.createLibrary("Search");
    store.commit(
      library.id,
      store.preview(library.id, [{ path: "bank.md", content: bank("A") }]).id,
      true,
    );
    // Rewrite the index the old way: entries with rowids unrelated to their records.
    store.db.exec(
      "CREATE TEMP TABLE copy AS SELECT id,library_id,kind,title,text FROM search_index; DELETE FROM search_index; INSERT INTO search_index(rowid,id,library_id,kind,title,text) SELECT rowid+1000,* FROM copy",
    );
    store.db.close();
    store = new Store(path);
    const misaligned = store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM search_index s LEFT JOIN records r ON r.rowid=s.rowid WHERE r.id IS NOT s.id",
      )
      .get() as { n: number };
    expect(misaligned.n).toBe(0);
    expect(store.search(library.id, "convexity")).toHaveLength(1);
    store.commit(
      library.id,
      store.preview(library.id, [{ path: "bank.md", content: bank("B") }]).id,
      true,
    );
    expect(store.search(library.id, "convexity")).toHaveLength(1);
    store.db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
