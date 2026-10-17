import { registerAIRoutes } from "./ai-routes.js";
import { registerFocusRoutes } from "./focus-routes.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, id, Store } from "./store.js";
import {
  hash,
  needsReview,
  questionStatus,
  validateChoiceLabels,
} from "../../../packages/domain/src/index.js";

/** Hostnames that count as this computer; anything else needs a password. */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];
/** A login lasts this long and is renewed each time the app is opened (sliding expiry). */
const SESSION_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
/** Characters of each question stem in the progress CSV. */
const PROGRESS_STEM_CHARACTERS = 160;

export async function buildApp(
  options: {
    databasePath?: string;
    password?: string;
    logger?: boolean;
    provider?: any;
    calculator?: (request: any) => Promise<any>;
    /** READING_ROOT: study notes the tutor may search (read-only). */
    readingRoot?: string;
    /**
     * Behind a reverse proxy that terminates HTTPS: read X-Forwarded-Proto/-For so the
     * session cookie is marked Secure and rate limits see the real client address.
     * Leave off when the app is reached directly, or clients could fake those headers.
     */
    trustProxy?: boolean;
  } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 12_000_000,
    trustProxy: options.trustProxy ?? false,
  });
  const store = new Store(options.databasePath ?? ":memory:");
  // Sessions live in SQLite (only a hash of each token), so a restart or an image
  // update keeps you signed in.
  const sessionExpiry = (token: string) =>
    (
      store.db
        .prepare("SELECT expires_at FROM sessions WHERE token_hash=?")
        .get(hash(token)) as { expires_at: number } | undefined
    )?.expires_at ?? 0;
  const signedIn = (request: any) =>
    sessionExpiry(request.cookies.study_session ?? "") > Date.now();
  const setSessionCookie = (request: any, reply: any, token: string) =>
    reply.setCookie("study_session", token, {
      httpOnly: true,
      // Lax keeps you signed in when you arrive from a link on another site; the
      // origin check below still refuses cross-site writes.
      sameSite: "lax",
      path: "/",
      secure: request.protocol === "https",
      maxAge: SESSION_MILLISECONDS / 1000,
    });
  /** Start or extend a session: store its new expiry and refresh the cookie. */
  const renewSession = (request: any, reply: any, token: string) => {
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash, expires_at) VALUES(?, ?) ON CONFLICT(token_hash) DO UPDATE SET expires_at=excluded.expires_at",
      )
      .run(hash(token), Date.now() + SESSION_MILLISECONDS);
    setSessionCookie(request, reply, token);
  };
  const sameHost = (origin: string, host: string | undefined) => {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  };
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  app.addHook("onClose", async () => {
    store.db.close();
  });
  app.setErrorHandler((error: any, _request, reply) =>
    reply.code(error.statusCode ?? 500).send({
      error: {
        code: error.code ?? "INTERNAL_ERROR",
        message: error.statusCode
          ? error.message
          : "The operation failed. Check the server log.",
        ...(error.current ? { current: error.current } : {}),
      },
    }),
  );
  // Route config flags: public (no sign-in) and allowWhenArchived (writes allowed on archived libraries).
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    if (!options.password && !LOOPBACK_HOSTS.includes(request.hostname))
      throw new AppError(
        403,
        "HOST_REJECTED",
        "Local mode accepts only loopback hostnames.",
      );
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.origin;
      if (
        (origin && !sameHost(origin, request.headers.host)) ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw new AppError(
          403,
          "ORIGIN_REJECTED",
          "Cross-origin changes are not allowed.",
        );
    }
    const config = request.routeOptions.config as { public?: boolean };
    if (options.password && !config.public && !signedIn(request))
      throw new AppError(
        401,
        "UNAUTHENTICATED",
        "Sign in to access study data.",
      );
  });
  app.addHook("preValidation", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    const parameters = request.params as Record<string, string>;
    const config = request.routeOptions.config as {
      allowWhenArchived?: boolean;
    };
    if (
      parameters?.libraryId &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      !config.allowWhenArchived &&
      store.library(parameters.libraryId).archived
    )
      throw new AppError(
        409,
        "LIBRARY_ARCHIVED",
        "This library is archived. Unarchive it in Settings before making changes.",
      );
    if (
      request.body !== undefined &&
      (request.body === null ||
        Array.isArray(request.body) ||
        typeof request.body !== "object")
    )
      throw new AppError(
        400,
        "INVALID_BODY",
        "Request body must be a JSON object.",
      );
    const body = request.body as Record<string, unknown> | undefined;
    if (!body) return;
    for (const field of [
      "operationId",
      "selection",
      "confidence",
      "setId",
      "title",
      "name",
      "text",
      "content",
      "note",
      "expectedHash",
      "model",
      "material",
      "readingPath",
      "readingTitle",
    ])
      if (body[field] !== undefined && typeof body[field] !== "string")
        throw new AppError(400, "INVALID_FIELD", `${field} must be text.`);
    if (
      body.expectedVersion !== undefined &&
      (!Number.isInteger(body.expectedVersion) ||
        Number(body.expectedVersion) < 0)
    )
      throw new AppError(
        400,
        "INVALID_VERSION",
        "expectedVersion must be a nonnegative integer.",
      );
    if (
      body.confidence !== undefined &&
      !["sure", "unsure"].includes(String(body.confidence))
    )
      throw new AppError(
        400,
        "INVALID_CONFIDENCE",
        "confidence must be sure or unsure.",
      );
  });
  app.get("/api/health", { config: { public: true } }, async () => ({
    status: "ok",
  }));
  app.get(
    "/api/session",
    { config: { public: true } },
    async (request: any, reply) => {
      if (!options.password) return { authenticated: true };
      const authenticated = signedIn(request);
      // Opening the app renews the login, so regular use never signs you out.
      if (authenticated)
        renewSession(request, reply, request.cookies.study_session);
      return { authenticated };
    },
  );
  app.post(
    "/api/session",
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request: any, reply) => {
      const supplied = hash(String(request.body?.password ?? ""));
      const expected = hash(options.password ?? "");
      if (
        options.password &&
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
      )
        throw new AppError(401, "INVALID_PASSWORD", "Password is incorrect.");
      store.db
        .prepare("DELETE FROM sessions WHERE expires_at < ?")
        .run(Date.now());
      renewSession(request, reply, randomBytes(32).toString("hex"));
      return { authenticated: true };
    },
  );
  app.delete(
    "/api/session",
    { config: { public: true } },
    async (request, reply) => {
      store.db
        .prepare("DELETE FROM sessions WHERE token_hash=?")
        .run(hash(request.cookies.study_session ?? ""));
      reply.clearCookie("study_session");
      return { authenticated: false };
    },
  );
  app.get("/api/libraries", async () => ({
    libraries: store.libraryIds().map((libraryId) => store.library(libraryId)),
  }));
  app.post("/api/libraries", async (request: any) => {
    const name = String(request.body?.name ?? "").trim();
    if (!name || name.length > 200)
      throw new AppError(
        400,
        "INVALID_NAME",
        "Choose a library name under 200 characters.",
      );
    return store.createLibrary(name);
  });
  const base = "/api/libraries/:libraryId";
  const lib = (request: any) => request.params.libraryId as string;
  app.get(base + "/settings", async (request: any) =>
    store.library(lib(request)),
  );
  app.patch(
    base + "/settings",
    { config: { allowWhenArchived: true } },
    async (request: any) =>
      store.idempotent(request, () => {
        const library = store.library(lib(request));
        if (request.body.expectedVersion !== library.version)
          throw new AppError(
            409,
            "VERSION_CONFLICT",
            "Library settings changed.",
            library,
          );
        const labels =
          request.body.settings?.choiceLabels ?? library.settings.choiceLabels;
        const invalidLabels =
          labels === undefined ? null : validateChoiceLabels(labels);
        if (invalidLabels)
          throw new AppError(400, "INVALID_LABELS", invalidLabels);
        const model = request.body.settings?.model;
        if (model !== undefined && (typeof model !== "string" || !model))
          throw new AppError(400, "INVALID_MODEL", "Choose a model by its ID.");
        const effort = request.body.settings?.effort;
        if (effort !== undefined && (typeof effort !== "string" || !effort))
          throw new AppError(400, "INVALID_EFFORT", "Choose a thinking level.");
        const settings = {
          ...library.settings,
          ...(labels ? { choiceLabels: labels } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        };
        const name =
          request.body.name === undefined
            ? library.name
            : String(request.body.name).trim();
        if (!name || name.length > 200)
          throw new AppError(
            400,
            "INVALID_NAME",
            "Choose a library name under 200 characters.",
          );
        store.db
          .prepare(
            "UPDATE libraries SET name=?,settings=?,archived=?,version=version+1,generation=generation+1 WHERE id=?",
          )
          .run(
            name,
            JSON.stringify(settings),
            request.body.archived === undefined
              ? Number(library.archived)
              : Number(Boolean(request.body.archived)),
            lib(request),
          );
        return store.library(lib(request));
      }),
  );
  app.get(base + "/overview", async (request: any) => {
    const libraryId = lib(request);
    const questions = store.list(libraryId, "question").filter((q) => q.active);
    const counts: Record<string, number> = {
      unanswered: 0,
      wrong: 0,
      unsure: 0,
      correct: 0,
      ungradable: 0,
      total: questions.length,
    };
    for (const q of questions) counts[questionStatus(q)]++;
    // One row per topic / source / chapter, so practice can be split instead of one big list.
    const catalog = new Map<string, any>();
    for (const q of questions) {
      const key = `${q.topic}\u0000${q.source}\u0000${q.chapter}`;
      const row = catalog.get(key) ?? {
        topic: q.topic,
        source: q.source,
        chapter: q.chapter,
        total: 0,
        done: 0,
        correct: 0,
        unsure: 0,
        wrong: 0,
        flagged: 0,
      };
      row.total++;
      if (q.annotation.flagged) row.flagged++;
      if (q.state.selection) row.done++;
      const status = questionStatus(q);
      if (status in row) row[status]++;
      catalog.set(key, row);
    }
    return {
      counts,
      catalog: [...catalog.values()].sort(
        (a, b) =>
          a.topic.localeCompare(b.topic) ||
          a.source.localeCompare(b.source) ||
          a.chapter.localeCompare(b.chapter),
      ),
      sets: store
        .list(libraryId, "set")
        .map(({ id, title, cursor, questionIds, filters }) => ({
          id,
          title,
          cursor,
          filters,
          count: questionIds.length,
        })),
    };
  });
  app.get(base + "/questions/:id", async (request: any) =>
    store.question(lib(request), request.params.id, request.query.setId),
  );
  app.post(base + "/questions/:id/answer", async (request: any) =>
    store.answer(lib(request), request.params.id, request.body),
  );
  app.patch(base + "/questions/:id/annotation", async (request: any) =>
    store.idempotent(request, () => {
      const q = store.get(lib(request), request.params.id, "question");
      if (q.annotation.version !== request.body.expectedVersion)
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "The annotation changed.",
          q.annotation,
        );
      const annotation = {
        flagged:
          request.body.flagged === undefined
            ? q.annotation.flagged
            : Boolean(request.body.flagged),
        note:
          request.body.note === undefined
            ? q.annotation.note
            : String(request.body.note).slice(0, 100000),
        version: q.annotation.version + 1,
      };
      store.put(lib(request), "question", { ...q, annotation });
      return annotation;
    }),
  );
  app.post(base + "/sets/preview", async (request: any) => {
    const questionIds = store.select(lib(request), request.body);
    return { questionIds, count: questionIds.length };
  });
  app.post(base + "/sets", async (request: any) =>
    store.mutation(request, () => {
      const questionIds = store.select(lib(request), request.body);
      if (!questionIds.length)
        throw new AppError(
          400,
          "EMPTY_SET",
          "No questions match these filters.",
        );
      return store.put(lib(request), "set", {
        id: id(),
        title: String(request.body.title || "Practice set"),
        questionIds,
        filters: request.body.filters ?? {},
        seed: request.body.seed ?? "default",
        importRevision: store.library(lib(request)).generation,
        cursor: 0,
        version: 0,
        items: questionIds.map((questionId) => ({
          questionId,
          submitted: false,
          selection: null,
          confidence: null,
          version: 0,
        })),
      });
    }),
  );
  app.get(base + "/sets", async (request: any) => ({
    sets: store.list(lib(request), "set"),
  }));
  app.get(base + "/sets/:id", async (request: any) =>
    store.presentSet(
      lib(request),
      store.get(lib(request), request.params.id, "set"),
    ),
  );
  app.patch(base + "/sets/:id", async (request: any) =>
    store.presentSet(
      lib(request),
      store.mutation(request, () => {
        const set = store.get(lib(request), request.params.id, "set");
        if (set.version !== request.body.expectedVersion)
          throw new AppError(
            409,
            "VERSION_CONFLICT",
            "Set cursor changed.",
            set,
          );
        const cursor = Number(request.body.cursor);
        if (
          !Number.isInteger(cursor) ||
          cursor < 0 ||
          cursor >= set.items.length
        )
          throw new AppError(
            400,
            "INVALID_CURSOR",
            "Cursor is outside this set.",
          );
        return store.put(lib(request), "set", {
          ...set,
          cursor,
          version: set.version + 1,
        });
      }),
    ),
  );
  app.post(base + "/imports/preview", async (request: any) => {
    const preview = store.preview(lib(request), request.body.files);
    return {
      ...preview,
      files: preview.files.map(({ content, questions, ...file }: any) => file),
    };
  });
  app.post(base + "/imports/:id/commit", async (request: any) =>
    store.commit(
      lib(request),
      request.params.id,
      request.body?.acceptWarnings === true,
      request.body?.identityMappings,
    ),
  );
  app.get(base + "/files", async (request: any) => ({
    files: store.list(lib(request), "file").map(({ content, ...file }) => file),
  }));
  app.get(base + "/files/:id", async (request: any) =>
    store.get(
      lib(request),
      request.params.id,
      request.query.revision ? "fileRevision" : "file",
    ),
  );
  app.put(base + "/files/:id", async (request: any) =>
    store.idempotent(request, () => {
      const file = store.get(lib(request), request.params.id, "file");
      if (file.hash !== request.body.expectedHash)
        throw new AppError(
          409,
          "HASH_CONFLICT",
          "The material changed. Your draft has not replaced it.",
          { hash: file.hash, content: file.content },
        );
      const preview = store.preview(lib(request), [
        { ...file, content: request.body.content },
      ]);
      store.commit(
        lib(request),
        preview.id,
        request.body.acceptWarnings === true,
      );
      return store.get(lib(request), file.id, "file");
    }),
  );
  app.delete(base + "/files/:id", async (request: any) =>
    store.db.transaction(() => {
      store.deactivateFile(
        lib(request),
        store.get(lib(request), request.params.id, "file"),
      );
      store.bumpGeneration(lib(request));
      return { removed: true };
    })(),
  );
  app.get(base + "/search", async (request: any) => ({
    results: store.search(lib(request), String(request.query.q ?? "")),
  }));
  app.get(base + "/notes", async (request: any) => ({
    notes: store.list(lib(request), "note"),
  }));
  app.post(base + "/notes", async (request: any) =>
    store.mutation(request, () =>
      store.saveNote(lib(request), {
        id: id(),
        title: String(request.body.title || "Study note"),
        content: String(request.body.content || ""),
        provenance: "human-saved",
        version: 1,
      }),
    ),
  );
  app.delete(base + "/notes/:id", async (request: any) => {
    store.deleteNote(lib(request), request.params.id);
    return { deleted: true };
  });
  app.put(base + "/notes/:id", async (request: any) =>
    store.mutation(request, () => {
      const note = store.get(lib(request), request.params.id, "note");
      if (note.hash !== request.body.expectedHash)
        throw new AppError(409, "HASH_CONFLICT", "Note changed.", note);
      return store.saveNote(lib(request), {
        ...note,
        title:
          request.body.title === undefined
            ? note.title
            : String(request.body.title).slice(0, 200),
        content: String(request.body.content),
        version: note.version + 1,
      });
    }),
  );
  app.get(base + "/focus", async (request: any) => ({
    items: store.focus(lib(request)),
  }));
  app.post(base + "/focus/refresh", async (request: any) =>
    store.mutation(request, () => {
      const libraryId = lib(request);
      const reviewItems = new Map(
        store
          .list(libraryId, "focus")
          .filter((f) => f.method === "deterministic-review")
          .map((f) => [f.questionId, f]),
      );
      for (const q of store
        .list(libraryId, "question")
        .filter((q) => q.active)) {
        const result = questionStatus(q);
        // A question that left wrong/unsure keeps its item; its link versions make it stale.
        if (!needsReview(result)) continue;
        const evidence = hash(
          JSON.stringify([q.state, q.contentVersion, q.annotation]),
        );
        const old = reviewItems.get(q.id);
        if (old?.evidence === evidence) continue;
        store.put(libraryId, "focus", {
          id: old?.id ?? id(),
          questionId: q.id,
          links: [
            {
              questionId: q.id,
              contentVersion: q.contentVersion,
              answerVersion: q.state.version,
            },
          ],
          title: `${q.chapter || q.topic || "Review"}: ${q.title}`,
          body: `Your latest saved answer is ${result}. Review the source explanation and your reasoning.`,
          topic: q.topic,
          chapter: q.chapter,
          status: "open",
          evidence,
          version: (old?.version ?? 0) + 1,
          method: "deterministic-review",
        });
      }
      return {
        items: store.focus(libraryId),
        coverage:
          "Saved wrong and unsure answers only; no AI concept synthesis.",
      };
    }),
  );
  app.patch(base + "/focus/:id", async (request: any) =>
    store.mutation(request, () => {
      const item = store.get(lib(request), request.params.id, "focus");
      if (!["open", "resolved", "deleted"].includes(request.body.status))
        throw new AppError(
          400,
          "INVALID_STATUS",
          "Use open, resolved, or deleted.",
        );
      if (
        request.body.expectedVersion !== undefined &&
        request.body.expectedVersion !== item.version
      )
        throw new AppError(
          409,
          "VERSION_CONFLICT",
          "Focus item changed.",
          item,
        );
      return store.put(lib(request), "focus", {
        ...item,
        status: request.body.status,
        version: item.version + 1,
      });
    }),
  );
  registerAIRoutes(app, store, options);
  // Two separate downloads: notes as Markdown, study progress as CSV. A full backup of
  // everything is `npm run backup` (README "Back up and restore").
  app.get(base + "/export/notes", async (request: any, reply) => {
    const origin = request.query.origin === "ai" ? "ai" : "mine";
    const notes = store
      .list(lib(request), "note")
      .filter((note) => (note.provenance === "ai") === (origin === "ai"));
    const markdown = notes
      .map((note) => `## ${note.title}\n\n${String(note.content).trim()}\n`)
      .join("\n");
    reply
      .type("text/markdown; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="${origin === "ai" ? "ai-notes" : "my-notes"}.md"`,
      );
    return `# ${origin === "ai" ? "AI notes" : "My notes"}\n\n${markdown}`;
  });
  app.get(base + "/export/progress", async (request: any, reply) => {
    // One row per answered question: where it sits, what you chose, and how it went.
    const cell = (value: unknown) =>
      `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = store
      .list(lib(request), "question")
      .filter((q) => q.active && q.state.selection)
      .map((q) =>
        [
          q.topic,
          q.source,
          q.chapter,
          q.title.replace(/^Question\s+/i, ""),
          q.stem.replace(/\s+/g, " ").slice(0, PROGRESS_STEM_CHARACTERS),
          questionStatus(q),
          q.state.selection,
          q.answerKey,
          q.state.confidence,
          q.annotation.flagged ? "yes" : "",
        ]
          .map(cell)
          .join(","),
      );
    reply
      .type("text/csv; charset=utf-8")
      .header(
        "content-disposition",
        'attachment; filename="study-progress.csv"',
      );
    return [
      "topic,source,chapter,question,stem,result,your_answer,answer_key,confidence,flagged",
      ...rows,
    ].join("\n");
  });
  registerFocusRoutes(app, store, options.provider);
  return { app, store };
}
