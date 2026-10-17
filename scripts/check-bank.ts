/**
 * Check prepared question-bank Markdown with the same parser the app uses on import.
 *
 * Usage: npm run check-bank -- <file-or-folder> [...more]
 *
 * Folders are searched recursively for `.md` files; README.md files are skipped because
 * they describe a bank rather than hold questions. For each file it prints question,
 * keyed, solution, chapter and case counts, then every parser issue plus two checks the
 * importer does not make (warnings only): duplicate question titles in one file and
 * questions outside a chapter. Exit status is 1 when any file has an error, so an AI
 * extraction loop can stop on it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseQuestions } from "../packages/domain/src/index.js";

const SKIPPED_FILE_NAMES = new Set(["readme.md"]);

/** Expand the command-line paths into a sorted list of Markdown files. */
function markdownFiles(paths: string[]): string[] {
  const files: string[] = [];
  const visit = (path: string) => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (
      path.toLowerCase().endsWith(".md") &&
      !SKIPPED_FILE_NAMES.has(path.split("/").pop()!.toLowerCase())
    ) {
      files.push(path);
    }
  };
  paths.forEach(visit);
  return files.sort();
}

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error("Usage: npm run check-bank -- <file-or-folder> [...more]");
  process.exit(2);
}

let errorCount = 0;
const totals = { questions: 0, keyed: 0 };
for (const file of markdownFiles(inputs)) {
  const { questions, issues } = parseQuestions(
    readFileSync(file, "utf8"),
    file,
  );
  // Extra checks: titles are the question IDs, so a repeat means a copy/paste or ID slip.
  const seenTitles = new Map<string, number>();
  for (const question of questions) {
    const firstLine = seenTitles.get(question.title);
    if (firstLine !== undefined)
      issues.push({
        path: file,
        line: question.line,
        severity: "warning",
        message: `${question.title}: duplicate title (first at line ${firstLine}).`,
      });
    else seenTitles.set(question.title, question.line);
    if (!question.chapter)
      issues.push({
        path: file,
        line: question.line,
        severity: "warning",
        message: `${question.title}: not under a Chapter heading.`,
      });
  }
  const keyed = questions.filter((q) => q.answerKey).length;
  const aiKeyed = questions.filter((q) => q.answerByAI).length;
  const withSolution = questions.filter((q) => q.solution).length;
  const chapters = new Set(questions.map((q) => q.chapter)).size;
  const cases = new Set(
    questions.filter((q) => q.caseTitle).map((q) => q.caseTitle),
  ).size;
  totals.questions += questions.length;
  totals.keyed += keyed;
  console.log(
    `${relative(process.cwd(), file)}: ${questions.length} questions, ${keyed} keyed ` +
      `(${aiKeyed} by AI), ` +
      `${withSolution} with solution, ${chapters} chapters, ${cases} cases`,
  );
  for (const issue of issues.sort((a, b) => a.line - b.line)) {
    if (issue.severity === "error") errorCount++;
    console.log(
      `  ${issue.severity.toUpperCase()} line ${issue.line}: ${issue.message}`,
    );
  }
}
console.log(
  `Total: ${totals.questions} questions, ${totals.keyed} keyed, ${errorCount} errors`,
);
process.exit(errorCount ? 1 : 0);
