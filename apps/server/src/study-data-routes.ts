import type { FastifyInstance } from "fastify";
import { AppError, id, Store } from "./store.js";
import { hash, normalizeConfidence } from "../../../packages/domain/src/index.js";

/** `format` value that marks a study-data file written by this app. */
export const STUDY_DATA_FORMAT = "question-bank-prep/study-data";
const STUDY_DATA_VERSION = 1;
const MAX_NOTE_TITLE = 200;

/**
 * One question's study state in a study-data file. A question is found again by
 * topic + source + question ID (its title without "Question "), which survive a fresh
 * import of the same bank on another device; `fingerprint` (stem and choices) is the
 * fallback when the file moved.
 */
interface QuestionEntry {
  topic: string;
  source: string;
  question: string;
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
}

const questionId = (title: string) => title.replace(/^Question\s+/i, "");
const questionKey = (topic: string, source: string, question: string) =>
  JSON.stringify([topic, source, question]);

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
  return {
    questions: data.questions.map((entry: any) => ({
      topic: text(entry.topic),
      source: text(entry.source),
      question: questionId(text(entry.question)),
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
    const questions = store
      .list(libraryId, "question", ["caseText", "choices", "solution", "stem"])
      .filter((q) => q.active && (q.state.selection || q.annotation.flagged || q.annotation.note))
      .map((q) => ({
        topic: q.topic,
        source: q.source,
        question: questionId(q.title),
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
      const byKey = new Map(active.map((q) => [questionKey(q.topic, q.source, questionId(q.title)), q]));
      // Fingerprint fallback only when exactly one question has it.
      const byFingerprint = new Map<string, any>();
      const repeated = new Set<string>();
      for (const q of active) {
        if (byFingerprint.has(q.fingerprint)) repeated.add(q.fingerprint);
        byFingerprint.set(q.fingerprint, q);
      }
      const summary: ImportSummary = { answers: 0, annotations: 0, notes: 0, unchanged: 0, unmatched: [] };
      // Answers replay in their original order, so "most recent" sorting stays meaningful.
      const ordered = [...questions].sort(
        (a, b) => (a.answerSequence ?? Infinity) - (b.answerSequence ?? Infinity),
      );
      let sequence = library.sequence;
      for (const entry of ordered) {
        const q =
          byKey.get(questionKey(entry.topic, entry.source, entry.question)) ??
          (entry.fingerprint && !repeated.has(entry.fingerprint) ? byFingerprint.get(entry.fingerprint) : undefined);
        const validSelection = !entry.selection || q?.choices.some((c: any) => c.label === entry.selection);
        if (!q || !validSelection) {
          summary.unmatched.push(`${entry.topic}/${entry.source} ${entry.question}`);
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
