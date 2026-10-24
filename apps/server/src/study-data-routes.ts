import type { FastifyInstance } from "fastify";
import { AppError, groupBy, id, Store } from "./store.js";
import { hash, normalizeConfidence } from "../../../packages/domain/src/index.js";

/** `format` value that marks a study-data file written by this app. */
export const STUDY_DATA_FORMAT = "question-bank-prep/study-data";
// Still 1: path, chapter and caseTitle are optional additions that older files lack.
const STUDY_DATA_VERSION = 1;
const MAX_NOTE_TITLE = 200;

/**
 * One question's study state in a study-data file. `fingerprint` (case text, stem and
 * choices) says which content the state belongs to; topic + source + question ID (its
 * title without "Question ") and, in newer files, path, chapter and case title say where
 * it sat, which tells apart questions with the same content or number.
 */
interface QuestionEntry {
  topic: string;
  source: string;
  question: string;
  /** Full bank path, e.g. "quant/a/drills.md"; undefined in files written before it. */
  path?: string;
  /** Chapter and case headings ("" when none); undefined in files written before them. */
  chapter?: string;
  caseTitle?: string;
  fingerprint?: string;
  selection: string | null;
  confidence: string | null;
  /** Answer order in the exporting library; only the relative order is used. */
  answerSequence: number | null;
  flagged: boolean;
  note: string;
}
interface NoteEntry {
  title: string;
  content: string;
  /** "ai" for a saved tutor reply, anything else for the user's own note. */
  provenance: string;
  model?: string;
  provider?: string;
  createdAt?: string;
}
/** What an import changed, shown to the user. */
export interface ImportSummary {
  answers: number;
  annotations: number;
  notes: number;
  unchanged: number;
  /** Question IDs the file names that this library does not have (or whose answer no longer fits). */
  unmatched: string[];
  /** Entries that fit more than one question here, or share one with another entry; left unapplied. */
  ambiguous: string[];
}

const questionId = (title: string) => title.replace(/^Question\s+/i, "");
const questionKey = (topic: string, source: string, question: string) =>
  JSON.stringify([topic, source, question]);
/** Bank path of a question, looked up by its `fileId` (files read without content). */
function filePaths(store: Store, libraryId: string) {
  const pathById = new Map<string, string>(
    store.list(libraryId, "file", ["content"]).map((file) => [file.id, file.path]),
  );
  return (question: any) => pathById.get(question.fileId);
}
/** "quant/drills.md / Chapter 1 1": where an entry sat, for the import summary. */
const entryLabel = (entry: QuestionEntry) =>
  `${[entry.path ?? `${entry.topic}/${entry.source}`, entry.chapter, entry.caseTitle].filter(Boolean).join(" / ")} ${entry.question}`;

/**
 * Pair each exported entry with the one question here that it describes.
 *
 * Content decides when the entry has a fingerprint: only questions with that fingerprint
 * qualify, so a same-numbered question with other content never takes the state, and a
 * unique match wins even after a move or renumbering. When several questions qualify (or
 * the entry has no fingerprint), the entry's location must pick exactly one: its path
 * (else topic and source) and question ID, plus chapter and case title when exported.
 * A question chosen by several entries goes to the one entry at its location, else to none.
 *
 * Parameters
 * ----------
 * entries : exported entries, in any order; the result does not depend on it.
 * questions : this library's active questions (full records).
 * pathOf : bank path of a question, from its `fileId`.
 *
 * Returns
 * -------
 * matched : entry -> its question; every question appears at most once.
 * unmatched : entries with no question of their content (or, without a fingerprint, location).
 * ambiguous : entries left out because the choice was not unique.
 */
