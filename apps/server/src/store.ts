import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  grade,
  GRADE_STATUSES,
  hash,
  normalizeConfidence,
  parseQuestions,
  questionStatus,
  validateMaterialFile,
} from "../../../packages/domain/src/index.js";

/**
 * Practice labels derived from a bank's path inside the material folder.
 *
 * topic  : first folder, e.g. "01-quantitative-methods"; "" for a file at the root.
 * source : file name without ".md", e.g. "qbank-2025".
 */
export function pathLabels(path: string): { topic: string; source: string } {
  const parts = path.split("/");
  return {
    topic: parts.length > 1 ? parts[0] : "",
    source: parts[parts.length - 1].replace(/\.md$/i, ""),
  };
}

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public current?: unknown,
  ) {
    super(message);
  }
}
export const id = () => randomUUID();

/** Question text a hint may show: no key, solution or saved responses. */
export const questionContent = (question: any) => ({
  id: question.id,
  title: question.title,
  stem: question.stem,
  choices: question.choices,
  caseText: question.caseText,
  contentVersion: question.contentVersion,
});
/** Strip hidden fields from a stored question; `reveal` adds the key and solution back. */
export function presentQuestion(
  question: any,
  options: { setState?: any; reveal: boolean },
) {
  const { answerKey, solution, fingerprint, ...safe } = question;
  const { setState, reveal } = options;
  return {
    ...safe,
    status: questionStatus(question),
    revealed: reveal,
    ...(setState
      ? {
          setState: {
            ...setState,
            status: grade(setState.selection, answerKey, setState.confidence),
          },
        }
      : {}),
    ...(reveal ? { answerKey, solution } : {}),
  };
}

/** Fields whose change makes a new immutable question revision. */
const CONTENT_FIELDS = [
  "fingerprint",
  "answerKey",
  "answerByAI",
  "solution",
  "title",
  "chapter",
  "caseTitle",
] as const;
const sameHeading = (a: any, b: any) =>
  a.title === b.title && a.chapter === b.chapter && a.caseTitle === b.caseTitle;
/**
 * The old question an incoming one continues without a user decision: the only
 * same-content question, or among several, the only one under the same heading.
 */
function automaticMatch(
  previous: any[],
  parsed: any,
  excluded: (questionId: string) => boolean = () => false,
) {
  const sameContent = previous.filter(
    (q) => q.fingerprint === parsed.fingerprint && !excluded(q.id),
  );
  if (sameContent.length <= 1) return sameContent[0];
  const sameContentAndHeading = sameContent.filter((q) =>
    sameHeading(q, parsed),
  );
  return sameContentAndHeading.length === 1
    ? sameContentAndHeading[0]
    : undefined;
}
const groupByFile = (questions: any[]) => {
  const byFile = new Map<string, any[]>();
  for (const q of questions)
    byFile.set(q.fileId, [...(byFile.get(q.fileId) ?? []), q]);
  return byFile;
};

