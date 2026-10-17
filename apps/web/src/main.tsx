import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, operation } from "./api";
import { Markdown } from "./Markdown";
import "./style.css";

const pages = [
  "Practice",
  "Ask AI",
  "Notes",
  "Materials",
  "History",
  "Settings",
] as const;
type Page = (typeof pages)[number];
const DEFAULT_MODEL = "gpt-6.1-sol";
/** Wait after the last filter change before asking the server for a count. */
const COUNT_DEBOUNCE_MS = 200;
const RUN_POLL_MS = 500;
/** "01-quantitative-methods" -> "01 Quantitative Methods"; "qbank-2025" -> "Qbank 2025". */
const labelOf = (slug: string) =>
  slug.replace(/-/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
/** "Chapter LM01 Basics…" -> "LM01 Basics…". */
const chapterLabel = (chapter: string) => chapter.replace(/^Chapter\s+/i, "");
/** Sum catalog rows (topic/source/chapter progress) into one deck summary. */
const sumRows = (rows: any[]) =>
  rows.reduce(
    (sum, row) => ({
      total: sum.total + row.total,
      done: sum.done + row.done,
      correct: sum.correct + row.correct,
      unsure: sum.unsure + row.unsure,
      wrong: sum.wrong + row.wrong,
    }),
    { total: 0, done: 0, correct: 0, unsure: 0, wrong: 0 },
  );
/** URL hash for a view, so refresh and the browser Back button keep the place. */
const hashFor = (page: Page, setId?: string) =>
  `#/${page.toLowerCase().replace(/ /g, "-")}${setId ? `/${setId}` : ""}`;
const parseHash = (hash: string) => {
  const [slug, setId] = hash.replace(/^#\/?/, "").split("/");
  const page = pages.find((p) => hashFor(p) === `#/${slug}`) ?? "Practice";
  return { page, setId: page === "Practice" ? setId : undefined };
};
const blankCounts = {
  total: 0,
  correct: 0,
  wrong: 0,
  unsure: 0,
  unanswered: 0,
  ungradable: 0,
};
function App() {
  const [page, setPage] = useState<Page>("Practice"),
    [libraries, setLibraries] = useState<any[]>([]),
    [library, setLibrary] = useState(""),
    [overview, setOverview] = useState<any>({
      counts: blankCounts,
      sets: [],
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [activeSet, setActiveSet] = useState<any>(null),
    [eligibleCount, setEligibleCount] = useState(0),
    [question, setQuestion] = useState<any>(null),
    [draft, setDraft] = useState(""),
    [confidence, setConfidence] = useState("sure"),
    [saveStatus, setSaveStatus] = useState(""),
    [statuses, setStatuses] = useState<string[]>([]),
    [order, setOrder] = useState("source"),
    [flagged, setFlagged] = useState(false),
    [query, setQuery] = useState(""),
    [topic, setTopic] = useState(""),
    [source, setSource] = useState(""),
    [chapter, setChapter] = useState(""),
    [noteDraft, setNoteDraft] = useState<any>(null);
  const [importPreview, setImportPreview] = useState<any>(null),
    [importPath, setImportPath] = useState("questions.md"),
    [importContent, setImportContent] = useState(""),
    [chats, setChats] = useState<any[]>([]),
    [chat, setChat] = useState<any>(null),
    [prompt, setPrompt] = useState(""),
    [notes, setNotes] = useState<any[]>([]),
    [settings, setSettings] = useState<any>(null),
    [citation, setCitation] = useState<any>(null),
    [librarySettings, setLibrarySettings] = useState<any>(null),
    [model, setModel] = useState(DEFAULT_MODEL),
    [activeRun, setActiveRun] = useState<string | null>(null),
    [needsLogin, setNeedsLogin] = useState(false),
    [password, setPassword] = useState(""),
    [identityMappings, setIdentityMappings] = useState<
      Record<string, string | null>
    >({}),
    [caseOpen, setCaseOpen] = useState(true),
    [materialRoot, setMaterialRoot] = useState(false);
  const latestQuestion = useRef<any>(null),
    queue = useRef(Promise.resolve()),
    routeReady = useRef(false),
    intent = useRef(0);
  const scope = `/libraries/${library}`;
  const position = activeSet?.cursor ?? 0;
  // A question chat follows the set being practised; other chats keep their saved set.
  const chatSetId = (current: any) =>
    current.questionId && current.questionId === question?.id && activeSet
      ? activeSet.id
      : current.setId || undefined;
  const chatUrl = (current: any) =>
    `${scope}/chats/${current.id}${chatSetId(current) ? `?setId=${encodeURIComponent(chatSetId(current))}` : ""}`;
  const run = useCallback(async (action: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
      setSaveStatus("Not saved");
    } finally {
      setBusy(false);
    }
  }, []);
  const refresh = async () => {
    if (library) setOverview(await api(`${scope}/overview`));
  };
  /** Pull the configured folder into the library; errors block only that sync. */
  const syncMaterialRoot = async () => {
    const result = await api(`${scope}/imports/root-sync`, {});
    const errors = result.issues.filter((i: any) => i.severity === "error");
    if (errors.length)
      setError(
        `Folder not synced: ${errors.map((i: any) => `${i.path}:${i.line} ${i.message}`).join("; ")}`,
      );
  };
  const loadLibraries = async () => {
    const data = await api("/libraries");
    setLibraries(data.libraries);
    if (data.libraries.length) setLibrary(data.libraries[0].id);
  };
  const showImportPreview = (next: any) => {
    setImportPreview(next);
    setIdentityMappings({});
  };
  useEffect(() => {
    void run(async () => {
      const session = await api("/session");
      if (!session.authenticated) {
        setNeedsLogin(true);
        return;
      }
      await loadLibraries();
    });
  }, []);
  useEffect(() => {
    if (!library) return;
    void run(async () => {
      const { configured } = await api("/material-root");
      setMaterialRoot(configured);
      if (configured) await syncMaterialRoot();
      await refresh();
      await showHash();
      routeReady.current = true;
    });
  }, [library]);
  // Each view change becomes a browser history entry; Back/Forward replay them.
  useEffect(() => {
    if (!routeReady.current) return;
    const next = hashFor(page, page === "Practice" ? activeSet?.id : undefined);
    if (window.location.hash !== next) window.history.pushState(null, "", next);
  }, [page, activeSet?.id]);
  useEffect(() => {
    const onPopState = () => void run(showHash);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [library]);
  useEffect(() => {
    if (!library) return;
    void run(async () => {
      if (page === "Notes") setNotes((await api(`${scope}/notes`)).notes);
      if (page === "History") setChats((await api(`${scope}/chats`)).chats);
      if (page === "Settings" || page === "Ask AI" || page === "Practice")
        await Promise.all([
          api("/models").then(setSettings),
          page === "Settings" &&
            api(`${scope}/settings`).then(setLibrarySettings),
        ]);
    });
  }, [page, library]);
  const loadQuestion = async (set: any, index: number) => {
    const q = await api(
      `${scope}/questions/${set.questionIds[index]}?setId=${set.id}`,
    );
    latestQuestion.current = q;
    setQuestion(q);
    setDraft(q.setState.selection || "");
    setConfidence(q.setState.confidence || "sure");
    setSaveStatus("");
    // Reopen this question's saved tutor conversation, if any, below the question.
    const prior = (await api(`${scope}/chats`)).chats.find(
      (c: any) => c.questionId === q.id,
    );
    setChat(
      prior
        ? await api(
            `${scope}/chats/${prior.id}?setId=${encodeURIComponent(set.id)}`,
          )
        : null,
    );
  };
  /** Show the view named in the URL hash: a page, or an open practice set. */
  const showHash = async () => {
    const { page: target, setId } = parseHash(window.location.hash);
    if (setId) {
      try {
        await openSet(setId);
        return;
      } catch {
        // The set no longer exists; fall back to the practice home.
      }
    }
    setQuestion(null);
    setActiveSet(null);
    setPage(target);
  };
  const openSet = async (id: string) => {
    let set = await api(`${scope}/sets/${id}`);
    const firstOpen = set.itemStatuses.indexOf("unanswered");
    if (set.itemStatuses[set.cursor] !== "unanswered" && firstOpen >= 0)
      set = await api(
        `${scope}/sets/${id}`,
        {
          cursor: firstOpen,
          expectedVersion: set.version,
          operationId: operation(),
        },
        "PATCH",
      );
    setActiveSet(set);
    await loadQuestion(set, set.cursor || 0);
    setPage("Practice");
  };
  const submitted = Boolean(question?.setState?.submitted);
  const answer = (selection: string, conf = confidence) => {
    setDraft(selection);
    setConfidence(conf);
    setSaveStatus("Saving…");
    const currentIntent = ++intent.current;
    const setId = activeSet.id;
    const questionId = question.id;
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        try {
          const q = latestQuestion.current;
          if (q.id !== questionId) return;
          await api(`${scope}/questions/${questionId}/answer`, {
            operationId: operation(),
            expectedVersion: q.state?.version || 0,
            selection,
            confidence: conf,
            setId,
          });
          const updated = await api(
            `${scope}/questions/${questionId}?setId=${setId}`,
          );
          latestQuestion.current = updated;
          if (currentIntent === intent.current) {
            setQuestion(updated);
            setActiveSet((current: any) =>
              current?.id === setId
                ? {
                    ...current,
                    itemStatuses: current.itemStatuses.map(
                      (status: string, index: number) =>
                        current.questionIds[index] === questionId
                          ? updated.setState.status
                          : status,
                    ),
                  }
                : current,
            );
            setConfidence(updated.setState.confidence || "sure");
            setSaveStatus("Saved");
            await refresh();
          }
        } catch (e) {
          if (currentIntent === intent.current) {
            setSaveStatus("Not saved");
            setError(
              `${(e as Error).message}. Your selection remains visible. Reload the set to see the latest saved answer.`,
            );
          }
        }
      });
  };
  const navigate = async (index: number) => {
    await queue.current;
    if (index < 0 || index >= activeSet.questionIds.length) return;
    const updated = await api(
      `${scope}/sets/${activeSet.id}`,
      {
        cursor: index,
        expectedVersion: activeSet.version,
        operationId: operation(),
      },
      "PATCH",
    );
    setActiveSet(updated);
    await loadQuestion(updated, index);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) ||
        target.isContentEditable ||
        !question ||
        busy
      )
        return;
      if (event.key === "ArrowRight") void run(() => navigate(position + 1));
      if (event.key === "ArrowLeft") void run(() => navigate(position - 1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [question, position, activeSet, busy]);
  const annotation = async (values: any) => {
    setSaveStatus("Saving…");
    const result = await api(
      `${scope}/questions/${question.id}/annotation`,
      {
        ...values,
        operationId: operation(),
        expectedVersion: latestQuestion.current.annotation.version,
      },
      "PATCH",
    );
    const q = { ...latestQuestion.current, annotation: result };
    latestQuestion.current = q;
    setQuestion(q);
    setSaveStatus("Saved");
    await refresh();
  };
  /**
   * Open the practice set for one topic / source / chapter. The deck's set is reused while
   * it still holds every question (so its place is kept); "mistakes" is always rebuilt.
   */
  const openDeck = async (
    deck: { topic: string; source?: string; chapter?: string },
    total: number,
    review = false,
  ) => {
    const filters = {
      topic: deck.topic,
      source: deck.source ?? "",
      chapter: deck.chapter ?? "",
      statuses: review ? ["wrong", "unsure"] : [],
    };
    const existing =
      !review &&
      overview.sets.find(
        (s: any) =>
          s.count === total &&
          s.filters?.topic === filters.topic &&
          (s.filters?.source ?? "") === filters.source &&
          (s.filters?.chapter ?? "") === filters.chapter &&
          !s.filters?.statuses?.length &&
          !s.filters?.query &&
          !s.filters?.flagged,
      );
    if (existing) return openSet(existing.id);
    const set = await api(`${scope}/sets`, {
      operationId: operation(),
      title: [
        labelOf(deck.topic),
        deck.source && labelOf(deck.source),
        deck.chapter && chapterLabel(deck.chapter),
        review && "Mistakes",
      ]
        .filter(Boolean)
        .join(" · "),
      filters,
      order: "source",
    });
    await refresh();
    await openSet(set.id);
  };
  const createSet = async () => {
    const filters = { statuses, flagged, query, topic, source, chapter };
    // The same filters reopen their earlier set (and its place) instead of piling up copies.
    const existing =
      order === "source" &&
      overview.sets.find(
        (s: any) =>
          s.count === eligibleCount &&
          JSON.stringify(s.filters) === JSON.stringify(filters),
      );
    if (existing) return openSet(existing.id);
    const set = await api(`${scope}/sets`, {
      operationId: operation(),
      title:
        [
          topic && labelOf(topic),
          source && labelOf(source),
          chapter && chapterLabel(chapter),
          statuses.length && statuses.join(" + "),
        ]
          .filter(Boolean)
          .join(" · ") || "Practice set",
      filters,
      order,
      seed: Math.floor(Math.random() * 2147483647),
    });
    await refresh();
    await openSet(set.id);
  };
  // The server owns set selection, so the button count matches the set it builds.
  useEffect(() => {
    if (!library) return;
    const timer = setTimeout(() => {
      api(`${scope}/sets/preview`, {
        filters: { statuses, flagged, query, topic, source, chapter },
        order,
      })
        .then((result) => setEligibleCount(result.count))
        .catch(() => setEligibleCount(0));
    }, COUNT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    library,
    overview,
    statuses,
    flagged,
    query,
    order,
    topic,
    source,
    chapter,
  ]);
  // catalog rows -> [topic, [source, rows sorted by chapter][]][]
  const deckGroups: [string, [string, any[]][]][] = [];
  for (const row of overview.catalog ?? []) {
    let topicEntry = deckGroups.find(([t]) => t === row.topic);
    if (!topicEntry) deckGroups.push((topicEntry = [row.topic, []]));
    let sourceEntry = topicEntry[1].find(([src]) => src === row.source);
    if (!sourceEntry) topicEntry[1].push((sourceEntry = [row.source, []]));
    sourceEntry[1].push(row);
  }
  /** One progress line with Start/Continue and, when there are any, Mistakes. */
  const deckRow = (
    label: string,
    summary: ReturnType<typeof sumRows>,
    deck: { topic: string; source?: string; chapter?: string },
    strong = false,
  ) => {
    const mistakes = summary.wrong + summary.unsure;
    const share = (n: number) => `${(100 * n) / summary.total}%`;
    return (
      <div
        className={`deck-row${strong ? " strong" : ""}`}
        key={`${deck.source}:${deck.chapter ?? ""}`}
      >
        <span className="deck-label">{label}</span>
        <span className="deck-bar" aria-hidden="true">
          <span className="correct" style={{ width: share(summary.correct) }} />
          <span className="unsure" style={{ width: share(summary.unsure) }} />
          <span className="wrong" style={{ width: share(summary.wrong) }} />
        </span>
        <span className="deck-count">
          {summary.done}/{summary.total}
          {summary.done > 0 &&
            ` · ${Math.round((100 * summary.correct) / summary.done)}%`}
        </span>
        <span className="deck-actions">
          <button
            className={strong ? "" : "secondary"}
            disabled={busy}
            onClick={() => void run(() => openDeck(deck, summary.total))}
          >
            {summary.done === 0
              ? "Start"
              : summary.done < summary.total
                ? "Continue"
                : "Review"}
          </button>
          {mistakes > 0 && (
            <button
              className="quiet"
              disabled={busy}
              onClick={() => void run(() => openDeck(deck, mistakes, true))}
            >
              Mistakes {mistakes}
            </button>
          )}
        </span>
      </div>
    );
  };
  const tutorConversation = (
    <>
      {chat?.messages?.map((m: any) => (
        <article key={m.id} className={`message ${m.role}`}>
          <span className="eyebrow">
            {m.role === "assistant"
              ? "TUTOR"
              : m.role === "user"
                ? "YOU"
                : m.role}
          </span>
          <Markdown text={m.content || ""} />
          {m.sources?.length > 0 && (
            <div className="chips">
              {m.sources.map((source: any) => (
                <button
                  className="secondary"
                  key={source.id}
                  onClick={() =>
                    void run(async () =>
                      setCitation(
                        await api(
                          `${scope}/chats/${chat.id}/messages/${m.id}/sources/${source.id}`,
                        ),
                      ),
                    )
                  }
                >
                  {source.title || source.id}
                </button>
              ))}
            </div>
          )}
          {m.role === "assistant" && (
            <button
              className="quiet"
              onClick={() =>
                void run(async () => {
                  await api(
                    `${scope}/chats/${chat.id}/messages/${m.id}/save-note`,
                    {
                      title: chat.title,
                      operationId: operation(),
                    },
                  );
                  setSaveStatus("AI note saved");
                })
              }
            >
              Save as AI note
            </button>
          )}
        </article>
      ))}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            let current = chat;
            // Under a practice question the conversation belongs to that question.
            if (!current)
              current = await api(
                `${scope}/chats`,
                page === "Practice" && question
                  ? {
                      title: question.title,
                      kind: "question",
                      setId: activeSet.id,
                      questionId: question.id,
                    }
                  : { title: prompt.slice(0, 60), kind: "ask" },
              );
            setChat(current);
            const text = prompt;
            setPrompt("");
            try {
              const result = await api(
                `${scope}/chats/${current.id}/messages`,
                {
                  text,
                  model,
                  stream: true,
                  ...(chatSetId(current) ? { setId: chatSetId(current) } : {}),
                  operationId: operation(),
                },
              );
              if (result.run?.id) {
                setActiveRun(result.run.id);
                let state = result.run;
                while (state.status === "running") {
                  await new Promise((resolve) =>
                    setTimeout(resolve, RUN_POLL_MS),
                  );
                  state = await api(`${scope}/runs/${result.run.id}`);
                  setChat(await api(chatUrl(current)));
                }
                if (state.error)
                  setError(
                    typeof state.error === "string"
                      ? state.error
                      : state.error.message,
                  );
              }
            } finally {
              setActiveRun(null);
              setChat(await api(chatUrl(current)));
            }
          });
        }}
      >
        <label htmlFor="tutor-prompt">Your question</label>
        <label>
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {(settings?.models || [{ id: DEFAULT_MODEL, enabled: true }]).map(
              (entry: any) => (
                <option
                  key={entry.id}
                  disabled={!entry.enabled}
                  value={entry.id}
                >
                  {entry.id}
                  {!entry.enabled ? " · unavailable" : ""}
                </option>
              ),
            )}
          </select>
        </label>
        <textarea
          id="tutor-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="What would you like to understand?"
        />
        <div className="row">
          {/* The practice page already shows the save status above; avoid a second copy. */}
          <span role="status" className="muted">
            {busy ? "Working…" : page === "Practice" ? "" : saveStatus}
          </span>
          <button disabled={busy || !prompt.trim()}>Send</button>
          {activeRun && (
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void api(`${scope}/runs/${activeRun}/cancel`, {}).catch((e) =>
                  setError(e.message),
                )
              }
            >
              Stop
            </button>
          )}
        </div>
      </form>
    </>
  );
  return (
    <>
      <header>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("Practice");
          }}
        >
          ▦ <span>Study Ledger</span>
        </a>
        {libraries.length > 1 && (
          <select
            aria-label="Library"
            value={library}
            onChange={(e) => {
              setLibrary(e.target.value);
              setQuestion(null);
              setActiveSet(null);
            }}
          >
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
      </header>
      <nav aria-label="Main navigation">
        {pages
          .filter((p) => p !== "Materials" || !materialRoot)
          .map((p) => (
            <button
              className={page === p ? "active" : ""}
              key={p}
              onClick={() => setPage(p)}
            >
              {p}
            </button>
          ))}
      </nav>
      <main>
        {error && (
          <div role="alert" className="error">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {needsLogin && (
          <section className="panel">
            <h1>Sign in</h1>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await api("/session", { password });
                  setPassword("");
                  setNeedsLogin(false);
                  await loadLibraries();
                });
              }}
            >
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button disabled={busy || !password}>Sign in</button>
            </form>
          </section>
        )}
        {!library && !needsLogin && (
          <section className="panel">
            <h1>Your study library</h1>
            <p>Keep your material, practice, and notes together.</p>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const l = await api("/libraries", {
                    name: "My study library",
                  });
                  setLibraries([l]);
                  setLibrary(l.id);
                })
              }
            >
              Create library
            </button>
          </section>
        )}
        {library && page === "Practice" && !question && (
          <>
            <h1>Practice</h1>
            <div className="stats">
              {(["unanswered", "correct", "unsure", "wrong"] as const).map(
                (key) => (
                  <div key={key}>
                    <strong>{overview.counts[key] || 0}</strong>
                    <span>{key}</span>
                  </div>
                ),
              )}
            </div>
            {deckGroups.map(([deckTopic, sources]) => (
              <section className="panel deck" key={deckTopic}>
                <h2>{labelOf(deckTopic) || "Questions"}</h2>
                {sources.map(([deckSource, rows]) => (
                  <div className="deck-source" key={deckSource}>
                    {deckRow(
                      labelOf(deckSource),
                      sumRows(rows),
                      {
                        topic: deckTopic,
                        source: deckSource,
                      },
                      true,
                    )}
                    {rows.map((row) =>
                      deckRow(chapterLabel(row.chapter) || "No chapter", row, {
                        topic: deckTopic,
                        source: deckSource,
                        chapter: row.chapter,
                      }),
                    )}
                  </div>
                ))}
              </section>
            ))}
            {!overview.counts.total && (
              <p className="muted">
                No questions yet. Set MATERIAL_ROOT to your question-bank
                folder.
              </p>
            )}
            <details className="panel">
              <summary>Custom practice set</summary>
              <div className="filters">
                {(
                  [
                    ["Topic", topic, setTopic, "topic"],
                    ["Source", source, setSource, "source"],
                    ["Chapter", chapter, setChapter, "chapter"],
                  ] as const
                ).map(([label, value, setValue, field]) => {
                  // Each list narrows by the choices to its left.
                  const rows = (overview.catalog ?? []).filter(
                    (row: any) =>
                      (field === "topic" || !topic || row.topic === topic) &&
                      (field !== "chapter" || !source || row.source === source),
                  );
                  const options = new Map<
                    string,
                    { done: number; total: number }
                  >();
                  for (const row of rows) {
                    const entry = options.get(row[field]) ?? {
                      done: 0,
                      total: 0,
                    };
                    entry.done += row.done;
                    entry.total += row.total;
                    options.set(row[field], entry);
                  }
                  return (
                    <label key={field}>
                      {label}
                      <select
                        value={value}
                        onChange={(e) => {
                          setValue(e.target.value);
                          if (field === "topic") {
                            setSource("");
                            setChapter("");
                          }
                          if (field === "source") setChapter("");
                        }}
                      >
                        <option value="">All</option>
                        {[...options]
                          .sort(([a], [b]) => a.localeCompare(b))
                          .map(([option, count]) => (
                            <option key={option} value={option}>
                              {field === "chapter"
                                ? option.replace(/^Chapter\s+/i, "")
                                : labelOf(option)}{" "}
                              · {count.done}/{count.total}
                            </option>
                          ))}
                      </select>
                    </label>
                  );
                })}
              </div>
              <label>
                Search
                <input
                  placeholder="Search your library"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div className="chips">
                {["unanswered", "wrong", "unsure", "correct"].map((s) => (
                  <button
                    aria-pressed={statuses.includes(s)}
                    className={statuses.includes(s) ? "selected" : "secondary"}
                    key={s}
                    onClick={() =>
                      setStatuses(
                        statuses.includes(s)
                          ? statuses.filter((v) => v !== s)
                          : [...statuses, s],
                      )
                    }
                  >
                    {s}
                  </button>
                ))}
                <button className="quiet" onClick={() => setStatuses([])}>
                  All
                </button>
              </div>
              <div className="row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={flagged}
                    onChange={(e) => setFlagged(e.target.checked)}
                  />
                  Flagged only
                </label>
                <label>
                  Order
                  <select
                    value={order}
                    onChange={(e) => setOrder(e.target.value)}
                  >
                    <option value="source">Source order</option>
                    <option value="shuffle">Shuffle case groups</option>
                    <option value="older">Older answers first</option>
                  </select>
                </label>
              </div>
              <button
                disabled={busy || eligibleCount === 0}
                onClick={() => void run(() => createSet())}
              >
                Start practice · {eligibleCount} questions
              </button>
            </details>
          </>
        )}
        {library && page === "Practice" && question && (
          <>
            <button
              className="quiet"
              onClick={() => {
                setQuestion(null);
                setActiveSet(null);
              }}
            >
              ← Practice
            </button>
            <div className="row">
              <span className="eyebrow">{activeSet.title}</span>
              <span>
                {position + 1} / {activeSet.questionIds.length}
              </span>
            </div>
            <progress value={position + 1} max={activeSet.questionIds.length} />
            <div className="question-strip">
              {activeSet.questionIds.map((id: string, index: number) => (
                <button
                  key={id}
                  aria-label={`Question ${index + 1}`}
                  aria-current={index === position ? "step" : undefined}
                  className={`${index === position ? "selected" : "secondary"} ${activeSet.itemStatuses?.[index] ?? ""}`}
                  onClick={() => void run(() => navigate(index))}
                >
                  {index + 1}
                </button>
              ))}
            </div>
            <section className="panel question">
              <div className="row">
                <span className="muted">
                  {[
                    labelOf(question.topic),
                    labelOf(question.source),
                    chapterLabel(question.chapter),
                  ]
                    .filter(Boolean)
                    .join(" · ") || "Practice"}
                </span>
                <button
                  className="quiet"
                  aria-pressed={question.annotation.flagged}
                  onClick={() =>
                    void run(() =>
                      annotation({ flagged: !question.annotation.flagged }),
                    )
                  }
                >
                  {question.annotation.flagged ? "★ Flagged" : "☆ Flag"}
                </button>
              </div>
              {question.active === false ? (
                <h2>Source removed</h2>
              ) : (
                <>
                  <h1>{question.title}</h1>
                  {question.caseText && (
                    <details
                      open={caseOpen}
                      onToggle={(e) => setCaseOpen(e.currentTarget.open)}
                    >
                      <summary>Case passage</summary>
                      <Markdown text={question.caseText} />
                    </details>
                  )}
                  <Markdown text={question.stem || ""} />
                  <div className="choices">
                    {question.choices?.map((choice: any) => (
                      <button
                        key={choice.label}
                        className={`choice ${draft === choice.label ? "chosen" : ""}`}
                        aria-pressed={draft === choice.label}
                        onClick={() =>
                          submitted
                            ? answer(choice.label)
                            : setDraft(choice.label)
                        }
                      >
                        <span className="choice-label">{choice.label}</span>
                        <Markdown text={choice.text} />
                      </button>
                    ))}
                  </div>
                  {(!submitted || question.setState.status !== "wrong") && (
                    <fieldset>
                      <legend>Confidence</legend>
                      {["sure", "unsure"].map((c) => (
                        <label className="check" key={c}>
                          <input
                            type="radio"
                            name="confidence"
                            checked={confidence === c}
                            onChange={() =>
                              submitted ? answer(draft, c) : setConfidence(c)
                            }
                          />
                          {c === "sure" ? "Sure" : "Unsure"}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {!submitted && (
                    <button
                      disabled={!draft || busy}
                      onClick={() => answer(draft)}
                    >
                      Submit answer
                    </button>
                  )}
                  <span role="status" className="save-status">
                    {saveStatus}
                  </span>
                  {submitted && (
                    <div className={`result ${question.setState.status}`}>
                      <strong>{question.setState.status}</strong>
                      {question.state?.selection &&
                        question.state.selection !== draft && (
                          <p>
                            Latest overall answer: {question.state.selection}.
                            This set keeps its own saved answer.
                          </p>
                        )}
                      {question.answerKey && (
                        <p>Answer: {question.answerKey}</p>
                      )}
                      <Markdown
                        text={
                          question.solution ||
                          "No source solution is available."
                        }
                      />
                    </div>
                  )}
                </>
              )}
            </section>
            <div className="row">
              <button
                className="secondary"
                disabled={position === 0 || busy}
                onClick={() => void run(() => navigate(position - 1))}
              >
                ← Previous
              </button>
              <button
                disabled={position === activeSet.questionIds.length - 1 || busy}
                onClick={() => void run(() => navigate(position + 1))}
              >
                Next →
              </button>
            </div>
            <section className="panel tutor-inline">
              <h2>Ask AI</h2>
              {tutorConversation}
            </section>
          </>
        )}
        {library && page === "Materials" && (
          <>
            <h1>Materials</h1>
            <section className="panel">
              <h2>Import Markdown</h2>
              <label>
                Choose a file
                <input
                  type="file"
                  accept=".md,.markdown,text/markdown"
                  onChange={(e) =>
                    void run(async () => {
                      const selected = e.target.files?.[0];
                      if (selected) {
                        setImportPath(selected.name);
                        setImportContent(await selected.text());
                        showImportPreview(null);
                      }
                    })
                  }
                />
              </label>
              <label>
                File name
                <input
                  value={importPath}
                  onChange={(e) => {
                    setImportPath(e.target.value);
                    showImportPreview(null);
                  }}
                />
              </label>
              <label>
                Markdown source
                <textarea
                  rows={10}
                  value={importContent}
                  onChange={(e) => {
                    setImportContent(e.target.value);
                    showImportPreview(null);
                  }}
                  placeholder="Paste your question-bank Markdown"
                />
              </label>
              <button
                disabled={busy || !importContent.trim()}
                onClick={() =>
                  void run(async () =>
                    showImportPreview(
                      await api(`${scope}/imports/preview`, {
                        files: [
                          {
                            path: importPath,
                            content: importContent,
                            type: "questions",
                          },
                        ],
                      }),
                    ),
                  )
                }
              >
                Preview import
              </button>
              {importPreview && (
                <div className="import-result">
                  <h3>
                    {importPreview.counts?.questions || 0} questions found
                  </h3>
                  {importPreview.issues?.map((issue: any, index: number) => (
                    <p
                      key={index}
                      className={issue.severity === "error" ? "error" : "muted"}
                    >
                      {issue.path}:{issue.line} · {issue.message}
                    </p>
                  ))}
                  {importPreview.identityProposals
                    ?.filter(
                      (proposal: any) =>
                        !proposal.automatic && proposal.candidates.length > 0,
                    )
                    .map((proposal: any) => (
                      <label key={proposal.key}>
                        {proposal.title}: keep progress from an existing
                        question?
                        <select
                          value={
                            identityMappings[proposal.key] === null
                              ? "new"
                              : identityMappings[proposal.key] || ""
                          }
                          onChange={(event) => {
                            const { [proposal.key]: _previous, ...rest } =
                              identityMappings;
                            setIdentityMappings(
                              event.target.value === ""
                                ? rest
                                : {
                                    ...rest,
                                    [proposal.key]:
                                      event.target.value === "new"
                                        ? null
                                        : event.target.value,
                                  },
                            );
                          }}
                        >
                          <option value="">Automatic: new question</option>
                          <option value="new">Create a new question</option>
                          {proposal.candidates.map((candidate: any) => (
                            <option
                              key={candidate.id}
                              value={candidate.id}
                              disabled={!candidate.choicesCompatible}
                            >
                              {candidate.title}
                              {!candidate.choicesCompatible
                                ? " · choices changed"
                                : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  <button
                    disabled={busy || !importPreview.canCommit}
                    onClick={() =>
                      void run(async () => {
                        await api(
                          `${scope}/imports/${importPreview.id}/${importPreview.localRoot ? "root-commit" : "commit"}`,
                          { acceptWarnings: true, identityMappings },
                        );
                        showImportPreview(null);
                        setImportContent("");
                        await refresh();
                      })
                    }
                  >
                    Confirm import
                  </button>
                </div>
              )}
            </section>
          </>
        )}
        {library && page === "Notes" && (
          <>
            <div className="row">
              <h1>Notes</h1>
              <button
                className="secondary"
                onClick={() => setNoteDraft({ title: "", content: "" })}
              >
                New note
              </button>
            </div>
            {noteDraft && (
              <section className="panel">
                <label>
                  Title
                  <input
                    value={noteDraft.title}
                    onChange={(e) =>
                      setNoteDraft({ ...noteDraft, title: e.target.value })
                    }
                  />
                </label>
                <label>
                  Note (Markdown)
                  <textarea
                    rows={14}
                    value={noteDraft.content}
                    onChange={(e) =>
                      setNoteDraft({ ...noteDraft, content: e.target.value })
                    }
                  />
                </label>
                <div className="row">
                  <button
                    className="secondary"
                    onClick={() => setNoteDraft(null)}
                  >
                    Cancel
                  </button>
                  <button
                    disabled={busy || !noteDraft.content.trim()}
                    onClick={() =>
                      void run(async () => {
                        const body = {
                          title: noteDraft.title || "Study note",
                          content: noteDraft.content,
                          operationId: operation(),
                        };
                        await (noteDraft.id
                          ? api(
                              `${scope}/notes/${noteDraft.id}`,
                              { ...body, expectedHash: noteDraft.hash },
                              "PUT",
                            )
                          : api(`${scope}/notes`, body));
                        setNoteDraft(null);
                        setNotes((await api(`${scope}/notes`)).notes);
                      })
                    }
                  >
                    Save note
                  </button>
                </div>
              </section>
            )}
            {notes.length ? (
              notes.map((n) => (
                <details className="panel" key={n.id}>
                  <summary>
                    {n.title}
                    {n.provenance === "ai" ? " · AI-authored" : ""}
                  </summary>
                  <Markdown text={n.content} />
                  {n.provenance !== "ai" && (
                    <button className="quiet" onClick={() => setNoteDraft(n)}>
                      Edit
                    </button>
                  )}
                </details>
              ))
            ) : (
              <p className="muted">
                No notes yet. Tutor replies saved with "Save as AI note" also
                appear here.
              </p>
            )}
          </>
        )}
        {library && page === "Ask AI" && (
          <>
            <div className="row">
              <h1>Ask AI</h1>
              <button className="secondary" onClick={() => setChat(null)}>
                New conversation
              </button>
            </div>
            {!chat?.messages?.length && (
              <section className="panel">
                <h2>A place to work it through.</h2>
                <p>
                  Ask about your material or open the tutor from a practice
                  question.
                </p>
              </section>
            )}
            {tutorConversation}
          </>
        )}
        {library && page === "History" && (
          <>
            <h1>Conversation history</h1>
            {!chats.length ? (
              <section className="panel">
                <p>No conversations yet.</p>
              </section>
            ) : (
              chats.map((c) => (
                <button
                  className="list-card"
                  key={c.id}
                  onClick={() =>
                    void run(async () => {
                      setChat(await api(chatUrl(c)));
                      setPage("Ask AI");
                    })
                  }
                >
                  <strong>{c.title}</strong>
                  <span>Read →</span>
                </button>
              ))
            )}
          </>
        )}
        {library && page === "Settings" && (
          <>
            <h1>Settings</h1>
            {librarySettings && (
              <section className="panel">
                <h2>Library</h2>
                <label>
                  Choice labels (comma separated)
                  <input
                    defaultValue={(
                      librarySettings.settings?.choiceLabels || []
                    ).join(", ")}
                    placeholder="A, B, C"
                    onBlur={(event) =>
                      setLibrarySettings({
                        ...librarySettings,
                        settings: {
                          ...librarySettings.settings,
                          choiceLabels: event.target.value
                            .split(",")
                            .map((label) => label.trim())
                            .filter(Boolean),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Name
                  <input
                    value={librarySettings.name}
                    onChange={(e) =>
                      setLibrarySettings({
                        ...librarySettings,
                        name: e.target.value,
                      })
                    }
                  />
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={Boolean(librarySettings.archived)}
                    onChange={(e) =>
                      setLibrarySettings({
                        ...librarySettings,
                        archived: e.target.checked,
                      })
                    }
                  />
                  Archive library (read only)
                </label>
                <div className="row">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const saved = await api(
                          `${scope}/settings`,
                          {
                            operationId: operation(),
                            expectedVersion: librarySettings.version,
                            name: librarySettings.name,
                            archived: librarySettings.archived,
                            settings: librarySettings.settings,
                          },
                          "PATCH",
                        );
                        setLibrarySettings(saved);
                        setLibraries((await api("/libraries")).libraries);
                      })
                    }
                  >
                    Save library settings
                  </button>
                  <a href={`/api${scope}/export`} download="study-library.json">
                    Export study data
                  </a>
                </div>
              </section>
            )}
            <section className="panel">
              <h2>AI provider</h2>
              <p>
                {settings?.reason ||
                  "Provider availability is checked by the server. Study and editing work without AI."}
              </p>
              {(settings?.models || []).map((entry: any) => (
                <div className="model-status" key={entry.id}>
                  <strong>{entry.id}</strong>
                  <span className="badge">
                    {entry.enabled ? "Available" : "Unavailable"}
                  </span>
                  {entry.reason && <p className="muted">{entry.reason}</p>}
                </div>
              ))}
            </section>
            <section className="panel">
              <h2>Configured material folder</h2>
              <button
                disabled={busy || !materialRoot}
                onClick={() =>
                  void run(async () => {
                    await syncMaterialRoot();
                    await refresh();
                    setSaveStatus("Folder synced");
                  })
                }
              >
                Sync folder now
              </button>
            </section>
            <section className="panel">
              <h2>About your study data</h2>
              <p>
                Progress uses your latest saved answer for each question. Each
                practice set keeps its own answers and position.
              </p>
              <p>
                Source edits are checked against the file you opened. If another
                editor changed it, your draft stays here for reconciliation.
              </p>
            </section>
          </>
        )}
      </main>
      {citation && (
        <div
          className="citation-backdrop"
          role="presentation"
          onClick={() => setCitation(null)}
        >
          <section
            className="citation-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Source revision"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="secondary"
              autoFocus
              onClick={() => setCitation(null)}
            >
              Close source
            </button>
            <h2>{citation.source.title}</h2>
            <span className="badge">
              Saved source revision {citation.source.version}
            </span>
            {citation.record.caseText && (
              <Markdown text={citation.record.caseText} />
            )}
            <Markdown
              text={citation.record.content || citation.record.stem || ""}
            />
            {citation.record.choices?.map((choice: any) => (
              <div key={choice.label}>
                <strong>{choice.label}</strong>
                <Markdown text={choice.text} />
              </div>
            ))}
            {citation.record.solution && (
              <Markdown text={citation.record.solution} />
            )}
          </section>
        </div>
      )}
      <footer>
        Study Ledger <span>Personal research & learning</span>
      </footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
