import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, operation } from "./api";
import { Markdown } from "./Markdown";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import "./style.css";

const pages = [
  "Practice",
  "Progress",
  "Ask AI",
  "Materials",
  "History",
  "Settings",
] as const;
type Page = (typeof pages)[number];
const DEFAULT_MODEL = "gpt-6-luna";
/** Wait after the last filter change before asking the server for a count. */
const COUNT_DEBOUNCE_MS = 200;
const RUN_POLL_MS = 500;
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
    [note, setNote] = useState("");
  const [files, setFiles] = useState<any[]>([]),
    [file, setFile] = useState<any>(null),
    [content, setContent] = useState(""),
    [preview, setPreview] = useState(false),
    [importPreview, setImportPreview] = useState<any>(null),
    [importPath, setImportPath] = useState("questions.md"),
    [importContent, setImportContent] = useState(""),
    [focus, setFocus] = useState<any[]>([]),
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
    [caseOpen, setCaseOpen] = useState(true);
  const latestQuestion = useRef<any>(null),
    queue = useRef(Promise.resolve()),
    intent = useRef(0);
  const scope = `/libraries/${library}`;
  const position = activeSet?.cursor ?? 0;
  const chatSetId = (current: any) =>
    current.setId ||
    (current.kind === "question" && current.questionId === question?.id
      ? activeSet?.id
      : undefined);
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
  const loadLibraries = async () => {
    const data = await api("/libraries");
    setLibraries(data.libraries);
    if (data.libraries.length) setLibrary(data.libraries[0].id);
  };
  const loadFocus = async () => setFocus((await api(`${scope}/focus`)).items);
  const loadFiles = async () => setFiles((await api(`${scope}/files`)).files);
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
    if (library) void run(refresh);
  }, [library]);
  useEffect(() => {
    if (!library) return;
    void run(async () => {
      if (page === "Materials")
        await Promise.all([
          loadFiles(),
          api(`${scope}/notes`).then((data) => setNotes(data.notes)),
        ]);
      if (page === "Progress") await loadFocus();
      if (page === "History") setChats((await api(`${scope}/chats`)).chats);
      if (page === "Settings" || page === "Ask AI")
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
    setNote(q.annotation.note);
    setSaveStatus("");
  };
  const openSet = async (id: string) => {
    const set = await api(`${scope}/sets/${id}`);
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
  const createSet = async (inFocus = false) => {
    const set = await api(`${scope}/sets`, {
      operationId: operation(),
      title: inFocus
        ? "Focus practice"
        : statuses.length
          ? `${statuses.join(" + ")} practice`
          : "Practice set",
      filters: { statuses, flagged, inFocus, query },
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
        filters: { statuses, flagged, query },
        order,
      })
        .then((result) => setEligibleCount(result.count))
        .catch(() => setEligibleCount(0));
    }, COUNT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [library, overview, statuses, flagged, query, order]);
  const saveMaterial = async (acceptWarnings = false): Promise<void> => {
    try {
      const saved = await api(
        `${scope}/files/${file.id}${file.local ? "/local-save" : ""}`,
        {
          content,
          expectedHash: file.hash,
          operationId: operation(),
          acceptWarnings,
        },
        "PUT",
      );
      setFile(saved);
      setSaveStatus("Saved");
      await refresh();
    } catch (e) {
      const issues = (e as ApiError).current?.issues;
      if ((e as ApiError).code !== "IMPORT_ISSUES" || acceptWarnings || !issues)
        throw e;
      const list = issues
        .map((issue: any) => `Line ${issue.line}: ${issue.message}`)
        .join("\n");
      if (issues.some((issue: any) => issue.severity === "error"))
        throw new Error(`Fix these issues before saving:\n${list}`);
      if (window.confirm(`Save with these warnings?\n\n${list}`))
        await saveMaterial(true);
    }
  };
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
      </header>
      <nav aria-label="Main navigation">
        {pages.map((p) => (
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
            <div className="heading">
              <div>
                <span className="eyebrow">ONE QUESTION AT A TIME</span>
                <h1>Make room for understanding.</h1>
              </div>
            </div>
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
            <section className="panel">
              <h2>Build a practice set</h2>
              <label>
                Topic, source, or title
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
              {!overview.counts.total && (
                <p className="muted">
                  Import a Markdown question bank in Materials to begin.
                </p>
              )}
            </section>
            <section>
              <h2>Saved sets</h2>
              {!overview.sets?.length ? (
                <p className="muted">Your next session will be saved here.</p>
              ) : (
                overview.sets.map((s: any) => (
                  <button
                    className="list-card"
                    key={s.id}
                    onClick={() => void run(() => openSet(s.id))}
                  >
                    <span>
                      <strong>{s.title}</strong>
                      <small>
                        {s.count} questions · position {s.cursor + 1}
                      </small>
                    </span>
                    <span>Continue →</span>
                  </button>
                ))
              )}
            </section>
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
              ← All practice sets
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
                  className={index === position ? "selected" : "secondary"}
                  onClick={() => void run(() => navigate(index))}
                >
                  {index + 1}
                </button>
              ))}
            </div>
            <section className="panel question">
              <div className="row">
                <span className="muted">
                  {question.topic || question.source || "Practice"}
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
              <label>
                My note
                <textarea
                  rows={4}
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setSaveStatus("Unsaved changes");
                  }}
                  placeholder="Explain this in your own words…"
                />
              </label>
              <button
                className="secondary"
                onClick={() => void run(() => annotation({ note }))}
              >
                Save note
              </button>
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
            <button
              className="quiet"
              onClick={() =>
                void run(async () => {
                  setChat(
                    await api(`${scope}/chats`, {
                      title: question.title,
                      kind: "question",
                      setId: activeSet.id,
                      questionId: question.id,
                    }),
                  );
                  setPage("Ask AI");
                })
              }
            >
              Ask the tutor about this question →
            </button>
          </>
        )}
        {library && page === "Progress" && (
          <>
            <h1>Your progress</h1>
            <section className="panel">
              <h2>{overview.counts.total} questions in your library</h2>
              {Object.entries(overview.counts)
                .filter(([k]) => k !== "total")
                .map(([key, value]) => (
                  <div className="metric" key={key}>
                    <span>{key}</span>
                    <progress
                      value={Number(value)}
                      max={overview.counts.total || 1}
                    />
                    <strong>{String(value)}</strong>
                  </div>
                ))}
            </section>
            <div className="row">
              <h2>Focus</h2>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setFocus(
                      (
                        await api(`${scope}/focus/refresh`, {
                          operationId: operation(),
                        })
                      ).items,
                    );
                  })
                }
              >
                Refresh Focus
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const response = await api(`${scope}/focus/synthesize`, {
                      operationId: operation(),
                      model,
                    });
                    setFocus(response.items);
                    setSaveStatus(
                      `Focus considered ${response.coverage.considered} of ${response.coverage.eligible} eligible questions.`,
                    );
                  })
                }
              >
                Synthesize with AI
              </button>
            </div>
            <p role="status" className="muted">
              {saveStatus}
            </p>
            {!focus.length && (
              <div className="panel">
                <p>
                  No Focus items yet. Focus uses your current answers, flags,
                  notes, and questions.
                </p>
              </div>
            )}
            {focus.map((f) => (
              <article className="panel" key={f.id}>
                <h3>{f.title}</h3>
                <Markdown text={f.body} />
                <span className="badge">{f.stale ? "stale" : f.status}</span>
                <button
                  className="quiet"
                  onClick={() =>
                    void run(async () => {
                      await api(
                        `${scope}/focus/${f.id}`,
                        {
                          status: f.status === "resolved" ? "open" : "resolved",
                          operationId: operation(),
                          expectedVersion: f.version,
                        },
                        "PATCH",
                      );
                      await loadFocus();
                    })
                  }
                >
                  {f.status === "resolved" ? "Reopen" : "Resolve"}
                </button>
              </article>
            ))}
            <button
              disabled={busy || !focus.some((f) => f.status === "open")}
              onClick={() => void run(() => createSet(true))}
            >
              Practice these
            </button>
          </>
        )}
        {library && page === "Materials" && (
          <>
            <h1>Materials</h1>
            {file ? (
              <section className="panel">
                <div className="row">
                  <h2>{file.path}</h2>
                  <button className="quiet" onClick={() => setFile(null)}>
                    Close editor
                  </button>
                </div>
                <div className="chips">
                  <button
                    className={!preview ? "selected" : "secondary"}
                    onClick={() => setPreview(false)}
                  >
                    Edit
                  </button>
                  <button
                    className={preview ? "selected" : "secondary"}
                    onClick={() => setPreview(true)}
                  >
                    Preview
                  </button>
                </div>
                {preview ? (
                  <Markdown text={content} />
                ) : (
                  <CodeMirror
                    aria-label="Material source"
                    height="55vh"
                    extensions={[markdown()]}
                    value={content}
                    onChange={(value) => {
                      setContent(value);
                      setSaveStatus("Unsaved changes");
                    }}
                  />
                )}
                <button
                  disabled={busy}
                  onClick={() => void run(() => saveMaterial())}
                >
                  Save material
                </button>
                <span role="status" className="save-status">
                  {saveStatus}
                </span>
              </section>
            ) : (
              <>
                {files.map((f) => (
                  <button
                    className="list-card"
                    key={f.id}
                    onClick={() =>
                      void run(async () => {
                        const selected = await api(`${scope}/files/${f.id}`);
                        setFile(selected);
                        setContent(selected.content);
                        setPreview(false);
                        setSaveStatus("");
                      })
                    }
                  >
                    <strong>{f.path}</strong>
                    <span>Edit →</span>
                  </button>
                ))}
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
                      {importPreview.issues?.map(
                        (issue: any, index: number) => (
                          <p
                            key={index}
                            className={
                              issue.severity === "error" ? "error" : "muted"
                            }
                          >
                            {issue.path}:{issue.line} · {issue.message}
                          </p>
                        ),
                      )}
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
                              <option value="">
                                Automatic: new question
                              </option>
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
                            await loadFiles();
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
            <h2>AI notes</h2>
            {notes.length ? (
              notes.map((n) => (
                <details className="panel" key={n.id}>
                  <summary>{n.title} · AI-authored</summary>
                  <Markdown text={n.content} />
                </details>
              ))
            ) : (
              <p className="muted">
                Saved tutor replies will appear here, separate from your
                sources.
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
                  if (!current)
                    current = await api(`${scope}/chats`, {
                      title: prompt.slice(0, 60),
                      kind: "ask",
                    });
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
                        ...(chatSetId(current)
                          ? { setId: chatSetId(current) }
                          : {}),
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
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {(
                    settings?.models || [{ id: DEFAULT_MODEL, enabled: true }]
                  ).map((entry: any) => (
                    <option
                      key={entry.id}
                      disabled={!entry.enabled}
                      value={entry.id}
                    >
                      {entry.id}
                      {!entry.enabled ? " · unavailable" : ""}
                    </option>
                  ))}
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
                <span role="status" className="muted">
                  {busy ? "Working…" : saveStatus}
                </span>
                <button disabled={busy || !prompt.trim()}>Send</button>
                {activeRun && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void api(`${scope}/runs/${activeRun}/cancel`, {}).catch(
                        (e) => setError(e.message),
                      )
                    }
                  >
                    Stop
                  </button>
                )}
              </div>
            </form>
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
              <h2>Configured material root</h2>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    showImportPreview(
                      await api(`${scope}/imports/root-preview`, {}),
                    );
                    setPage("Materials");
                  })
                }
              >
                Preview files from configured root
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
