import { createHash } from "node:crypto";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export type Choice = { label: string; text: string };
export type ParsedQuestion = {
  title: string;
  chapter: string;
  caseText: string;
  caseTitle: string;
  stem: string;
  choices: Choice[];
  answerKey: string | null;
  /** True when the key sits under "Answer (AI)": written by AI, not given by the source. */
  answerByAI: boolean;
  solution: string;
  line: number;
  fingerprint: string;
};
export type ImportIssue = {
  path: string;
  line: number;
  message: string;
  severity: "warning" | "error";
};
/** Largest Markdown source accepted, in bytes. */
export const MAX_MATERIAL_BYTES = 5_000_000;
export const GRADE_STATUSES = [
  "unanswered",
  "wrong",
  "unsure",
  "correct",
  "ungradable",
] as const;
/** Grades that put a question on the review list. */
export const needsReview = (status: string) =>
  status === "wrong" || status === "unsure";
/** Return why a material path or content is unacceptable, or null when valid. */
export function validateMaterialFile(
  path: unknown,
  content: unknown,
): string | null {
  if (
    typeof path !== "string" ||
    /^([\\/]|[A-Za-z]:)/.test(path) ||
    path.split(/[\\/]/).some((part) => part === ".." || part === "") ||
    !/\.md$/i.test(path)
  )
    return "Use a relative .md path without empty or .. segments.";
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content) > MAX_MATERIAL_BYTES
  )
    return "Material must be text under 5 MB.";
  return null;
}
/** Return why choice labels are unusable, or null when valid. */
export function validateChoiceLabels(labels: unknown): string | null {
  return Array.isArray(labels) &&
    labels.length >= 2 &&
    labels.length <= 26 &&
    new Set(labels).size === labels.length &&
    labels.every(
      (label) => typeof label === "string" && /^[A-Za-z0-9]{1,8}$/.test(label),
    )
    ? null
    : "Use 2–26 distinct alphanumeric choice labels, each at most eight characters.";
}
export const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
export function grade(
  selection: string | null,
  key: string | null,
  confidence: string | null,
) {
  if (!key) return "ungradable";
  if (!selection) return "unanswered";
  return selection !== key
    ? "wrong"
    : confidence === "unsure"
      ? "unsure"
      : "correct";
}
/** Grade a stored question from its overall latest answer. */
export const questionStatus = (question: {
  answerKey: string | null;
  state: { selection: string | null; confidence: string | null };
}) =>
  grade(
    question.state.selection,
    question.answerKey,
    question.state.confidence,
  );
export function normalizeConfidence(
  selection: string | null,
  key: string | null,
  confidence: string | null,
) {
  return selection && key && selection === key
    ? confidence === "unsure"
      ? "unsure"
      : "sure"
    : null;
}
/** One frozen Markdown parser shared by every call; building it per file repeats plugin setup. */
const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .freeze();
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const QUESTION_HEADING = /^question\s+\S/i;
const CASE_HEADING = /^(case|vignette)\b/i;
const CHAPTER_HEADING = /^chapter\b/i;
const CHOICES_HEADING = /^choices?$/i;
const ANSWER_HEADING = /^(answer|answer key|correct answer)( \(ai\))?$/i;
const AI_ANSWER_HEADING = /\(ai\)$/i;
const SOLUTION_HEADING = /^(solution|explanation)$/i;

/**
 * Parse a Markdown question bank into questions.
 *
 * Structure (see docs/user/question-format.md):
 *   Chapter heading  -> sets `chapter` for following questions; clears any case.
 *   Case/Vignette    -> shared passage (`caseText`) for the deeper Question headings
 *                       below it. The passage runs to the first Question heading, so
 *                       exhibits under deeper headings stay in it. The case ends at
 *                       the next heading of the same or shallower depth.
 *   Question heading -> one question; its sub-headings Choices, Answer, Solution.
 *
 * Only real headings count, so fenced examples cannot create questions.
 * Original source slices are kept, which preserves math and multiline choices.
 *
 * Parameters
 * ----------
 * content : Markdown text.
 * path : source path, used only in issue reports.
 * labels : allowed choice labels, in display order. The default, A to Z, takes letters
 *     only in order (A, B, C, ...), so a question may have any number of choices up to 26.
 *
 * Returns
 * -------
 * questions : parsed questions in source order.
 * issues : errors block an import; warnings mark ungradable or doubtful questions.
 */