function matchEntries(entries: QuestionEntry[], questions: any[], pathOf: (question: any) => string | undefined) {
  const atLocation = (entry: QuestionEntry, q: any) =>
    (entry.path !== undefined ? pathOf(q) === entry.path : q.topic === entry.topic && q.source === entry.source) &&
    questionId(q.title) === entry.question &&
    (entry.chapter === undefined || q.chapter === entry.chapter) &&
    (entry.caseTitle === undefined || q.caseTitle === entry.caseTitle);
  const byFingerprint = groupBy(questions, (q) => q.fingerprint);
  const byKey = groupBy(questions, (q) => questionKey(q.topic, q.source, questionId(q.title)));
  const matched = new Map<QuestionEntry, any>();
  const unmatched: QuestionEntry[] = [];
  const ambiguous: QuestionEntry[] = [];
  for (const entry of entries) {
    const candidates = entry.fingerprint
      ? (byFingerprint.get(entry.fingerprint) ?? [])
      : (byKey.get(questionKey(entry.topic, entry.source, entry.question)) ?? []).filter((q) => atLocation(entry, q));
    const chosen = candidates.length > 1 ? candidates.filter((q) => atLocation(entry, q)) : candidates;
    if (!candidates.length) unmatched.push(entry);
    else if (chosen.length !== 1) ambiguous.push(entry);
    else matched.set(entry, chosen[0]);
  }
  // Two entries for one question (copies of a question in the export): never both write it.
  for (const claims of groupBy([...matched], ([, q]) => q.id).values()) {
    if (claims.length === 1) continue;
    const atOwnLocation = claims.filter(([entry, q]) => atLocation(entry, q));
    for (const [entry] of claims)
      if (atOwnLocation.length !== 1 || atOwnLocation[0][0] !== entry) {
        matched.delete(entry);
        ambiguous.push(entry);
      }
  }
  return { matched, unmatched, ambiguous };
}

/** Turn an uploaded study-data JSON into question and note entries. */
function parseStudyData(content: string): {
  questions: QuestionEntry[];
  notes: NoteEntry[];
} {
  let data: any;
  try {
    data = JSON.parse(content);
  } catch {
    throw new AppError(400, "INVALID_STUDY_DATA", "The file is not valid JSON.");
  }
  if (data?.format !== STUDY_DATA_FORMAT || !Array.isArray(data.questions))
    throw new AppError(400, "INVALID_STUDY_DATA", "This JSON is not a study-data export from this app.");
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  // Absent location fields stay undefined, so they do not narrow a match ("" is "no chapter").
  const optionalText = (value: unknown) => (typeof value === "string" ? value : undefined);
  return {
    questions: data.questions.map((entry: any) => ({
      topic: text(entry.topic),
      source: text(entry.source),
      question: questionId(text(entry.question)),
      path: optionalText(entry.path),
      chapter: optionalText(entry.chapter),
      caseTitle: optionalText(entry.caseTitle),
      fingerprint: text(entry.fingerprint) || undefined,
      selection: text(entry.selection) || null,
      confidence: text(entry.confidence) || null,
      answerSequence: Number.isFinite(entry.answerSequence) ? entry.answerSequence : null,
      flagged: Boolean(entry.flagged),
      note: text(entry.note),
    })),
    notes: (Array.isArray(data.notes) ? data.notes : [])
      .filter((note: any) => typeof note?.content === "string" && note.content.trim())
      .map((note: any) => ({ ...note, title: text(note.title) || "Imported note" })),
  };
}

/**
 * Study-data export and import: answers, confidence, flags, question notes and Notes-page
 * notes, to move study progress between devices or app installs (for example from the
 * server to the desktop app). Question banks themselves are not included: import the same
 * bank first. Chats and saved sets stay behind; sets show imported answers automatically.
 */