export class Store {
  db: Database.Database;
  private statements = new Map<string, Database.Statement>();
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS libraries(id TEXT PRIMARY KEY, name TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, settings TEXT NOT NULL DEFAULT '{}', archived INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id), kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_kind ON records(library_id,kind);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(id UNINDEXED,library_id UNINDEXED,kind UNINDEXED,title,text);
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO schema_version VALUES(1);`);
  }
  /** Compile each SQL text once; import loops run the same statements thousands of times. */
  sql(text: string) {
    let statement = this.statements.get(text);
    if (!statement) {
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }
  library(libraryId: string) {
    const value = this.sql("SELECT * FROM libraries WHERE id=?").get(
      libraryId,
    ) as any;
    if (!value) throw new AppError(404, "NOT_FOUND", "Library not found.");
    return {
      ...value,
      settings: JSON.parse(value.settings),
      archived: Boolean(value.archived),
    };
  }
  libraryIds(): string[] {
    return (this.sql("SELECT id FROM libraries").all() as any[]).map(
      (row) => row.id,
    );
  }
  createLibrary(name: string) {
    const library = { id: id(), name };
    this.sql("INSERT INTO libraries(id,name) VALUES(?,?)").run(
      library.id,
      name,
    );
    return library;
  }
  bumpGeneration(libraryId: string) {
    this.sql("UPDATE libraries SET generation=generation+1 WHERE id=?").run(
      libraryId,
    );
  }
  list(libraryId: string, kind: string): any[] {
    this.library(libraryId);
    return (
      this.sql("SELECT data FROM records WHERE library_id=? AND kind=?").all(
        libraryId,
        kind,
      ) as any[]
    ).map((r) => JSON.parse(r.data));
  }
  get(libraryId: string, recordId: string, kind?: string): any {
    const row = this.sql(
      "SELECT * FROM records WHERE id=? AND library_id=?",
    ).get(recordId, libraryId) as any;
    if (!row || (kind && row.kind !== kind))
      throw new AppError(404, "NOT_FOUND", "Record not found in this library.");
    return JSON.parse(row.data);
  }
  /** Look up a record of any kind, or undefined. */
  find(libraryId: string, recordId: string) {
    const row = this.sql(
      "SELECT kind,data FROM records WHERE id=? AND library_id=?",
    ).get(recordId, libraryId) as any;
    return row
      ? { kind: row.kind as string, value: JSON.parse(row.data) }
      : undefined;
  }
  put(libraryId: string, kind: string, value: any) {
    this.sql(
      "INSERT INTO records(id,library_id,kind,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    ).run(value.id, libraryId, kind, JSON.stringify(value));
    return value;
  }
  /** Put a record whose searchable text or active flag may have changed, and refresh its search entry. */
  putIndexed(
    libraryId: string,
    kind: "question" | "file" | "note",
    value: any,
  ) {
    this.put(libraryId, kind, value);
    this.sql("DELETE FROM search_index WHERE id=? AND library_id=?").run(
      value.id,
      libraryId,
    );
    const insert = this.sql("INSERT INTO search_index VALUES(?,?,?,?,?)");
    if (kind === "question" && value.active)
      insert.run(
        value.id,
        libraryId,
        kind,
        value.title,
        `${value.caseText}\n${value.stem}\n${value.choices.map((choice: any) => `${choice.label}. ${choice.text}`).join("\n")}`,
      );
    if (
      (kind === "file" && value.active && value.type === "note") ||
      kind === "note"
    )
      insert.run(
        value.id,
        libraryId,
        kind,
        value.path ?? value.title,
        value.content,
      );
    return value;
  }
  search(libraryId: string, query: string) {
    this.library(libraryId);
    const tokens = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 20) ?? [];
    if (!tokens.length) return [];
    const expression = tokens
      .map((token) => `"${token.replaceAll('"', '""')}"`)
      .join(" AND ");
    return this.sql(
      "SELECT id,title,text,kind AS type FROM search_index WHERE search_index MATCH ? AND library_id=? ORDER BY rank LIMIT 50",
    ).all(expression, libraryId);
  }
  /** Save a note and its immutable `${id}:${version}` revision, which citations resolve. */
  saveNote(libraryId: string, note: any) {
    const saved = this.putIndexed(libraryId, "note", {
      ...note,
      hash: hash(note.content),
    });
    this.put(libraryId, "noteRevision", {
      ...saved,
      noteId: saved.id,
      id: `${saved.id}:${saved.version}`,
    });
    return saved;
  }
  /**
   * Delete a note (yours or a saved tutor reply) and its search entry. Its revisions stay,
   * so a chat that cited it can still open what it cited.
   */
  deleteNote(libraryId: string, noteId: string) {
    this.get(libraryId, noteId, "note");
    this.db.transaction(() => {
      this.sql(
        "DELETE FROM records WHERE id=? AND library_id=? AND kind='note'",
      ).run(noteId, libraryId);
      this.sql("DELETE FROM search_index WHERE id=? AND library_id=?").run(
        noteId,
        libraryId,
      );
    })();
  }
  /** Mark a file and its questions removed; responses stay as removed-source history. */
  deactivateFile(libraryId: string, file: any, questions?: any[]) {
    this.putIndexed(libraryId, "file", { ...file, active: false });
    for (const question of questions ??
      this.list(libraryId, "question").filter((q) => q.fileId === file.id))
      this.putIndexed(libraryId, "question", { ...question, active: false });
  }
  /** Visible Focus items. Staleness is derived from each link's observed versions. */
  focus(libraryId: string, questions?: Map<string, any>) {
    const lookup = (questionId: string) => {
      if (questions) return questions.get(questionId);
      try {
        return this.get(libraryId, questionId, "question");
      } catch {
        return undefined;
      }
    };
    return this.list(libraryId, "focus")
      .filter((item) => item.status !== "deleted")
      .map((item) => ({
        ...item,
        stale: item.links.some((link: any) => {
          const question = lookup(link.questionId);
          return (
            !question?.active ||
            question.contentVersion !== link.contentVersion ||
            question.state.version !== link.answerVersion ||
            (link.annotationVersion !== undefined &&
              question.annotation.version !== link.annotationVersion)
          );
        }),
      }));
  }
  /** Return the stored response for a repeated operation, or undefined for a new one. */
  receipt(operationId: unknown, request: unknown) {
    if (!operationId || typeof operationId !== "string")
      throw new AppError(
        400,
        "OPERATION_REQUIRED",
        "A unique operationId is required.",
      );
    const row = this.sql("SELECT * FROM operations WHERE id=?").get(
      operationId,
    ) as any;
    if (!row) return undefined;
    if (row.request_hash !== hash(JSON.stringify(request)))
      throw new AppError(
        409,
        "OPERATION_REUSED",
        "Operation ID was used for different content.",
      );
    return { response: JSON.parse(row.response) };
  }
  operation(operationId: unknown, request: unknown, work: () => any) {
    return this.db.transaction(() => {
      const previous = this.receipt(operationId, request);
      if (previous) return previous.response;
      const response = work();
      this.sql("INSERT INTO operations VALUES(?,?,?)").run(
        operationId,
        hash(JSON.stringify(request)),
        JSON.stringify(response),
      );
      return response;
    })();
  }
  /** Run a route mutation in one transaction; with an operationId, a retry returns the first response. */
  mutation(request: { url: string; body?: any }, work: () => any) {
    return request.body?.operationId
      ? this.idempotent(request, work)
      : this.db.transaction(work)();
  }
  /** Run a route mutation that requires an operationId receipt. */
  idempotent(request: { url: string; body?: any }, work: () => any) {
    return this.operation(
      request.body?.operationId,
      { route: request.url, ...request.body },
      work,
    );
  }
  preview(
    libraryId: string,
    files: any[],
    extra: Record<string, unknown> = {},
  ) {
    const library = this.library(libraryId);
    if (!Array.isArray(files) || !files.length)
      throw new AppError(
        400,
        "FILES_REQUIRED",
        "Choose Markdown files to import.",
      );
    const parsed = files.map((file) => {
      if (
        !file ||
        typeof file !== "object" ||
        Array.isArray(file) ||
        (file.type !== undefined && !["questions", "note"].includes(file.type))
      )
        throw new AppError(
          400,
          "INVALID_FILE",
          "Each file must specify a path, text content, and questions or note type.",
        );
      const invalid = validateMaterialFile(file.path, file.content);
      if (invalid) throw new AppError(400, "INVALID_FILE", invalid);
      const type = file.type === "note" ? "note" : "questions";
      const result =
        type === "questions"
          ? parseQuestions(
              file.content,
              file.path,
              library.settings.choiceLabels,
            )
          : { questions: [], issues: [] };
      return {
        ...file,
        type,
        hash: hash(file.content),
        ...result,
        questionCount: result.questions.length,
      };
    });
    if (new Set(parsed.map((f) => f.path)).size !== parsed.length)
      throw new AppError(
        400,
        "DUPLICATE_PATH",
        "Each import path must be unique.",
      );
    const issues = parsed.flatMap((file) => file.issues);
    const oldQuestions = this.list(libraryId, "question").filter(
      (question) => question.active,
    );
    const fileIdByPath = new Map(
      this.list(libraryId, "file").map((file) => [file.path, file.id]),
    );
    const activeByFile = groupByFile(oldQuestions);
    // automatic: the old question each incoming one continues, keyed by question object.
    const automatic = new Map<any, any>();
    for (const file of parsed) {
      const previous = activeByFile.get(fileIdByPath.get(file.path)) ?? [];
      for (const question of file.questions) {
        const match = automaticMatch(previous, question);
        if (match) {
          automatic.set(question, match);
          continue;
        }
        // Same heading but new content: the user decides whether progress carries over.
        if (previous.some((old) => sameHeading(old, question)))
          issues.push({
            path: file.path,
            line: question.line,
            severity: "warning",
            message: `${question.title}: identity requires review. Accepting creates a new question and preserves the previous response as removed-source history.`,
          });
      }
    }
    const questions = parsed.flatMap((file) => file.questions);
    const identityProposals = parsed.flatMap((file) =>
      file.questions.map((question: any) => ({
        key: `${file.path}:${question.line}`,
        path: file.path,
        line: question.line,
        title: question.title,
        automatic: automatic.has(question)
          ? {
              id: automatic.get(question).id,
              title: automatic.get(question).title,
            }
          : null,
        candidates: oldQuestions
          .filter(
            (old) =>
              old.title === question.title ||
              old.fingerprint === question.fingerprint,
          )
          .map((old) => ({
            id: old.id,
            title: old.title,
            stem: old.stem,
            choicesCompatible:
              JSON.stringify(old.choices) === JSON.stringify(question.choices),
            unchangedContent: old.fingerprint === question.fingerprint,
          })),
      })),
    );
    const preview = {
      id: id(),
      generation: library.generation,
      files: parsed,
      issues,
      identityProposals,
      counts: {
        questions: questions.length,
        gradable: questions.filter((q) => q.answerKey).length,
        ungradable: questions.filter((q) => !q.answerKey).length,
      },
      canCommit: !issues.some((issue) => issue.severity === "error"),
      ...extra,
    };
    this.put(libraryId, "import", preview);
    return preview;
  }
  commit(
    libraryId: string,
    previewId: string,
    acceptWarnings: boolean,
    identityMappings: Record<string, string | null> = {},
  ) {
    return this.db.transaction(() => {
      if (
        !identityMappings ||
        typeof identityMappings !== "object" ||
        Array.isArray(identityMappings) ||
        !Object.values(identityMappings).every(
          (value) => value === null || typeof value === "string",
        )
      )
        throw new AppError(
          400,
          "INVALID_MAPPING",
          "Identity mappings must map preview keys to question IDs or null.",
        );
      const preview = this.get(libraryId, previewId, "import");
      if (preview.committed) return preview.committed;
      const library = this.library(libraryId);
      if (library.generation !== preview.generation)
        throw new AppError(
          409,
          "STALE_PREVIEW",
          "Material changed since preview. Preview again.",
        );
      if (!preview.canCommit || (preview.issues.length && !acceptWarnings))
        throw new AppError(
          400,
          "IMPORT_ISSUES",
          "Fix structural errors and explicitly accept warnings.",
          { issues: preview.issues },
        );
      const existingFiles = this.list(libraryId, "file");
      const incomingHashCounts = new Map<string, number>();
      for (const file of preview.files)
        incomingHashCounts.set(
          file.hash,
          (incomingHashCounts.get(file.hash) ?? 0) + 1,
        );
      const mappedIds = new Set(
        Object.values(identityMappings).filter(
          (value): value is string => typeof value === "string",
        ),
      );
      if (
        mappedIds.size !==
        Object.values(identityMappings).filter((v) => v !== null).length
      )
        throw new AppError(
          400,
          "DUPLICATE_IDENTITY",
          "An existing question can map to only one incoming question.",
        );
      for (const key of Object.keys(identityMappings))
        if (
          !preview.identityProposals.some(
            (proposal: any) => proposal.key === key,
          )
        )
          throw new AppError(
            400,
            "INVALID_MAPPING",
            "Identity mapping does not belong to this preview.",
          );
      // Load questions and set items once. Before: one full parse per file; after: one per commit.
      const activeByFile = groupByFile(
        this.list(libraryId, "question").filter((q) => q.active),
      );
      const sets = this.list(libraryId, "set");
      // Identities claimed by any incoming question; a later file must not deactivate them.
      const claimed = new Set<string>();
      for (const incoming of preview.files) {
        let file = existingFiles.find((f) => f.path === incoming.path);
        // A rename must be unambiguous on both sides; copied files keep distinct identities.
        if (!file && incomingHashCounts.get(incoming.hash) === 1) {
          const matches = existingFiles.filter(
            (f) =>
              f.hash === incoming.hash &&
              !preview.files.some((p: any) => p.path === f.path),
          );
          if (matches.length === 1) file = matches[0];
        }
        if (
          file?.active &&
          file.hash === incoming.hash &&
          file.path === incoming.path &&
          file.type === incoming.type
        )
          continue;
        const fileId = file?.id ?? id();
        const revision = (file?.version ?? 0) + 1;
        const previousQuestions = activeByFile.get(fileId) ?? [];
        incoming.questions.forEach((parsed: any, position: number) => {
          const explicit = identityMappings[`${incoming.path}:${parsed.line}`];
          const old = explicit
            ? this.get(libraryId, explicit, "question")
            : explicit === null
              ? undefined
              : automaticMatch(
                  previousQuestions,
                  parsed,
                  (questionId) =>
                    claimed.has(questionId) || mappedIds.has(questionId),
                );
          if (
            explicit &&
            JSON.stringify(old.choices) !== JSON.stringify(parsed.choices)
          )
            throw new AppError(
              400,
              "INCOMPATIBLE_CHOICES",
              "Choice labels or meanings changed. Create a new identity to preserve prior answer semantics.",
            );
          if (old) claimed.add(old.id);
          // Unchanged questions keep their version, so Focus links to them stay fresh.
          const unchanged =
            old &&
            CONTENT_FIELDS.every((field) => old[field] === parsed[field]);
          const state = old?.state ?? {
            selection: null,
            confidence: null,
            answerSequence: null,
            version: 0,
          };
          state.confidence = normalizeConfidence(
            state.selection,
            parsed.answerKey,
            state.confidence,
          );
          const question = {
            ...parsed,
            id: old?.id ?? id(),
            fileId,
            ...pathLabels(incoming.path),
            position,
            active: true,
            contentVersion: unchanged
              ? old.contentVersion
              : (old?.contentVersion ?? 0) + 1,
            state,
            annotation: old?.annotation ?? {
              flagged: false,
              note: "",
              version: 0,
            },
          };
          this.putIndexed(libraryId, "question", question);
          if (old && old.answerKey !== parsed.answerKey)
            for (const set of sets) {
              const item = set.items.find(
                (item: any) => item.questionId === old.id,
              );
              if (item?.submitted) {
                item.confidence = normalizeConfidence(
                  item.selection,
                  parsed.answerKey,
                  item.confidence,
                );
                this.put(libraryId, "set", set);
              }
            }
          if (!unchanged)
            this.put(libraryId, "questionRevision", {
              ...question,
              id: `${question.id}:${question.contentVersion}`,
              questionId: question.id,
            });
        });
        for (const old of previousQuestions)
          if (!claimed.has(old.id))
            this.putIndexed(libraryId, "question", { ...old, active: false });
        const nextFile = {
          id: fileId,
          path: incoming.path,
          content: incoming.content,
          hash: incoming.hash,
          type: incoming.type,
          ...pathLabels(incoming.path),
          version: revision,
          active: true,
          local: file?.local ?? incoming.local ?? false,
        };
        this.putIndexed(libraryId, "file", nextFile);
        this.put(libraryId, "fileRevision", {
          ...nextFile,
          id: `${fileId}:${revision}`,
          fileId,
        });
      }
      this.bumpGeneration(libraryId);
      const result = {
        importRevision: library.generation + 1,
        questions: (
          this.sql(
            "SELECT COUNT(*) AS count FROM records WHERE library_id=? AND kind='question' AND json_extract(data,'$.active')",
          ).get(libraryId) as any
        ).count,
      };
      this.put(libraryId, "import", { ...preview, committed: result });
      return result;
    })();
  }
  /** Re-derive topic/source labels from file paths; unchanged files skip import, so sync does this. */
  syncPathLabels(libraryId: string) {
    const files = new Map(
      this.list(libraryId, "file").map((file) => [file.id, file]),
    );
    this.db.transaction(() => {
      for (const q of this.list(libraryId, "question")) {
        const file = files.get(q.fileId);
        if (!file) continue;
        const labels = pathLabels(file.path);
        if (q.topic !== labels.topic || q.source !== labels.source)
          this.put(libraryId, "question", { ...q, ...labels });
      }
    })();
  }
  /**
   * A set plus `itemStatuses`, one grade per question. A question not yet answered in
   * this set shows its latest answer from any set, so progress is remembered everywhere.
   */
  presentSet(libraryId: string, set: any) {
    return {
      ...set,
      itemStatuses: set.items.map((item: any) => {
        const q = this.get(libraryId, item.questionId, "question");
        return item.submitted
          ? grade(item.selection, q.answerKey, item.confidence)
          : questionStatus(q);
      }),
    };
  }
  question(libraryId: string, questionId: string, setId?: string) {
    const question = this.get(libraryId, questionId, "question");
    let setState;
    if (setId) {
      const set = this.get(libraryId, setId, "set");
      setState = set.items.find((item: any) => item.questionId === questionId);
      if (!setState)
        throw new AppError(404, "NOT_IN_SET", "Question is not in this set.");
      // Not answered in this set yet: carry the latest answer from any set.
      if (!setState.submitted && question.state.selection)
        setState = {
          ...setState,
          submitted: true,
          selection: question.state.selection,
          confidence: question.state.confidence,
        };
    }
    return presentQuestion(question, {
      setState,
      reveal: setState ? setState.submitted : Boolean(question.state.selection),
    });
  }
  answer(libraryId: string, questionId: string, body: any) {
    return this.operation(
      body.operationId,
      { libraryId, questionId, ...body },
      () => {
        const q = this.get(libraryId, questionId, "question");
        if (!q.active)
          throw new AppError(
            409,
            "REMOVED_SOURCE",
            "This source is removed; its response is retained.",
          );
        if (body.expectedVersion !== q.state.version)
          throw new AppError(
            409,
            "VERSION_CONFLICT",
            "A newer answer was saved. Reload before applying your change.",
            q.state,
          );
        if (!q.choices.some((c: any) => c.label === body.selection))
          throw new AppError(
            400,
            "INVALID_CHOICE",
            "Selection must match a choice label.",
          );
        const library = this.library(libraryId);
        const sequence = library.sequence + 1;
        let set: any, item: any;
        if (body.setId) {
          set = this.get(libraryId, body.setId, "set");
          item = set.items.find((i: any) => i.questionId === questionId);
          if (!item)
            throw new AppError(
              400,
              "NOT_IN_SET",
              "Question is not in this set.",
            );
        }
        const state = {
          selection: body.selection,
          confidence: normalizeConfidence(
            body.selection,
            q.answerKey,
            body.confidence,
          ),
          answerSequence: sequence,
          version: q.state.version + 1,
        };
        this.sql("UPDATE libraries SET sequence=? WHERE id=?").run(
          sequence,
          libraryId,
        );
        this.put(libraryId, "question", { ...q, state });
        if (set) {
          Object.assign(item, state, {
            submitted: true,
            contentVersion: q.contentVersion,
          });
          this.put(libraryId, "set", set);
        }
        return {
          ...state,
          status: grade(state.selection, q.answerKey, state.confidence),
        };
      },
    );
  }
  select(libraryId: string, body: any) {
    if (
      body.limit !== undefined &&
      (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 10000)
    )
      throw new AppError(
        400,
        "INVALID_LIMIT",
        "Set size must be an integer from 1 to 10000.",
      );
    if (
      body.order !== undefined &&
      !["source", "older", "shuffle"].includes(body.order)
    )
      throw new AppError(
        400,
        "INVALID_ORDER",
        "Set order must be source, older, or shuffle.",
      );
    const filters = body.filters ?? {};
    if (
      typeof filters !== "object" ||
      Array.isArray(filters) ||
      (filters.sources !== undefined &&
        (!Array.isArray(filters.sources) ||
          !filters.sources.every(
            (name: unknown) => typeof name === "string",
          ))) ||
      (filters.statuses !== undefined &&
        (!Array.isArray(filters.statuses) ||
          !filters.statuses.every((status: unknown) =>
            (GRADE_STATUSES as readonly string[]).includes(String(status)),
          )))
    )
      throw new AppError(
        400,
        "INVALID_FILTER",
        "Choose valid question statuses.",
      );
    let questions = this.list(libraryId, "question").filter((q) => q.active);
    const focusIds = filters.inFocus
      ? new Set(
          this.focus(libraryId, new Map(questions.map((q) => [q.id, q])))
            .filter((f) => f.status === "open" && !f.stale)
            .flatMap((f) => f.links.map((link: any) => link.questionId)),
        )
      : undefined;
    const query = String(filters.query ?? "").toLowerCase();
    questions = questions.filter(
      (q) =>
        (!filters.statuses?.length ||
          filters.statuses.includes(questionStatus(q))) &&
        (!filters.flagged || q.annotation.flagged) &&
        (!focusIds || focusIds.has(q.id)) &&
        (!filters.topic || q.topic === filters.topic) &&
        (!filters.chapter || q.chapter === filters.chapter) &&
        (!filters.source || q.source === filters.source) &&
        (!filters.sources?.length || filters.sources.includes(q.source)) &&
        (!query ||
          `${q.title} ${q.topic} ${q.source} ${q.chapter} ${q.stem}`
            .toLowerCase()
            .includes(query)),
    );
    if (body.order === "source" || body.order === undefined) {
      const pathById = new Map(
        this.list(libraryId, "file").map((file) => [file.id, file.path]),
      );
      questions.sort(
        (a, b) =>
          pathById.get(a.fileId).localeCompare(pathById.get(b.fileId)) ||
          a.position - b.position,
      );
    } else if (body.order === "older")
      questions.sort(
        (a, b) =>
          (a.state.answerSequence ?? Infinity) -
          (b.state.answerSequence ?? Infinity),
      );
    else if (body.order === "shuffle") {
      const groups = new Map<string, any[]>();
      for (const q of questions) {
        const key = q.caseTitle
          ? `${q.fileId}:${q.chapter}:${q.caseTitle}`
          : q.id;
        groups.set(key, [...(groups.get(key) ?? []), q]);
      }
      questions = [...groups.entries()]
        .sort(([a], [b]) =>
          hash(`${body.seed ?? "default"}:${a}`).localeCompare(
            hash(`${body.seed ?? "default"}:${b}`),
          ),
        )
        .flatMap(([, group]) => group.sort((a, b) => a.position - b.position));
    }
    return questions.slice(0, body.limit).map((q) => q.id);
  }
}
