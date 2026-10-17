/**
 * List likely duplicate questions in a bank folder, for an AI or a person to review.
 *
 * Usage: npm run find-duplicates -- <bank-folder> [--threshold 0.9] [--out report.md]
 *
 * Questions are read with the app's own parser and compared only within the same topic
 * (first folder under <bank-folder>). The stem plus choices decide the kind of match; when
 * either question belongs to a case, the two case passages must also be similar (same
 * Jaccard threshold), because one stem over different exhibit data is a different
 * question. Questions of the same case are never compared with each other. Kinds:
 *
 *   same text      : identical after lower-casing and stripping Markdown/LaTeX markup.
 *   numbers differ : identical once every number is replaced by "#".
 *   similar        : Jaccard similarity of word sets (numbers masked) >= threshold, where
 *                    Jaccard(A, B) = |A ∩ B| / |A ∪ B|, from 0 (no shared words) to 1.
 *
 * Matches are joined into groups (if A~B and B~C, one group A, B, C). The report lists
 * each group with file:line, whether each copy has a key (and whether AI wrote it) and a
 * solution, so a reviewer can keep the best copy. Nothing is changed in the bank.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  parseQuestions,
  type ParsedQuestion,
} from "../packages/domain/src/index.js";

const DEFAULT_THRESHOLD = 0.9;
const PREVIEW_CHARACTERS = 110;
/** Word sets smaller than this are too short to call "similar" without being identical. */
const MIN_WORDS_FOR_SIMILAR = 8;

type Entry = ParsedQuestion & {
  path: string;
  topic: string;
  /** Normalized stem + choices; `masked` replaces numbers with "#"; `words` is its word set. */
  text: string;
  masked: string;
  words: Set<string>;
  /** Word set of the normalized, number-masked case passage (empty for standalone questions). */
  caseWords: Set<string>;
};

/** Jaccard(A, B) = |A ∩ B| / |A ∪ B|; 1 when both sets are empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}
const maskNumbers = (text: string) => text.replace(/\d+(\.\d+)?/g, "#");
const wordSet = (text: string) => new Set(text.split(" ").filter(Boolean));

/** Lower-case text with Markdown/LaTeX markup removed, so formatting changes do not matter. */
function normalize(markdown: string): string {
  return markdown
    .toLowerCase()
    .replace(/\\(mathrm|text|textbf|mathbf|operatorname)\{([^}]*)\}/g, "$2")
    .replace(/\\[a-z]+/g, " ")
    .replace(/[{}$*_`|>#\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bankFiles(folder: string): string[] {
  const files: string[] = [];
  const visit = (path: string) => {
    if (statSync(path).isDirectory())
      readdirSync(path).forEach((name) => visit(join(path, name)));
    else if (path.endsWith(".md")) files.push(path);
  };
  visit(folder);
  return files.sort();
}

const args = process.argv.slice(2);
const folder = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
if (!folder) {
  console.error(
    "Usage: npm run find-duplicates -- <bank-folder> [--threshold 0.9] [--out report.md]",
  );
  process.exit(2);
}
const option = (name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const threshold = Number(option("--threshold") ?? DEFAULT_THRESHOLD);
const outPath = option("--out");

// Parse every bank file into entries: one per question, with comparison keys attached.
const entries: Entry[] = [];
for (const file of bankFiles(folder)) {
  const path = relative(folder, file);
  const parts = path.split("/");
  for (const q of parseQuestions(readFileSync(file, "utf8"), path).questions) {
    const text = normalize(
      `${q.stem} ${q.choices.map((c) => c.text).join(" ")}`,
    );
    const masked = maskNumbers(text);
    entries.push({
      ...q,
      path,
      topic: parts.length > 1 ? parts[0] : "",
      text,
      masked,
      words: wordSet(masked),
      caseWords: wordSet(maskNumbers(normalize(q.caseText))),
    });
  }
}

// Pairwise comparison within each topic; union-find joins matches into groups.
const parent = entries.map((_, index) => index);
const root = (i: number): number =>
  parent[i] === i ? i : (parent[i] = root(parent[i]));
const kindOf = new Map<number, Set<string>>();
for (let a = 0; a < entries.length; a++)
  for (let b = a + 1; b < entries.length; b++) {
    const x = entries[a],
      y = entries[b];
    if (x.topic !== y.topic) continue;
    if (x.caseTitle && x.path === y.path && x.caseTitle === y.caseTitle)
      continue;
    if (jaccard(x.caseWords, y.caseWords) < threshold) continue;
    let kind = "";
    if (x.text === y.text) kind = "same text";
    else if (x.masked === y.masked) kind = "numbers differ";
    else if (Math.min(x.words.size, y.words.size) >= MIN_WORDS_FOR_SIMILAR) {
      const score = jaccard(x.words, y.words);
      if (score >= threshold) kind = `similar ${score.toFixed(2)}`;
    }
    if (!kind) continue;
    parent[root(b)] = root(a);
    for (const index of [a, b])
      kindOf.set(index, (kindOf.get(index) ?? new Set()).add(kind));
  }
const groups = new Map<number, number[]>();
for (const index of kindOf.keys())
  groups.set(root(index), [...(groups.get(root(index)) ?? []), index]);

const lines = [
  `# Duplicate candidates`,
  ``,
  `${entries.length} questions scanned in ${folder}; ${groups.size} groups (threshold ${threshold}).`,
  ``,
];
let groupNumber = 0;
for (const members of groups.values()) {
  groupNumber++;
  const kinds = [
    ...new Set(members.flatMap((index) => [...kindOf.get(index)!])),
  ].join(", ");
  lines.push(
    `## Group ${groupNumber} · ${kinds}`,
    ``,
    `| Question | File:line | Key | Solution | Stem |`,
    `|---|---|---|---|---|`,
  );
  for (const index of members) {
    const q = entries[index];
    const key = q.answerKey
      ? `${q.answerKey}${q.answerByAI ? " (AI)" : ""}`
      : "none";
    const preview = q.stem
      .replace(/\s+/g, " ")
      .replace(/\|/g, "\\|")
      .slice(0, PREVIEW_CHARACTERS);
    lines.push(
      `| ${q.title} | ${q.path}:${q.line} | ${key} | ${q.solution ? "yes" : "no"} | ${preview} |`,
    );
  }
  lines.push(``);
}
const report = lines.join("\n");
if (outPath) {
  writeFileSync(outPath, report);
  console.log(`${groups.size} duplicate groups written to ${outPath}`);
} else console.log(report);
