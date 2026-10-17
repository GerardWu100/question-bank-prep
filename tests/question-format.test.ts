import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseQuestions } from "../packages/domain/src/index.js";
import { Store } from "../apps/server/src/store.js";

const examples = join(dirname(fileURLToPath(import.meta.url)), "../examples");
const example = (name: string) => readFileSync(join(examples, name), "utf8");
const question = (title: string, body: string) =>
  `## ${title}\nStem\n### Choices\nA. one\nB. two\nC. three\n${body}`;

describe("documented examples", () => {
  it("parses the basic bank with chapters, answer variants and no issues", () => {
    const { questions, issues } = parseQuestions(example("basic-bank.md"));
    expect(issues).toEqual([]);
    expect(questions.map((q) => [q.chapter, q.title, q.answerKey])).toEqual([
      ["Chapter 1 Time Value of Money", "Question 1", "B"],
      ["Chapter 1 Time Value of Money", "Question 2", "C"],
      ["Chapter 2 Statistics", "Question 1", "B"],
      ["Chapter 2 Statistics", "Question 2", "C"],
    ]);
    expect(questions[3].solution).toContain("Standard deviation");
  });
  it("keeps the exhibit in the case passage and ends the case at its own level", () => {
    const { questions, issues } = parseQuestions(example("case-bank.md"));
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(questions).toHaveLength(3);
    expect(questions[0].caseText).toContain("| Required return $r$ | 8% |");
    expect(questions[1].caseTitle).toBe("Case Maple Leaf Utilities");
    expect(questions[2]).toMatchObject({ caseTitle: "", caseText: "" });
  });
  it("rejects the lecture note as a question bank", () => {
    expect(parseQuestions(example("lecture-note.md")).questions).toEqual([]);
  });
});

describe("parser edge cases", () => {
  it("ends a case at a shallower or same-level non-question heading", () => {
    const { questions } = parseQuestions(
      `# Chapter 1\n## Case Alpha\nPassage.\n### Question 1\nS\n#### Choices\nA. x\nB. y\n#### Answer\nA\n## Practice\n### Question 2\nS\n#### Choices\nA. x\nB. y\n#### Answer\nB\n`,
    );
    expect(questions[0].caseText).toBe("Passage.");
    expect(questions[1].caseTitle).toBe("");
  });
  it("stops a solution at the next sibling section", () => {
    const [parsed] = parseQuestions(
      question("Question 1", "### Solution\nBecause.\n### Answer\nB\n"),
    ).questions;
    expect(parsed).toMatchObject({ solution: "Because.", answerKey: "B" });
  });
  it("accepts common answer spellings but not ambiguous ones", () => {
    for (const answer of ["b", "(B)", "B. two", "B\n\nTwo is right.", "**Answer:** B"])
      expect(
        parseQuestions(question("Question 1", `### Answer\n${answer}\n`))
          .questions[0].answerKey,
        answer,
      ).toBe("B");
    expect(
      parseQuestions(question("Question 1", "### Answer\nA or B\n"))
        .questions[0].answerKey,
    ).toBeNull();
  });
  it("reports a choice label beyond the configured set instead of merging it", () => {
    const { questions, issues } = parseQuestions(
      `## Question 1\nS\n### Choices\nA. a\nB. b\nC. c\nD. d\nE. e\nF. f\n### Answer\nF\n`,
    );
    expect(issues.some((issue) => issue.message.includes("choice F"))).toBe(true);
    expect(questions[0].answerKey).toBeNull();
  });
  it("uses only the text line of a setext heading as its title", () => {
    const { questions } = parseQuestions(
      `Question 1\n==========\nS\n\nChoices\n-------\nA. a\nB. b\n`,
    );
    expect(questions[0].title).toBe("Question 1");
  });
});

describe("re-import identity", () => {
  const bank = (stem2 = "Second") =>
    `# Chapter 1\n${question("Question 1", "### Answer\nA\n").replace("Stem", "First")}\n${question("Question 2", "### Answer\nB\n").replace("Stem", stem2)}\n`;
  const setup = () => {
    const store = new Store(":memory:");
    const libraryId = store.createLibrary("Test").id;
    const importFiles = (files: { path: string; content: string }[]) =>
      store.commit(libraryId, store.preview(libraryId, files).id, true);
    return { store, libraryId, importFiles };
  };
  it("restores a removed file when the same content is imported again", () => {
    const { store, libraryId, importFiles } = setup();
    importFiles([{ path: "bank.md", content: bank() }]);
    store.deactivateFile(libraryId, store.list(libraryId, "file")[0]);
    store.bumpGeneration(libraryId);
    expect(importFiles([{ path: "bank.md", content: bank() }]).questions).toBe(2);
  });
  it("keeps unchanged questions on their content version and proposes them automatically", () => {
    const { store, libraryId, importFiles } = setup();
    importFiles([{ path: "bank.md", content: bank() }]);
    const preview = store.preview(libraryId, [
      { path: "bank.md", content: bank("Second, edited") },
    ]);
    expect(preview.identityProposals[0].automatic).not.toBeNull();
    expect(preview.identityProposals[1].automatic).toBeNull();
    store.commit(libraryId, preview.id, true);
    const byStem = Object.fromEntries(
      store
        .list(libraryId, "question")
        .filter((q) => q.active)
        .map((q) => [q.stem, q.contentVersion]),
    );
    expect(byStem).toEqual({ First: 1, "Second, edited": 1 });
  });
  it("orders source sets by file path, then position in the file", () => {
    const { store, libraryId, importFiles } = setup();
    importFiles([{ path: "b.md", content: bank() }]);
    importFiles([{ path: "a.md", content: bank("Other") }]);
    const ids = store.select(libraryId, { order: "source" });
    const paths = new Map(
      store.list(libraryId, "file").map((file) => [file.id, file.path]),
    );
    expect(
      ids.map((id) => {
        const q = store.get(libraryId, id, "question");
        return `${paths.get(q.fileId)}:${q.title}`;
      }),
    ).toEqual(["a.md:Question 1", "a.md:Question 2", "b.md:Question 1", "b.md:Question 2"]);
  });
});
