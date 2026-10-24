import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../apps/server/src/app.js";

/** One question block: title, stem and choices; the key and solution never affect matching. */
const question = (title: string, stem: string, choices = "A. Yes\nB. No") =>
  `### ${title}\n${stem}\n#### Choices\n${choices}\n#### Answer\nA\n#### Solution\nBecause.\n`;
const apps: Awaited<ReturnType<typeof buildApp>>["app"][] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** A library holding `files`, driven through the real routes. */
async function libraryWith(files: { path: string; content: string }[]) {
  const { app, store } = await buildApp();
  apps.push(app);
  const library = store.createLibrary("Study");
  store.commit(library.id, store.preview(library.id, files).id, true);
  const base = `/api/libraries/${library.id}`;
  let operations = 0;
  /** The active question at path / chapter / case / title. */
  const at = (path: string, chapter: string, title: string, caseTitle = "") => {
    const fileId = store.list(library.id, "file", ["content"]).find((f) => f.path === path)!.id;
    const matches = store
      .list(library.id, "question")
      .filter((q) => q.active && q.fileId === fileId && q.chapter === chapter && q.caseTitle === caseTitle && q.title === title);
    expect(matches).toHaveLength(1);
    return matches[0];
  };
  const answer = async (q: any, selection: string) =>
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base}/questions/${q.id}/answer`,
          payload: { operationId: `answer-${++operations}`, expectedVersion: q.state.version, selection, confidence: "sure" },
        })
      ).statusCode,
    ).toBe(200);
  const annotate = async (q: any, flagged: boolean, note: string) =>
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `${base}/questions/${q.id}/annotation`,
          payload: { operationId: `annotate-${++operations}`, expectedVersion: q.annotation.version, flagged, note },
        })
      ).statusCode,
    ).toBe(200);
  const exportStudyData = async () => (await app.inject({ url: `${base}/export/study-data` })).body;
  const importStudyData = async (content: string) => {
    const response = await app.inject({
      method: "POST",
      url: `${base}/import/study-data`,
      payload: { operationId: `import-${++operations}`, content },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  return { at, answer, annotate, exportStudyData, importStudyData };
}

/** The same export as an app version that wrote no path, chapter or case title. */
function withoutLocation(exported: string) {
  const data = JSON.parse(exported);
  for (const entry of data.questions) {
    delete entry.path;
    delete entry.chapter;
    delete entry.caseTitle;
  }
  return JSON.stringify(data);
}

const untouched = { selection: null, version: 0 };

describe("study-data import identity", () => {
  it("puts repeated question numbers across chapters on their own questions", async () => {
    const files = [
      { path: "quant/drills.md", content: `# Chapter 1\n${question("Question 1", "First stem?")}# Chapter 2\n${question("Question 1", "Second stem?")}` },
    ];
    const source = await libraryWith(files);
    await source.answer(source.at("quant/drills.md", "Chapter 1", "Question 1"), "A");
    await source.annotate(source.at("quant/drills.md", "Chapter 1", "Question 1"), false, "first note");
    await source.answer(source.at("quant/drills.md", "Chapter 2", "Question 1"), "B");
    await source.annotate(source.at("quant/drills.md", "Chapter 2", "Question 1"), true, "");
    const exported = await source.exportStudyData();
    expect(JSON.parse(exported).questions[0]).toMatchObject({ path: "quant/drills.md", chapter: "Chapter 1", caseTitle: "" });

    // An export without location fields still works here: the fingerprints differ.
    for (const content of [exported, withoutLocation(exported)]) {
      const target = await libraryWith(files);
      expect(await target.importStudyData(content)).toMatchObject({ answers: 2, annotations: 2, unmatched: [], ambiguous: [] });
      const [first, second] = [target.at("quant/drills.md", "Chapter 1", "Question 1"), target.at("quant/drills.md", "Chapter 2", "Question 1")];
      expect(first.state).toMatchObject({ selection: "A", version: 1 });
      expect(first.annotation).toMatchObject({ flagged: false, note: "first note", version: 1 });
      expect(second.state).toMatchObject({ selection: "B", version: 1 });
      expect(second.annotation).toMatchObject({ flagged: true, note: "", version: 1 });
    }
  });

  it("tells identical questions apart by chapter and case title, and leaves legacy ambiguity alone", async () => {
    const shared = question("Question 1", "Same stem?");
    const content =
      `# Chapter 1\n## Case Alpha\nShared passage.\n${shared}## Case Beta\nShared passage.\n${shared}` +
      `# Chapter 2\n${shared}# Chapter 3\n${shared}`;
    const files = [{ path: "quant/cases.md", content }];
    const places: [string, string, string][] = [
      ["Chapter 1", "Case Alpha", "A"],
      ["Chapter 1", "Case Beta", "B"],
      ["Chapter 2", "", "A"],
      ["Chapter 3", "", "B"],
    ];
    const source = await libraryWith(files);
    for (const [chapter, caseTitle, selection] of places)
      await source.answer(source.at("quant/cases.md", chapter, "Question 1", caseTitle), selection);
    const exported = await source.exportStudyData();

    const target = await libraryWith(files);
    expect(await target.importStudyData(exported)).toMatchObject({ answers: 4, unmatched: [], ambiguous: [] });
    for (const [chapter, caseTitle, selection] of places)
      expect(target.at("quant/cases.md", chapter, "Question 1", caseTitle).state).toMatchObject({ selection, version: 1 });

    // Without chapter and case title, each pair shares content and number: nothing is guessed.
    const legacy = await libraryWith(files);
    const summary = await legacy.importStudyData(withoutLocation(exported));
    expect(summary).toMatchObject({ answers: 0, annotations: 0, unmatched: [] });
    expect(summary.ambiguous).toHaveLength(4);
    for (const [chapter, caseTitle] of places)
      expect(legacy.at("quant/cases.md", chapter, "Question 1", caseTitle).state).toMatchObject(untouched);
  });

  it("tells nested files that share a basename apart by full path", async () => {
    const content = `# Chapter 1\n${question("Question 1", "Same stem?")}`;
    const files = [
      { path: "quant/a/drills.md", content },
      { path: "quant/b/drills.md", content },
    ];
    const source = await libraryWith(files);
    await source.answer(source.at("quant/a/drills.md", "Chapter 1", "Question 1"), "A");
    await source.answer(source.at("quant/b/drills.md", "Chapter 1", "Question 1"), "B");
    await source.annotate(source.at("quant/b/drills.md", "Chapter 1", "Question 1"), true, "b only");
    const exported = await source.exportStudyData();

    const target = await libraryWith(files);
    expect(await target.importStudyData(exported)).toMatchObject({ answers: 2, annotations: 1, ambiguous: [] });
    expect(target.at("quant/a/drills.md", "Chapter 1", "Question 1").state).toMatchObject({ selection: "A" });
    expect(target.at("quant/a/drills.md", "Chapter 1", "Question 1").annotation).toMatchObject({ flagged: false, note: "" });
    expect(target.at("quant/b/drills.md", "Chapter 1", "Question 1").state).toMatchObject({ selection: "B" });
    expect(target.at("quant/b/drills.md", "Chapter 1", "Question 1").annotation).toMatchObject({ flagged: true, note: "b only" });

    const legacy = await libraryWith(files);
    expect((await legacy.importStudyData(withoutLocation(exported))).ambiguous).toHaveLength(2);
    expect(legacy.at("quant/a/drills.md", "Chapter 1", "Question 1").state).toMatchObject(untouched);
    expect(legacy.at("quant/b/drills.md", "Chapter 1", "Question 1").annotation.version).toBe(0);
  });

  it("follows a unique fingerprint to a moved, renumbered question, never to a same-title stranger", async () => {
    const source = await libraryWith([{ path: "quant/drills.md", content: `# Chapter 1\n${question("Question 1", "Moving stem?")}` }]);
    await source.answer(source.at("quant/drills.md", "Chapter 1", "Question 1"), "B");
    await source.annotate(source.at("quant/drills.md", "Chapter 1", "Question 1"), true, "keep me");
    const exported = await source.exportStudyData();

    const target = await libraryWith([
      { path: "quant/drills.md", content: `# Chapter 1\n${question("Question 1", "A different stem?")}` },
      { path: "quant/moved.md", content: `# Chapter 4\n${question("Question 7", "Moving stem?")}` },
    ]);
    expect(await target.importStudyData(exported)).toMatchObject({ answers: 1, annotations: 1, unmatched: [], ambiguous: [] });
    expect(target.at("quant/moved.md", "Chapter 4", "Question 7").state).toMatchObject({ selection: "B", version: 1 });
    expect(target.at("quant/moved.md", "Chapter 4", "Question 7").annotation).toMatchObject({ flagged: true, note: "keep me" });
    const stranger = target.at("quant/drills.md", "Chapter 1", "Question 1");
    expect(stranger.state).toMatchObject(untouched);
    expect(stranger.annotation.version).toBe(0);
  });

  it("reports a same-title question whose content or choices changed and leaves it unchanged", async () => {
    const source = await libraryWith([{ path: "quant/drills.md", content: `# Chapter 1\n${question("Question 1", "Original stem?")}` }]);
    await source.answer(source.at("quant/drills.md", "Chapter 1", "Question 1"), "A");
    await source.annotate(source.at("quant/drills.md", "Chapter 1", "Question 1"), true, "old note");
    const exported = await source.exportStudyData();

    for (const changed of [question("Question 1", "Rewritten stem?"), question("Question 1", "Original stem?", "A. Maybe\nB. No")]) {
      const target = await libraryWith([{ path: "quant/drills.md", content: `# Chapter 1\n${changed}` }]);
      const summary = await target.importStudyData(exported);
      expect(summary).toMatchObject({ answers: 0, annotations: 0, ambiguous: [] });
      expect(summary.unmatched).toHaveLength(1);
      const q = target.at("quant/drills.md", "Chapter 1", "Question 1");
      expect(q.state).toMatchObject(untouched);
      expect(q.annotation).toMatchObject({ flagged: false, note: "", version: 0 });
    }
  });

  it("never lets two exported entries write the same question", async () => {
    const content = `# Chapter 1\n${question("Question 1", "Copied stem?")}`;
    const source = await libraryWith([
      { path: "quant/a/drills.md", content },
      { path: "quant/b/drills.md", content },
    ]);
    await source.answer(source.at("quant/a/drills.md", "Chapter 1", "Question 1"), "A");
    await source.answer(source.at("quant/b/drills.md", "Chapter 1", "Question 1"), "B");
    const exported = await source.exportStudyData();

    // Only one copy here: the entry from its own path wins, the other is reported.
    const target = await libraryWith([{ path: "quant/a/drills.md", content }]);
    const summary = await target.importStudyData(exported);
    expect(summary).toMatchObject({ answers: 1, unmatched: [] });
    expect(summary.ambiguous).toEqual(["quant/b/drills.md / Chapter 1 1"]);
    expect(target.at("quant/a/drills.md", "Chapter 1", "Question 1").state).toMatchObject({ selection: "A", version: 1 });

    // Without paths both entries describe that question equally well: neither wins.
    const legacy = await libraryWith([{ path: "quant/a/drills.md", content }]);
    expect((await legacy.importStudyData(withoutLocation(exported))).ambiguous).toHaveLength(2);
    expect(legacy.at("quant/a/drills.md", "Chapter 1", "Question 1").state).toMatchObject(untouched);
  });
});
