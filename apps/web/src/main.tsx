import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
/** One-click tutor requests behind the Hint and Explain buttons. */
const HINT_REQUEST =
  "Give me one hint for this question. Do not reveal the answer.";
const EXPLAIN_ANSWER_REQUEST =
  "Explain this question: the concept and LOS it tests, why the correct answer is right, and why each other choice is wrong, starting with the one I chose if it was wrong. Show any calculation.";
const STUDY_REVIEW_REQUEST =
  "Review my study. Use get_my_mistakes, get_my_questions and get_my_notes. Group my mistakes by chapter and the concept behind them, point out patterns (including what I keep asking about), and flag gaps or errors in my notes. Finish with a short plan: the 3 chapters to practise next, each with one concrete tip.";
const EXPLAIN_SECTION_REQUEST =
  "Explain this section in plain language: the key ideas, each formula with every symbol defined, and one short worked example with numbers.";
/** A bank solution's last line naming its source, e.g. "*Source: Qbank 2025, …*". */
const SOURCE_LINE = /\n?\s*\*Source:[^\n]*\*\s*$/;
/** A level-1 heading naming a CFA topic, and how many make a file "one topic per section". */
const CFA_TOPIC =
  /^(quantitative methods|economics|financial (statement analysis|reporting)|corporate (finance|issuers)|equity|.*fixed.income|derivatives|alternative investments|portfolio (management|construction)|ethic)/i;
const MIN_TOPIC_HEADINGS = 5;
/** A section with at most this many non-empty lines (a bare file title) joins the next. */
const NEAR_EMPTY_LINES = 3;
/** Reader sections shorter than this many lines are merged into the previous one. */
const MIN_SECTION_LINES = 150;
/** Base font sizes the A−/A+ buttons step through, in px. */
const FONT_SIZES = [14, 15, 17, 19, 21, 24];
const DEFAULT_FONT_SIZE = 17;
const THEMES = ["system", "light", "dark"] as const;
/** Per-viewer display settings; storage may be unavailable (private window). */
const loadPreference = <T,>(key: string, fallback: T): T => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
};
const savePreference = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Display settings simply reset next visit.
  }
};
/**
 * Split long Markdown into sections at # and ## headings (outside code fences), merging
 * short ones, so a 90,000-line file renders one readable piece at a time.
 * Returns [{ title, text }] in file order.
 */