/** Choice labels when a library sets none: the letters A to Z, used in order. */
export const DEFAULT_CHOICE_LABELS = Array.from({ length: 26 }, (_, index) =>
  String.fromCharCode(65 + index),
);
/** Keep choice matches whose letter is not past the next expected one (A, then B, ...). */
function inLetterOrder(matches: RegExpMatchArray[]) {
  let next = 0;
  return matches.filter((match) => {
    if (match[1] > String.fromCharCode(65 + next)) return false;
    next++;
    return true;
  });
}
export function parseQuestions(
  content: string,
  path = "",
  labels = DEFAULT_CHOICE_LABELS,
): { questions: ParsedQuestion[]; issues: ImportIssue[] } {
  const tree: any = markdownParser.parse(content);
  // Top-level heading nodes in source order, as { title, depth, start, end, line }.
  const headings = (tree.children as any[])
    .filter((node) => node.type === "heading")
    .map((node) => ({
      // The first line drops a setext underline ("Title\n=====").
      title: content
        .slice(node.position.start.offset, node.position.end.offset)
        .split(/\r?\n/)[0]
        .replace(/^#+\s*/, "")
        .replace(/\s*#+\s*$/, "")
        .trim(),
      depth: node.depth as number,
      start: node.position.start.offset as number,
      end: node.position.end.offset as number,
      line: node.position.start.line as number,
    }));
  const labelPattern = labels.map(escapeRegExp).join("|");
  const choicePattern = new RegExp(
    `^(?:[-*+]\\s+)?(?:\\*\\*)?(${labelPattern})(?:[.)]|:)(?:\\*\\*)?\\s+`,
    "gm",
  );
  // "B", "B.", "B)", "(B)", "Answer: B", "B. Four"; not "A or B".
  const answerPattern = new RegExp(
    `^(?:answer\\s*:\\s*)?\\(?(${labelPattern})(?:\\)|[.):](?:\\s+.*)?)?$`,
    "i",
  );
  // With letter labels A..E, a choice line "F." means the bank needs more labels.
  const nextLetter = labels.every((label) => /^[A-Z]$/.test(label))
    ? String.fromCharCode(
        Math.max(...labels.map((label) => label.charCodeAt(0))) + 1,
      )
    : null;
  const extraChoicePattern =
    nextLetter && nextLetter <= "Z"
      ? new RegExp(`^(?:[-*+]\\s+)?(?:\\*\\*)?${nextLetter}(?:[.)]|:)\\s`, "m")
      : null;
  const questions: ParsedQuestion[] = [],
    issues: ImportIssue[] = [];
  let chapter = "",
    caseTitle = "",
    caseText = "",
    caseDepth = 0;
  for (let h = 0; h < headings.length; h++) {
    const heading = headings[h];
    const isQuestion = QUESTION_HEADING.test(heading.title);
    if (CHAPTER_HEADING.test(heading.title)) {
      chapter = heading.title;
      caseTitle = caseText = "";
      caseDepth = 0;
    } else if (CASE_HEADING.test(heading.title)) {
      caseTitle = heading.title;
      caseDepth = heading.depth;
      const caseEnd = headings.find(
        (next, index) =>
          index > h &&
          (QUESTION_HEADING.test(next.title) || next.depth <= heading.depth),
      );
      caseText = content
        .slice(heading.end, caseEnd?.start ?? content.length)
        .trim();
    } else if (caseDepth && heading.depth <= caseDepth) {
      caseTitle = caseText = "";
      caseDepth = 0;
    }
    if (!isQuestion) continue;
    // Headings are sorted by offset: the question ends at the next heading at its depth or shallower.
    let endIndex = h + 1;
    while (
      endIndex < headings.length &&
      headings[endIndex].depth > heading.depth
    )
      endIndex++;
    const end = headings[endIndex]?.start ?? content.length;
    const sub = headings.slice(h + 1, endIndex);
    const choiceHeading = sub.find((next) => CHOICES_HEADING.test(next.title));
    const answerHeading = sub.find((next) => ANSWER_HEADING.test(next.title));
    const solutionHeading = sub.find((next) =>
      SOLUTION_HEADING.test(next.title),
    );
    // A section ends at the next sub-heading of the same or shallower depth.
    const sectionEnd = (section: (typeof sub)[number]) =>
      sub.find(
        (next) => next.start > section.start && next.depth <= section.depth,
      )?.start ?? end;
    const stemEnd = Math.min(
      choiceHeading?.start ?? end,
      answerHeading?.start ?? end,
      solutionHeading?.start ?? end,
    );
    let stem = content.slice(heading.end, stemEnd).trim();
    const choiceStart = choiceHeading?.end ?? heading.end;
    const choiceEnd = Math.min(
      ...[answerHeading?.start, solutionHeading?.start, end].filter(
        (x): x is number => x !== undefined && x > choiceStart,
      ),
    );
    const choiceBody = content.slice(choiceStart, choiceEnd);
    // With the default A–Z labels a choice must be the next letter: a line such as
    // "I. Only statement one" inside choice C stays part of C. A repeated earlier letter is
    // kept, so it is still reported as a duplicate label.
    const allMatches = [...choiceBody.matchAll(choicePattern)];
    const matches =
      labels === DEFAULT_CHOICE_LABELS ? inLetterOrder(allMatches) : allMatches;
    const choices = matches.map((match, index) => ({
      label: match[1],
      text: choiceBody
        .slice(
          match.index! + match[0].length,
          matches[index + 1]?.index ?? choiceBody.length,
        )
        .trim(),
    }));
    if (!choiceHeading && matches.length)
      stem = choiceBody.slice(0, matches[0].index).trim();
    const answerLine = answerHeading
      ? (content
          .slice(answerHeading.end, sectionEnd(answerHeading))
          .replace(/\*\*/g, "")
          .split(/\r?\n/)
          .find((line) => line.trim()) ?? "")
      : "";
    const answerMatch = answerLine.trim().match(answerPattern);
    const answerLabel = answerMatch
      ? (labels.find((label) => label === answerMatch[1]) ??
        labels.find(
          (label) => label.toLowerCase() === answerMatch[1].toLowerCase(),
        ))
      : undefined;
    const answerKey =
      answerLabel && choices.some((c) => c.label === answerLabel)
        ? answerLabel
        : null;
    const solution = solutionHeading
      ? content.slice(solutionHeading.end, sectionEnd(solutionHeading)).trim()
      : "";
    if (
      choices.length < 2 ||
      new Set(choices.map((c) => c.label)).size !== choices.length
    )
      issues.push({
        path,
        line: heading.line,
        severity: "error",
        message: `${heading.title}: expected at least two uniquely labeled choices (A., B., C.).`,
      });
    if (extraChoicePattern?.test(choiceBody))
      issues.push({
        path,
        line: choiceHeading?.line ?? heading.line,
        severity: "error",
        message: `${heading.title}: choice ${nextLetter} is not a configured label. Add it under Settings → choice labels.`,
      });
    if (!answerKey)
      issues.push({
        path,
        line: answerHeading?.line ?? heading.line,
        severity: "warning",
        message: `${heading.title}: missing or ambiguous answer key; grade unavailable.`,
      });
    const fingerprint = hash(
      JSON.stringify([
        caseText.replace(/\s+/g, " "),
        stem.replace(/\s+/g, " "),
        choices.map((c) => [c.label, c.text.replace(/\s+/g, " ")]),
      ]),
    );
    questions.push({
      title: heading.title,
      chapter,
      caseTitle,
      caseText,
      stem,
      choices,
      answerKey,
      answerByAI: Boolean(
        answerKey &&
        answerHeading &&
        AI_ANSWER_HEADING.test(answerHeading.title),
      ),
      solution,
      line: heading.line,
      fingerprint,
    });
  }
  if (!questions.length)
    issues.push({
      path,
      line: 1,
      severity: "error",
      message: "No Question headings found. Import lecture material as a note.",
    });
  return { questions, issues };
}