export function registerStudyDataRoutes(app: FastifyInstance, store: Store) {
  const base = "/api/libraries/:libraryId";
  app.get(base + "/export/study-data", async (request: any, reply) => {
    const libraryId = request.params.libraryId as string;
    const library = store.library(libraryId);
    const pathOf = filePaths(store, libraryId);
    const questions = store
      .list(libraryId, "question", ["caseText", "choices", "solution", "stem"])
      .filter((q) => q.active && (q.state.selection || q.annotation.flagged || q.annotation.note))
      .map((q) => ({
        topic: q.topic,
        source: q.source,
        question: questionId(q.title),
        path: pathOf(q),
        chapter: q.chapter,
        caseTitle: q.caseTitle,
        fingerprint: q.fingerprint,
        selection: q.state.selection,
        confidence: q.state.confidence,
        answerSequence: q.state.answerSequence,
        flagged: q.annotation.flagged,
        note: q.annotation.note,
      }));
    const notes = store.list(libraryId, "note").map((note) => ({
      title: note.title,
      content: note.content,
      provenance: note.provenance,
      model: note.model,
      provider: note.provider,
      createdAt: note.createdAt,
    }));
    reply
      .type("application/json; charset=utf-8")
      .header("content-disposition", 'attachment; filename="study-data.json"');
    return JSON.stringify(
      { format: STUDY_DATA_FORMAT, version: STUDY_DATA_VERSION, exportedAt: new Date().toISOString(), library: library.name, questions, notes },
      null,
      1,
    );
  });

  app.post(base + "/import/study-data", async (request: any): Promise<ImportSummary> => {
    const libraryId = request.params.libraryId as string;
    if (typeof request.body?.content !== "string" || !request.body.content.trim())
      throw new AppError(400, "INVALID_STUDY_DATA", "Choose a file to import.");
    const { questions, notes } = parseStudyData(request.body.content);
    return store.idempotent(request, () => {
      const library = store.library(libraryId);
      const active = store.list(libraryId, "question").filter((q) => q.active);
      // Answers replay in their original order, so "most recent" sorting stays meaningful.
      const ordered = [...questions].sort(
        (a, b) => (a.answerSequence ?? Infinity) - (b.answerSequence ?? Infinity),
      );
      const { matched, unmatched, ambiguous } = matchEntries(ordered, active, filePaths(store, libraryId));
      const summary: ImportSummary = {
        answers: 0,
        annotations: 0,
        notes: 0,
        unchanged: 0,
        unmatched: unmatched.map(entryLabel),
        ambiguous: ambiguous.map(entryLabel),
      };
      let sequence = library.sequence;
      for (const entry of ordered) {
        const q = matched.get(entry);
        if (!q) continue;
        if (entry.selection && !q.choices.some((c: any) => c.label === entry.selection)) {
          summary.unmatched.push(entryLabel(entry));
          continue;
        }
        let changed = false;
        const confidence = entry.selection ? normalizeConfidence(entry.selection, q.answerKey, entry.confidence) : null;
        if (entry.selection && (entry.selection !== q.state.selection || confidence !== q.state.confidence)) {
          sequence++;
          q.state = { selection: entry.selection, confidence, answerSequence: sequence, version: q.state.version + 1 };
          summary.answers++;
          changed = true;
        }
        // A local question note is kept when the file has none for that question.
        const note = entry.note || q.annotation.note;
        if (entry.flagged !== q.annotation.flagged || note !== q.annotation.note) {
          q.annotation = { flagged: entry.flagged, note, version: q.annotation.version + 1 };
          summary.annotations++;
          changed = true;
        }
        if (changed) store.put(libraryId, "question", q);
        else summary.unchanged++;
      }
      store.sql("UPDATE libraries SET sequence=? WHERE id=?").run(sequence, libraryId);
      // Notes already here (same title and text) are not copied twice.
      const existing = new Set(store.list(libraryId, "note").map((note) => `${note.title}\u0000${note.hash}`));
      for (const note of notes) {
        const title = note.title.slice(0, MAX_NOTE_TITLE);
        if (existing.has(`${title}\u0000${hash(note.content)}`)) continue;
        existing.add(`${title}\u0000${hash(note.content)}`);
        store.saveNote(libraryId, {
          id: id(),
          title,
          content: note.content,
          provenance: note.provenance === "ai" ? "ai" : "human-saved",
          ...(note.provenance === "ai" ? { model: note.model, provider: note.provider, sources: [] } : {}),
          createdAt: note.createdAt ?? new Date().toISOString(),
          version: 1,
        });
        summary.notes++;
      }
      return summary;
    });
  });
}