function splitSections(text: string) {
  const lines = text.split("\n");
  const starts: { line: number; title: string; level: number }[] = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && /^(#{1,2})\s+(.*)/.exec(line);
    if (heading)
      starts.push({
        line: index,
        title: heading[2].replace(/[#*`$\\]/g, "").trim(),
        level: heading[1].length,
      });
  });
  // Whole-curriculum files (reviews, frameworks) have one level-1 heading per CFA
  // topic: then each topic is one section, and only a near-empty title is merged.
  const topLevel = starts.filter((start) => start.level === 1);
  if (
    topLevel.filter((start) => CFA_TOPIC.test(start.title)).length >=
    MIN_TOPIC_HEADINGS
  ) {
    const sections = topLevel.map((start, k) => ({
      title: start.title,
      start: k === 0 ? 0 : start.line,
      end: topLevel[k + 1]?.line ?? lines.length,
    }));
    const isNearEmpty = (section: { start: number; end: number }) =>
      lines.slice(section.start, section.end).filter((line) => line.trim())
        .length <= NEAR_EMPTY_LINES;
    if (sections.length > 1 && isNearEmpty(sections[0])) {
      sections[1].start = sections[0].start;
      sections.shift();
    }
    return sections.map((section) => ({
      title: section.title,
      text: lines.slice(section.start, section.end).join("\n"),
    }));
  }
  if (!starts.length || starts[0].line > 0)
    starts.unshift({ line: 0, title: "Start", level: 1 });
  const sections: { title: string; start: number; end: number }[] = [];
  starts.forEach((entry, k) => {
    const end = starts[k + 1]?.line ?? lines.length;
    const last = sections[sections.length - 1];
    if (last && last.end - last.start < MIN_SECTION_LINES) last.end = end;
    else sections.push({ title: entry.title, start: entry.line, end });
  });
  return sections.map((section) => ({
    title: section.title,
    text: lines.slice(section.start, section.end).join("\n"),
  }));
}
/** "Kaplan/schwesernotes-equity/notes.md" -> "schwesernotes-equity"; else the file name. */
const readingLabel = (path: string) => {
  const parts = path.split("/");
  const name = parts[parts.length - 1].replace(/\.md$/i, "");
  return name === "notes" && parts.length > 1 ? parts[parts.length - 2] : name;
};
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
      flagged: sum.flagged + row.flagged,
    }),
    { total: 0, done: 0, correct: 0, unsure: 0, wrong: 0, flagged: 0 },
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
    [noteDraft, setNoteDraft] = useState<any>(null),
    [notesView, setNotesView] = useState<"mine" | "ai">("mine");
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
    [activeRun, setActiveRun] = useState<string | null>(null),
    [needsLogin, setNeedsLogin] = useState(false),
    [password, setPassword] = useState(""),
    [identityMappings, setIdentityMappings] = useState<
      Record<string, string | null>
    >({}),
    [caseOpen, setCaseOpen] = useState(true),
    [materialRoot, setMaterialRoot] = useState(false),
    [readingFiles, setReadingFiles] = useState<string[] | null>([]),
    [readingPath, setReadingPath] = useState(""),
    [readingText, setReadingText] = useState(""),
    [readingSection, setReadingSection] = useState(0),
    [fontSize, setFontSize] = useState(() =>
      loadPreference("fontSize", DEFAULT_FONT_SIZE),
    ),
    [practiceSources, setPracticeSources] = useState<string[]>(() =>
      loadPreference("practiceSources", []),
    ),
    // null until the user folds a topic: every topic starts open.
    [openTopics, setOpenTopics] = useState<string[] | null>(() =>
      loadPreference<string[] | null>("openTopics", null),
    ),
    [theme, setTheme] = useState<(typeof THEMES)[number]>(() =>
      loadPreference("theme", "system"),
    );
  // Apply display settings to the whole page and remember them for this browser.
  useEffect(() => {
    document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
    savePreference("fontSize", fontSize);
  }, [fontSize]);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    savePreference("theme", theme);
  }, [theme]);
  const sections = useMemo(() => splitSections(readingText), [readingText]);
  /** Identifies a section's saved tutor chat: "3. Autocorrelation". */
  const sectionKey = `${readingSection + 1}. ${sections[readingSection]?.title ?? ""}`;
  // Reopen the saved tutor conversation for the open material section, if any.
  useEffect(() => {
    if (page !== "Materials" || !readingPath || !library) return;
    void run(async () => {
      const prior = (await api(`${scope}/chats`)).chats.find(
        (c: any) =>
          c.readingPath === readingPath && c.readingTitle === sectionKey,
      );
      setChat(prior ? await api(`${scope}/chats/${prior.id}`) : null);
    });
  }, [page, readingPath, sectionKey, library]);
  /** Open a reading file (read-only) at a section and remember the place. */
  const openReading = async (path: string, section = 0) => {
    const response = await fetch(
      `/api/reading/file?path=${encodeURIComponent(path)}`,
      { credentials: "same-origin" },
    );
    if (!response.ok) throw new Error(`Could not open ${path}.`);
    setReadingText(await response.text());
    setReadingPath(path);
    setReadingSection(section);
    savePreference("reading", { path, section });
  };
  const showSection = (section: number) => {
    setReadingSection(section);
    savePreference("reading", { path: readingPath, section });
    window.scrollTo({ top: 0 });
  };
  // The tutor model is a library setting chosen on the Settings page.
  const model = librarySettings?.settings?.model || DEFAULT_MODEL;
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
      setLibrarySettings(await api(`${scope}/settings`));
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
      if (page === "Materials") {
        const reading = await api("/reading");
        setReadingFiles(reading.configured ? reading.files : null);
        const last = loadPreference<{ path: string; section: number } | null>(
          "reading",
          null,
        );
        if (
          reading.configured &&
          last &&
          !readingPath &&
          reading.files.includes(last.path)
        )
          await openReading(last.path, last.section);
      }
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
    review: "" | "wrong" | "unsure" | "flagged" = "",
  ) => {
    const filters = {
      topic: deck.topic,
      source: deck.source ?? "",
      chapter: deck.chapter ?? "",
      statuses: review === "wrong" || review === "unsure" ? [review] : [],
      flagged: review === "flagged",
      sources: activeSources,
    };
    const existing =
      !review &&
      overview.sets.find(
        (s: any) =>
          s.count === total &&
          s.filters?.topic === filters.topic &&
          (s.filters?.source ?? "") === filters.source &&
          (s.filters?.chapter ?? "") === filters.chapter &&
          JSON.stringify(s.filters?.sources ?? []) ===
            JSON.stringify(filters.sources) &&
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
        review &&
          { wrong: "Mistakes", unsure: "Unsure", flagged: "Flagged" }[review],
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
  // Practice is by topic and chapter; sources are merged and only listed.
  // catalog rows (one per topic/source/chapter) -> [topic, [chapter, rows of each source][]][]
  const deckGroups: [string, [string, any[]][]][] = [];
  // Sources the user switched off on the Practice page are left out everywhere below.
  // practiceSources: [] means every source.
  const allSources: string[] = [
    ...new Set<string>((overview.catalog ?? []).map((row: any) => row.source)),
  ].sort();
  const activeSources = practiceSources.filter((name) =>
    allSources.includes(name),
  );
  const toggleSource = (name: string) => {
    const current = activeSources.length ? activeSources : allSources;
    const next = current.includes(name)
      ? current.filter((s) => s !== name)
      : [...current, name].sort();
    // At least one source stays on; all on is stored as "every source".
    if (!next.length) return;
    const stored = next.length === allSources.length ? [] : next;
    setPracticeSources(stored);
    savePreference("practiceSources", stored);
  };
  for (const row of (overview.catalog ?? []).filter(
    (row: any) => !activeSources.length || activeSources.includes(row.source),
  )) {
    let topicEntry = deckGroups.find(([t]) => t === row.topic);
    if (!topicEntry) deckGroups.push((topicEntry = [row.topic, []]));
    let chapterEntry = topicEntry[1].find(([c]) => c === row.chapter);
    if (!chapterEntry) topicEntry[1].push((chapterEntry = [row.chapter, []]));
    chapterEntry[1].push(row);
  }
  for (const [, chapters] of deckGroups)
    chapters.sort(([a], [b]) => a.localeCompare(b));
  /** One progress line with Start/Continue and, when there are any, Mistakes. */
  const deckRow = (
    label: string,
    summary: ReturnType<typeof sumRows>,
    deck: { topic: string; source?: string; chapter?: string },
    strong = false,
    note = "",
  ) => {
    // Unsure answers are correct; they get their own review instead of counting as mistakes.
    const share = (n: number) => `${(100 * n) / summary.total}%`;
    return (
      <div
        className={`deck-row${strong ? " strong" : ""}`}
        key={`${deck.source}:${deck.chapter ?? ""}`}
      >
        <span className="deck-label">
          {label}
          {note && <small className="muted">{note}</small>}
        </span>
        <span className="deck-bar" aria-hidden="true">
          <span className="correct" style={{ width: share(summary.correct) }} />
          <span className="unsure" style={{ width: share(summary.unsure) }} />
          <span className="wrong" style={{ width: share(summary.wrong) }} />
        </span>
        <span className="deck-count">
          {summary.done}/{summary.total}
          {summary.done > 0 &&
            ` · ${Math.round((100 * (summary.correct + summary.unsure)) / summary.done)}%`}
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
          {(
            [
              ["wrong", "Mistakes", summary.wrong],
              ["unsure", "Unsure", summary.unsure],
            ] as const
          ).map(
            ([review, label, count]) =>
              count > 0 && (
                <button
                  key={review}
                  className="quiet"
                  disabled={busy}
                  onClick={() => void run(() => openDeck(deck, count, review))}
                >
                  {label} {count}
                </button>
              ),
          )}
        </span>
      </div>
    );
  };
  /** Send one message to the tutor in the current place (question, section, or Ask AI). */
  const sendToTutor = (text: string, fresh = false) =>
    run(async () => {
      // fresh: start a new conversation instead of continuing the open one.
      let current = fresh ? null : chat;
      // Under a practice question or a material section, the conversation belongs there.
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
            : page === "Materials" && readingPath
              ? {
                  title: `${readingLabel(readingPath)} · ${sectionKey}`,
                  readingPath,
                  readingTitle: sectionKey,
                }
              : {
                  title:
                    text === STUDY_REVIEW_REQUEST
                      ? "Study review"
                      : text.slice(0, 60),
                  kind: "ask",
                },
        );
      setChat(current);
      setPrompt("");
      try {
        const result = await api(`${scope}/chats/${current.id}/messages`, {
          text,
          model,
          stream: true,
          // The open section is the tutor's context for a material chat.
          ...(current.readingPath
            ? { material: sections[readingSection]?.text ?? "" }
            : {}),
          ...(chatSetId(current) ? { setId: chatSetId(current) } : {}),
          operationId: operation(),
        });
        if (result.run?.id) {
          setActiveRun(result.run.id);
          let state = result.run;
          while (state.status === "running") {
            await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS));
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
  const tutorConversation = (
    <>
      {chat?.messages?.map((m: any) => (
        <article key={m.id} className={`message ${m.role}`}>
          {m.reasoning && (
            // The model's reasoning summary, folded away until asked for.
            <details className="reasoning">
              <summary>Reasoning</summary>
              <Markdown text={m.reasoning} />
            </details>
          )}
          <Markdown text={m.content || (m.status === "running" ? "…" : "")} />
          {/* The question you are on is not worth a citation chip. */}
          {m.sources?.some((source: any) => source.id !== chat.questionId) && (
            <div className="chips">
              {m.sources
                .filter((source: any) => source.id !== chat.questionId)
                .map((source: any) => (
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
          {m.role === "assistant" && m.status === "completed" && (
            <button
              className="quiet small"
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
          void sendToTutor(prompt);
        }}
      >
        <textarea
          aria-label="Message to the tutor"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          rows={2}
          placeholder={
            page === "Practice"
              ? "Ask about this question"
              : page === "Materials"
                ? "Ask about this section"
                : "Ask anything"
          }
        />
        <div className="composer-actions">
          {/* The practice page already shows the save status above; avoid a second copy. */}
          <span role="status" className="muted">
            {activeRun ? "Thinking…" : page === "Practice" ? "" : saveStatus}
          </span>
          {page === "Practice" && question && !submitted && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void sendToTutor(HINT_REQUEST)}
            >
              Hint
            </button>
          )}
          {((page === "Practice" && question && submitted) ||
            (page === "Materials" && readingPath)) && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void sendToTutor(
                  page === "Practice"
                    ? EXPLAIN_ANSWER_REQUEST
                    : EXPLAIN_SECTION_REQUEST,
                )
              }
            >
              Explain
            </button>
          )}
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
        <div className="header-tools">
          <button
            className="quiet"
            aria-label="Smaller text"
            disabled={fontSize <= FONT_SIZES[0]}
            onClick={() =>
              setFontSize(
                [...FONT_SIZES].reverse().find((size) => size < fontSize) ??
                  FONT_SIZES[0],
              )
            }
          >
            A−
          </button>
          <button
            className="quiet"
            aria-label="Larger text"
            disabled={fontSize >= FONT_SIZES[FONT_SIZES.length - 1]}
            onClick={() =>
              setFontSize(
                FONT_SIZES.find((size) => size > fontSize) ??
                  FONT_SIZES[FONT_SIZES.length - 1],
              )
            }
          >
            A+
          </button>
          <button
            className="quiet"
            aria-label={`Theme: ${theme}`}
            title="Switch theme: system, light, dark"
            onClick={() =>
              setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length])
            }
          >
            {theme === "dark"
              ? "☾ Dark"
              : theme === "light"
                ? "☀ Light"
                : "◐ Auto"}
          </button>
        </div>
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
            <div className="row">
              <h1>Practice</h1>
              {/* Flagged questions are few, so they get one central set across all topics. */}
              {sumRows(overview.catalog ?? []).flagged > 0 && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      openDeck(
                        { topic: "" },
                        sumRows(overview.catalog ?? []).flagged,
                        "flagged",
                      ),
                    )
                  }
                >
                  ★ Flagged {sumRows(overview.catalog ?? []).flagged}
                </button>
              )}
            </div>
            {allSources.length > 1 && (
              <div className="chips source-chips" aria-label="Sources">
                {allSources.map((name) => {
                  const on =
                    !activeSources.length || activeSources.includes(name);
                  return (
                    <button
                      key={name}
                      aria-pressed={on}
                      className={on ? "selected" : "secondary"}
                      onClick={() => toggleSource(name)}
                    >
                      {labelOf(name)}
                    </button>
                  );
                })}
              </div>
            )}
            {deckGroups.map(([deckTopic, chapters]) => {
              const topicSummary = sumRows(
                chapters.flatMap(([, rows]) => rows),
              );
              return (
                // Topics fold away; which ones are open is remembered in this browser.
                <details
                  className="panel deck"
                  key={deckTopic}
                  open={openTopics === null || openTopics.includes(deckTopic)}
                  onToggle={(e) => {
                    const isOpen = (e.currentTarget as HTMLDetailsElement).open;
                    const current = openTopics ?? deckGroups.map(([t]) => t);
                    if (isOpen === current.includes(deckTopic)) return;
                    const next = isOpen
                      ? [...current, deckTopic]
                      : current.filter((t) => t !== deckTopic);
                    setOpenTopics(next);
                    savePreference("openTopics", next);
                  }}
                >
                  <summary>
                    <h2>{labelOf(deckTopic) || "Questions"}</h2>
                    <span className="muted">
                      {topicSummary.done}/{topicSummary.total} answered
                    </span>
                  </summary>
                  {deckRow(
                    "All chapters",
                    sumRows(chapters.flatMap(([, rows]) => rows)),
                    { topic: deckTopic },
                    true,
                  )}
                  {chapters.map(([deckChapter, rows]) =>
                    deckRow(
                      chapterLabel(deckChapter) || "No chapter",
                      sumRows(rows),
                      { topic: deckTopic, chapter: deckChapter },
                      false,
                      rows.map((row: any) => labelOf(row.source)).join(" · "),
                    ),
                  )}
                </details>
              );
            })}
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
            {overview.catalog && !overview.counts.total && (
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
                        <p
                          title={
                            question.answerByAI
                              ? "AI-written answer, not from the source"
                              : undefined
                          }
                        >
                          Answer: {question.answerKey}
                        </p>
                      )}
                      <Markdown
                        text={
                          // The trailing "*Source: …*" line is for tracing, not for reading.
                          question.solution.replace(SOURCE_LINE, "").trim() ||
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
              {question.answerKey && draft && draft !== question.answerKey && (
                // A slip of the finger should not land in Mistakes.
                <button
                  className="quiet small"
                  disabled={busy}
                  onClick={() => answer(question.answerKey, "sure")}
                >
                  Misclicked
                </button>
              )}
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
            {readingFiles === null ? (
              <p className="muted">
                Set READING_ROOT in .env to a folder of Markdown study material
                to read it here.
              </p>
            ) : (
              <div className="reader">
                <aside className="reader-files">
                  {[...new Set(readingFiles.map((f) => f.split("/")[0]))].map(
                    (group) => (
                      <details
                        key={group}
                        open={readingPath.startsWith(`${group}/`)}
                      >
                        <summary>{group}</summary>
                        {readingFiles
                          .filter((f) => f.startsWith(`${group}/`))
                          .map((f) => (
                            <button
                              key={f}
                              className={
                                f === readingPath ? "selected" : "quiet"
                              }
                              onClick={() => void run(() => openReading(f))}
                            >
                              {readingLabel(f)}
                            </button>
                          ))}
                      </details>
                    ),
                  )}
                </aside>
                <article className="panel reader-body">
                  {readingPath ? (
                    <>
                      <div className="reader-nav">
                        <button
                          className="secondary"
                          disabled={readingSection === 0}
                          onClick={() => showSection(readingSection - 1)}
                        >
                          ←
                        </button>
                        <select
                          aria-label="Section"
                          value={readingSection}
                          onChange={(e) => showSection(Number(e.target.value))}
                        >
                          {sections.map((section, index) => (
                            <option key={index} value={index}>
                              {index + 1}/{sections.length} · {section.title}
                            </option>
                          ))}
                        </select>
                        <button
                          className="secondary"
                          disabled={readingSection >= sections.length - 1}
                          onClick={() => showSection(readingSection + 1)}
                        >
                          →
                        </button>
                      </div>
                      <Markdown
                        text={sections[readingSection]?.text ?? ""}
                        readingDirectory={readingPath
                          .split("/")
                          .slice(0, -1)
                          .join("/")}
                      />
                      <div className="reader-nav">
                        <button
                          className="secondary"
                          disabled={readingSection === 0}
                          onClick={() => showSection(readingSection - 1)}
                        >
                          ← Previous
                        </button>
                        <button
                          disabled={readingSection >= sections.length - 1}
                          onClick={() => showSection(readingSection + 1)}
                        >
                          Next section →
                        </button>
                      </div>
                      <section className="tutor-inline">
                        <h2>Ask AI about this section</h2>
                        {tutorConversation}
                      </section>
                    </>
                  ) : (
                    <p className="muted">
                      Choose a file to read. Files are read-only.
                    </p>
                  )}
                </article>
              </div>
            )}
            {!materialRoot && (
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
                        className={
                          issue.severity === "error" ? "error" : "muted"
                        }
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
            )}
          </>
        )}
        {library && page === "Notes" && (
          <>
            <div className="row">
              <h1>Notes</h1>
              <span className="deck-actions">
                <button
                  className="secondary"
                  onClick={() => {
                    setNotesView("mine");
                    setNoteDraft({ title: "", content: "" });
                  }}
                >
                  New note
                </button>
              </span>
            </div>
            <div className="chips">
              {(
                [
                  ["mine", "My notes"],
                  ["ai", "AI notes"],
                ] as const
              ).map(([view, label]) => (
                <button
                  key={view}
                  aria-pressed={notesView === view}
                  className={notesView === view ? "selected" : "secondary"}
                  onClick={() => setNotesView(view)}
                >
                  {label} ·{" "}
                  {
                    notes.filter(
                      (n) => (n.provenance === "ai") === (view === "ai"),
                    ).length
                  }
                </button>
              ))}
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
            {notes.some(
              (n) => (n.provenance === "ai") === (notesView === "ai"),
            ) ? (
              notes
                .filter((n) => (n.provenance === "ai") === (notesView === "ai"))
                .map((n) => (
                  <details className="panel" key={n.id}>
                    <summary>{n.title}</summary>
                    <Markdown text={n.content} />
                    <div className="row">
                      {n.provenance !== "ai" && (
                        <button
                          className="quiet"
                          onClick={() => setNoteDraft(n)}
                        >
                          Edit
                        </button>
                      )}
                      <button
                        className="quiet"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Delete "${n.title}"? This cannot be undone.`,
                            )
                          )
                            return;
                          void run(async () => {
                            await api(`${scope}/notes/${n.id}`, {}, "DELETE");
                            setNotes((await api(`${scope}/notes`)).notes);
                          });
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </details>
                ))
            ) : (
              <p className="muted">
                {notesView === "ai"
                  ? 'No AI notes yet. Use "Save as AI note" under a tutor reply.'
                  : "No notes yet."}
              </p>
            )}
          </>
        )}
        {library && page === "Ask AI" && (
          <>
            <div className="row">
              <h1>Ask AI</h1>
              <span className="deck-actions">
                <button
                  disabled={busy}
                  onClick={() => void sendToTutor(STUDY_REVIEW_REQUEST, true)}
                >
                  Review my study
                </button>
                <button className="secondary" onClick={() => setChat(null)}>
                  New conversation
                </button>
              </span>
            </div>
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
            <section className="panel">
              <h2>Export</h2>
              <div className="chips">
                <a href={`/api${scope}/export/notes?origin=mine`} download>
                  My notes (Markdown)
                </a>
                <a href={`/api${scope}/export/notes?origin=ai`} download>
                  AI notes (Markdown)
                </a>
                <a href={`/api${scope}/export/progress`} download>
                  Progress (CSV)
                </a>
              </div>
            </section>
            <section className="panel">
              <h2>AI model</h2>
              {settings?.reason && <p className="muted">{settings.reason}</p>}
              <select
                aria-label="AI model"
                value={model}
                disabled={busy || !librarySettings}
                onChange={(e) =>
                  void run(async () => {
                    setLibrarySettings(
                      await api(
                        `${scope}/settings`,
                        {
                          operationId: operation(),
                          expectedVersion: librarySettings.version,
                          settings: { model: e.target.value },
                        },
                        "PATCH",
                      ),
                    );
                  })
                }
              >
                {(settings?.models?.length
                  ? settings.models
                  : [{ id: model, name: model, enabled: true }]
                ).map((entry: any) => (
                  <option
                    key={entry.id}
                    value={entry.id}
                    disabled={!entry.enabled}
                  >
                    {entry.name}
                    {entry.enabled ? "" : " · not supported"}
                  </option>
                ))}
              </select>
              {(() => {
                // Thinking levels come from the chosen model; Codex's default is used until set.
                const entry = settings?.models?.find(
                  (m: any) => m.id === model,
                );
                const efforts: string[] = entry?.efforts ?? [];
                if (!efforts.length) return null;
                const effort = efforts.includes(
                  librarySettings?.settings?.effort,
                )
                  ? librarySettings.settings.effort
                  : (entry.defaultEffort ?? efforts[0]);
                return (
                  <label>
                    Thinking
                    <select
                      value={effort}
                      disabled={busy || !librarySettings}
                      onChange={(e) =>
                        void run(async () => {
                          setLibrarySettings(
                            await api(
                              `${scope}/settings`,
                              {
                                operationId: operation(),
                                expectedVersion: librarySettings.version,
                                settings: { effort: e.target.value },
                              },
                              "PATCH",
                            ),
                          );
                        })
                      }
                    >
                      {efforts.map((level) => (
                        <option key={level} value={level}>
                          {level === "xhigh" ? "Extra high" : labelOf(level)}
                          {level === entry.defaultEffort ? " (default)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })()}
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
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
