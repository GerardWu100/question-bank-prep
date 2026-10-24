import React, {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { AIProviderSettings } from "./AIProviderSettings";
import { api, ApiError, operation } from "./api";
// Markdown pulls in remark, KaTeX and its stylesheet: a separate chunk, loaded when a
// page first shows Markdown, so the Practice home starts without it.
const Markdown = lazy(() =>
  import("./Markdown").then((module) => ({ default: module.Markdown })),
);
/** The user guide (with the bank-building prompts) loads only when opened. */
const Guide = lazy(() => import("./Guide"));
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "./style.css";

const pages = [
  "Practice",
  "Materials",
  "Ask AI",
  "Notes",
  "History",
  "Settings",
  "Guide",
] as const;
type Page = (typeof pages)[number];
const DEFAULT_MODEL = "gpt-6.1-sol";
/** Wait after the last filter change before asking the server for a count. */
const COUNT_DEBOUNCE_MS = 200;
const RUN_POLL_MS = 500;
/** Poll interval while the tab is hidden: the reply keeps streaming on the server. */
const RUN_POLL_HIDDEN_MS = 3000;
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
/** Reopening a material file retries its saved scroll offset this often, for up to 2 s. */
const SCROLL_RESTORE_INTERVAL_MS = 100;
const SCROLL_RESTORE_ATTEMPTS = 20;
const THEMES = ["system", "light", "dark"] as const;
/**
 * Line width choices: label -> text column width in em (null = the whole window).
 * Inter averages about half an em per character, so 42em is about 75 characters a line.
 */
const PAGE_WIDTHS = {
  Full: null,
  Wide: 60,
  Medium: 50,
  Narrow: 42,
} as const;
type PageWidth = keyof typeof PAGE_WIDTHS;
/** Line spacing choices for notes, questions and replies: label -> CSS line-height. */
const LINE_SPACINGS = {
  Tight: 1.35,
  Normal: 1.5,
  Relaxed: 1.65,
  Loose: 1.8,
} as const;
type LineSpacing = keyof typeof LINE_SPACINGS;
/** The "Intuition (AI)" sub-heading that prompt 3 adds inside a solution. */
const INTUITION_HEADING = /^#{2,6}[ \t]+Intuition \(AI\)[ \t]*$/m;
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
/** "05-equity/qbank-2025.md" -> "05-equity": where a bank file's linked images live. */
const bankFolder = (path?: string | null) =>
  path == null ? undefined : path.split("/").slice(0, -1).join("/");
/** A solution with its "Intuition (AI)" part, if any, lifted into a callout above the
 * source text, so the short explanation is read first. */
function Solution({
  text,
  bankDirectory,
}: {
  text: string;
  bankDirectory?: string;
}) {
  const match = INTUITION_HEADING.exec(text);
  const source = (match ? text.slice(0, match.index) : text).trim();
  const intuition = match
    ? text.slice(match.index + match[0].length).trim()
    : "";
  return (
    <>
      {intuition && (
        <aside className="intuition">
          <span className="eyebrow">Intuition (AI)</span>
          <Markdown text={intuition} bankDirectory={bankDirectory} />
        </aside>
      )}
      {(source || !intuition) && (
        <Markdown
          text={source || "No source solution is available."}
          bankDirectory={bankDirectory}
        />
      )}
    </>
  );
}

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
/** Identifies a section's saved tutor chat (its readingTitle): "3. Autocorrelation". */
const sectionKeyOf = (sections: { title: string }[], index: number) =>
  `${index + 1}. ${sections[index]?.title ?? ""}`;
/** "Kaplan/schwesernotes-equity/notes.md" -> "schwesernotes-equity"; else the file name. */
const readingLabel = (path: string) => {
  const parts = path.split("/");
  const name = parts[parts.length - 1].replace(/\.md$/i, "");
  return name === "notes" && parts.length > 1 ? parts[parts.length - 2] : name;
};
/**
 * Numbered buttons for every question in a set. Memoized: with thousands of questions,
 * re-rendering them on each keystroke in the tutor box made typing lag.
 */
const QuestionStrip = memo(function QuestionStrip({
  questionIds,
  statuses,
  position,
  onPick,
}: {
  questionIds: string[];
  statuses?: string[];
  position: number;
  onPick: (index: number) => void;
}) {
  return (
    <div className="question-strip">
      {questionIds.map((id, index) => (
        <button
          key={id}
          aria-label={`Question ${index + 1}`}
          aria-current={index === position ? "step" : undefined}
          className={`${index === position ? "selected" : "secondary"} ${statuses?.[index] ?? ""}`}
          onClick={() => onPick(index)}
        >
          {index + 1}
        </button>
      ))}
    </div>
  );
});
/** A <details> whose body renders only after its first opening, so folded Markdown is not parsed. */
function LazyDetails({
  className,
  summary,
  children,
}: {
  className: string;
  summary: React.ReactNode;
  children: () => React.ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      className={className}
      onToggle={(event) => event.currentTarget.open && setOpened(true)}
    >
      <summary>{summary}</summary>
      {opened && children()}
    </details>
  );
}
/** A floating "Top" button, shown once the page is scrolled past one screen. */
function BackToTop() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > window.innerHeight);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return visible ? (
    <button
      className="back-to-top"
      aria-label="Back to top"
      onClick={() => window.scrollTo(0, 0)}
    >
      ↑ Top
    </button>
  ) : null;
}
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
/** History groups, in display order: where each tutor conversation was started. */
const CHAT_GROUPS = [
  { label: "Materials", matches: (c: any) => Boolean(c.readingPath) },
  {
    label: "Practice questions",
    matches: (c: any) => !c.readingPath && Boolean(c.questionId),
  },
  { label: "Ask AI", matches: (c: any) => !c.readingPath && !c.questionId },
];
/**
 * URL hash for a view, so refresh and the browser Back button keep the place.
 * `detail` is the open set on Practice ("#/practice/<setId>") or the open file and
 * section on Materials ("#/materials/<URL-encoded path>/<section number from 1>").
 */
const hashFor = (page: Page, detail?: string) =>
  `#/${page.toLowerCase().replace(/ /g, "-")}${detail ? `/${detail}` : ""}`;
const readingDetail = (path: string, section: number) =>
  `${encodeURIComponent(path)}/${section + 1}`;
const parseHash = (hash: string) => {
  const [slug, first, second] = hash.replace(/^#\/?/, "").split("/");
  const page = pages.find((p) => hashFor(p) === `#/${slug}`) ?? "Practice";
  let reading: { path: string; section: number } | undefined;
  if (page === "Materials" && first)
    try {
      reading = {
        path: decodeURIComponent(first),
        section: Math.max(0, (Number.parseInt(second, 10) || 1) - 1),
      };
    } catch {
      // A hand-edited, malformed path: show Materials without a file.
    }
  return { page, setId: page === "Practice" ? first : undefined, reading };
};
const blankCounts = {
  total: 0,
  correct: 0,
  wrong: 0,
  unsure: 0,
  unanswered: 0,
  ungradable: 0,
};
/** How many unmatched or ambiguous entries a study-progress import summary names. */
const IMPORT_SUMMARY_NAMES = 5;
/** "; 7 not found …: a, b, c, d, e …" for a non-empty list of import entries, else "". */
const namedEntries = (entries: string[], meaning: string) =>
  entries.length
    ? `; ${entries.length} ${meaning}: ${entries.slice(0, IMPORT_SUMMARY_NAMES).join(", ")}${entries.length > IMPORT_SUMMARY_NAMES ? " …" : ""}`
    : "";
/** Folder names that never hold a bank: version control and tool state. */
const SKIPPED_IMPORT_FOLDERS = new Set([".git", "node_modules"]);
/**
 * Read picked files into import entries, keeping only Markdown (README.md describes a
 * bank, so it is skipped). From a folder, `webkitRelativePath` is
 * "picked-folder/01-quant/qbank.md"; the picked folder's own name is dropped, so the
 * first remaining folder becomes the topic and the file name the source, as in a
 * configured question-bank folder.
 */
async function readMarkdownFiles(list: FileList | null) {
  const files = [...(list ?? [])].filter((file) => {
    const parts = (file.webkitRelativePath || file.name).split("/");
    return (
      /\.(md|markdown)$/i.test(file.name) &&
      file.name.toLowerCase() !== "readme.md" &&
      !parts.some((part) => SKIPPED_IMPORT_FOLDERS.has(part))
    );
  });
  const entries = await Promise.all(
    files.map(async (file) => ({
      path: file.webkitRelativePath
        ? file.webkitRelativePath.split("/").slice(1).join("/")
        : file.name,
      content: await file.text(),
    })),
  );
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
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
    [lastPracticeSetId, setLastPracticeSetId] = useState<string | null>(null),
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
    [notesView, setNotesView] = useState<"mine" | "ai">("mine"),
    // History shows "All" or one CHAT_GROUPS label; remembered so a long list stays short.
    [historyView, setHistoryView] = useState<string>(() =>
      loadPreference("historyView", "All"),
    ),
    // Settings → Practice: picking a choice saves it and shows the answer at once.
    [answerOnClick, setAnswerOnClick] = useState(() =>
      loadPreference("answerOnClick", false),
    );
  const [importPreview, setImportPreview] = useState<any>(null),
    // Markdown files picked for import: one file, or every .md file in a folder.
    [importFiles, setImportFiles] = useState<
      { path: string; content: string }[]
    >([]),
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
    // The open file, already split; the whole text is not kept a second time.
    [sections, setSections] = useState(() => splitSections("")),
    [readingSection, setReadingSection] = useState(0),
    // The material file read before the open one, for "↩ Back to".
    [previousReading, setPreviousReading] = useState<string | null>(null),
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
    ),
    [pageWidth, setPageWidth] = useState<PageWidth>(() => {
      const saved = loadPreference<string>("pageWidth", "Full");
      return saved in PAGE_WIDTHS ? (saved as PageWidth) : "Full";
    }),
    [lineSpacing, setLineSpacing] = useState<LineSpacing>(() => {
      const saved = loadPreference<string>("lineSpacing", "Normal");
      return saved in LINE_SPACINGS ? (saved as LineSpacing) : "Normal";
    });
  // Apply display settings to the whole page and remember them for this browser.
  useEffect(() => {
    document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
    savePreference("fontSize", fontSize);
  }, [fontSize]);
  useEffect(
    () => savePreference("answerOnClick", answerOnClick),
    [answerOnClick],
  );
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    savePreference("theme", theme);
  }, [theme]);
  useEffect(() => {
    const width = PAGE_WIDTHS[pageWidth];
    const style = document.documentElement.style;
    // The column plus the side gutters, so text width matches the chosen size.
    if (width === null) style.removeProperty("--page-width");
    else
      style.setProperty("--page-width", `calc(${width}em + 2 * var(--gutter))`);
    savePreference("pageWidth", pageWidth);
  }, [pageWidth]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--line-height",
      String(LINE_SPACINGS[lineSpacing]),
    );
    savePreference("lineSpacing", lineSpacing);
  }, [lineSpacing]);
  const sectionKey = sectionKeyOf(sections, readingSection);
  // Reopen the saved tutor conversation for the open material section, if any. The open
  // chat wins when it belongs here (a conversation continued from History or Notes).
  useEffect(() => {
    if (page !== "Materials" || !readingPath || !library) return;
    const belongsHere = (c: any) =>
      c.readingPath === readingPath && c.readingTitle === sectionKey;
    const openHere = chat && belongsHere(chat) ? chat.id : null;
    void run(async () => {
      const summaries = (await api(`${scope}/chats`)).chats;
      const prior =
        summaries.find((c: any) => c.id === openHere) ??
        summaries.find(belongsHere);
      setChat(prior ? await api(`${scope}/chats/${prior.id}`) : null);
    });
  }, [page, readingPath, sectionKey, library]);
  /**
   * Open a reading file (read-only) and remember the place. Without `section`, the file
   * opens where it was left this session (else at its first section). Leaving a file
   * records its section and scroll offset, and makes it the "Back to" file.
   * Returns the opened section's chat key ("3. Autocorrelation"), which can differ from
   * the requested section when the file was edited.
   */
  const openReading = async (path: string, section?: number) => {
    const left = readingPlace.current;
    if (left.path && left.path !== path) {
      readingSpots.current.set(left.path, {
        section: left.section,
        scrollY: window.scrollY,
      });
      setPreviousReading(left.path);
    }
    const spot = readingSpots.current.get(path);
    section ??= spot?.section ?? 0;
    const response = await fetch(
      `/api/reading/file?path=${encodeURIComponent(path)}`,
      { credentials: "same-origin" },
    );
    if (!response.ok) throw new Error(`Could not open ${path}.`);
    const split = splitSections(await response.text());
    // Edited material can have fewer sections than the saved bookmark.
    const sectionIndex = Number.isInteger(section)
      ? Math.max(0, Math.min(section, split.length - 1))
      : 0;
    setSections(split);
    setReadingPath(path);
    setReadingSection(sectionIndex);
    savePreference("reading", { path, section: sectionIndex });
    if (left.path !== path)
      pendingScroll.current =
        spot?.section === sectionIndex ? spot.scrollY : null;
    return sectionKeyOf(split, sectionIndex);
  };
  useEffect(() => {
    readingPlace.current = { path: readingPath, section: readingSection };
    const y = pendingScroll.current;
    if (y === null) return;
    pendingScroll.current = null;
    // Formulas, diagrams and pictures grow the section after it first renders, so retry
    // until the page is tall enough to reach the saved offset.
    let attempts = 0;
    const restore = () => {
      window.scrollTo({ top: y });
      if (
        Math.abs(window.scrollY - y) > 2 &&
        ++attempts < SCROLL_RESTORE_ATTEMPTS
      )
        window.setTimeout(restore, SCROLL_RESTORE_INTERVAL_MS);
    };
    requestAnimationFrame(restore);
  }, [readingPath, readingSection, sections]);
  const showSection = (section: number) => {
    setReadingSection(section);
    savePreference("reading", { path: readingPath, section });
    window.scrollTo({ top: 0 });
  };
  // The tutor model is a library setting chosen on the Settings page. When the AI
  // provider no longer offers it (for example after switching to an API key), the
  // provider's first usable model is used until another is chosen.
  const savedModel = librarySettings?.settings?.model;
  const usableModels: any[] =
    settings?.models?.filter((m: any) => m.enabled) ?? [];
  const model = usableModels.some((m) => m.id === savedModel)
    ? savedModel
    : (usableModels[0]?.id ?? savedModel ?? DEFAULT_MODEL);
  const latestQuestion = useRef<any>(null),
    queue = useRef(Promise.resolve()),
    routeReady = useRef(false),
    intent = useRef(0),
    // Each practice navigation (opening a set, moving in it, closing it, switching
    // library) takes the next number; a response for an older number is dropped, so a
    // slow question load cannot replace a newer one.
    navigationToken = useRef(0),
    // The newest record of the open set from the server. Cursor writes need its version
    // even when the navigation that received it was superseded and never shown.
    latestSet = useRef<any>(null),
    // Cursor writes run one at a time, so each sends the version the last one returned.
    cursorWrite = useRef<Promise<unknown>>(Promise.resolve()),
    // The open material file and section, read by handlers that outlive a render (Back).
    readingPlace = useRef({ path: "", section: 0 }),
    // Path → where each material file was left this session: { section, scrollY }.
    readingSpots = useRef(
      new Map<string, { section: number; scrollY: number }>(),
    ),
    // Scroll offset to restore once a reopened file has rendered.
    pendingScroll = useRef<number | null>(null);
  const scope = `/libraries/${library}`;
  const position = activeSet?.cursor ?? 0;
  // A question chat follows the set being practised; other chats keep their saved set.
  const chatSetId = (current: any) =>
    current.questionId && current.questionId === question?.id && activeSet
      ? activeSet.id
      : current.setId || undefined;
  const chatUrl = (current: any) =>
    `${scope}/chats/${current.id}${chatSetId(current) ? `?setId=${encodeURIComponent(chatSetId(current))}` : ""}`;
  // The chat on screen, so a reply still streaming for another chat does not replace it.
  const openChatId = useRef<string | null>(null);
  useEffect(() => {
    openChatId.current = chat?.id ?? null;
  }, [chat]);
  const showChatIfOpen = (fresh: any) => {
    if (openChatId.current === fresh.id) setChat(fresh);
  };
  const run = useCallback(async (action: () => Promise<unknown>) => {
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
    const savedLibrary = loadPreference<string | null>("library", null);
    if (data.libraries.length)
      setLibrary(
        data.libraries.find((entry: any) => entry.id === savedLibrary)?.id ??
          data.libraries[0].id,
      );
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
    savePreference("library", library);
    setLastPracticeSetId(
      loadPreference<string | null>(`lastPractice:${library}`, null),
    );
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
    const next = hashFor(
      page,
      page === "Practice"
        ? activeSet?.id
        : page === "Materials" && readingPath
          ? readingDetail(readingPath, readingSection)
          : undefined,
    );
    if (window.location.hash === next) return;
    const shown = parseHash(window.location.hash);
    // Turning sections in one file replaces the entry, so Back returns to the file read
    // before instead of stepping through sections. A new file gets its own entry.
    if (
      page === "Materials" &&
      shown.page === "Materials" &&
      (!shown.reading || shown.reading.path === readingPath)
    )
      window.history.replaceState(null, "", next);
    else window.history.pushState(null, "", next);
  }, [page, activeSet?.id, readingPath, readingSection]);
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
  // Notes starts its own conversation; returning to a question shows that question's chat.
  useEffect(() => {
    if (!library) return;
    if (page === "Notes" && (chat?.questionId || chat?.readingPath))
      setChat(null);
    if (page !== "Practice") return;
    const saved = latestSet.current;
    // A navigation dropped by leaving Practice may still have moved the saved cursor:
    // show the question the server (and Resume) now points at, with its chat.
    if (saved && activeSet?.id === saved.id && saved.cursor !== activeSet.cursor) {
      const token = beginNavigation();
      void run(() => loadQuestion(saved, saved.cursor, token));
      return;
    }
    if (question && chat?.questionId !== question.id) {
      const token = navigationToken.current;
      const questionId = question.id;
      void run(async () => {
        const prior = (await api(`${scope}/chats`)).chats.find(
          (c: any) => c.questionId === questionId,
        );
        const loaded = prior ? await api(chatUrl(prior)) : null;
        // A strip click while this loaded brings its own chat; keep that one.
        if (token === navigationToken.current) setChat(loaded);
      });
    }
  }, [page]);
  /** Start a practice navigation; responses for any earlier one are dropped from now on. */
  const beginNavigation = () => ++navigationToken.current;
  /** Close the open set (or leave it for another library); pending loads are dropped. */
  const closeSet = () => {
    beginNavigation();
    latestSet.current = null;
    setQuestion(null);
    setActiveSet(null);
  };
  // Leaving Practice drops a question still loading (its chat would land on the new
  // page); the question already shown stays for the return.
  useEffect(() => {
    if (page !== "Practice") beginNavigation();
  }, [page]);
  /**
   * Show question `index` of `set` with its saved tutor conversation. Everything is
   * fetched first and applied together, and only while `token` is still the newest
   * navigation, so the question, set position, answer draft and chat always agree.
   * Returns whether it was applied.
   */
  const loadQuestion = async (set: any, index: number, token: number) => {
    const questionId = set.questionIds[index];
    const [q, { chats: summaries }] = await Promise.all([
      api(`${scope}/questions/${questionId}?setId=${set.id}`),
      api(`${scope}/chats`),
    ]);
    // Reopen this question's saved tutor conversation, if any, below the question.
    const prior = summaries.find((c: any) => c.questionId === questionId);
    const priorChat = prior
      ? await api(
          `${scope}/chats/${prior.id}?setId=${encodeURIComponent(set.id)}`,
        )
      : null;
    if (token !== navigationToken.current) return false;
    latestQuestion.current = q;
    setActiveSet(set);
    setQuestion(q);
    setDraft(q.setState.selection || "");
    setConfidence(q.setState.confidence || "sure");
    setSaveStatus("");
    setChat(priorChat);
    // The set cursor lives on the server; remember only which set this browser last used.
    setLastPracticeSetId(set.id);
    savePreference(`lastPractice:${library}`, set.id);
    return true;
  };
  /** Show the view named in the URL hash: a page, or an open practice set. */
  const showHash = async () => {
    const { page: target, setId, reading } = parseHash(window.location.hash);
    if (setId) {
      try {
        await openSet(setId, { keepPosition: true });
        return;
      } catch {
        // The set no longer exists; fall back to the practice home.
      }
    }
    if (reading)
      try {
        await openReading(reading.path, reading.section);
      } catch {
        // The file was moved or deleted; show Materials without it.
      }
    closeSet();
    setPage(target);
  };
  const openSet = async (id: string, { keepPosition = false } = {}) => {
    const token = beginNavigation();
    let set = await api(`${scope}/sets/${encodeURIComponent(id)}`);
    const firstOpen = set.itemStatuses.indexOf("unanswered");
    if (
      !keepPosition &&
      set.itemStatuses[set.cursor] !== "unanswered" &&
      firstOpen >= 0
    )
      set = await api(
        `${scope}/sets/${encodeURIComponent(id)}`,
        {
          cursor: firstOpen,
          expectedVersion: set.version,
          operationId: operation(),
        },
        "PATCH",
      );
    if (token !== navigationToken.current) return;
    latestSet.current = set;
    if (await loadQuestion(set, set.cursor || 0, token)) setPage("Practice");
  };
  const resumableSet = overview.sets.find(
    (set: any) => set.id === lastPracticeSetId && set.count > 0,
  );
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
    const token = beginNavigation();
    // Pending answer saves, then the previous cursor write, finish first.
    await queue.current;
    await cursorWrite.current;
    // A newer click (or closing the set) won while waiting: skip this cursor write.
    const set = latestSet.current;
    if (token !== navigationToken.current || !set) return;
    if (index < 0 || index >= set.questionIds.length) return;
    const write = api(
      `${scope}/sets/${set.id}`,
      {
        cursor: index,
        expectedVersion: set.version,
        operationId: operation(),
      },
      "PATCH",
    );
    cursorWrite.current = write.then(
      (updated) => {
        // Versions only grow; another set may have been opened meanwhile.
        if (
          latestSet.current?.id === updated.id &&
          updated.version > latestSet.current.version
        )
          latestSet.current = updated;
      },
      () => {},
    );
    const updated = await write;
    if (token === navigationToken.current)
      await loadQuestion(updated, index, token);
  };
  // A stable click handler keeps QuestionStrip memoized; the ref sees the latest navigate.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const pickQuestion = useCallback(
    (index: number) => void run(() => navigateRef.current(index)),
    [run],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) ||
        target.isContentEditable ||
        page !== "Practice" ||
        !question ||
        busy
      )
        return;
      if (event.key === "ArrowRight") void run(() => navigate(position + 1));
      if (event.key === "ArrowLeft") void run(() => navigate(position - 1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [page, question, position, activeSet, busy]);
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
   * Open the practice set for one topic / source / chapter, or its Mistakes, Unsure or
   * Flagged review. The server reopens the deck's earlier set (and its place) only while
   * it holds exactly the questions the filters select now; otherwise it builds a new one.
   */
  const openDeck = async (
    deck: { topic: string; source?: string; chapter?: string },
    review: "" | "wrong" | "unsure" | "flagged" = "",
  ) => {
    const filters = {
      topic: deck.topic,
      source: deck.source ?? "",
      chapter: deck.chapter ?? "",
      statuses: review === "wrong" || review === "unsure" ? [review] : [],
      flagged: review === "flagged",
      // The top Flagged, Mistakes and Unsure sets (no topic) span every source, matching
      // the counts on their buttons, even when a source is switched off.
      sources: review && !deck.topic ? [] : activeSources,
    };
    const set = await api(`${scope}/sets`, {
      operationId: operation(),
      reuse: true,
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
    // The same questions in the same order reopen their earlier set (and its place)
    // instead of piling up copies; a new shuffle seed usually gives a new order.
    const set = await api(`${scope}/sets`, {
      operationId: operation(),
      reuse: true,
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
  // The count shows only on the Practice home, so an open question asks for none.
  const questionOpen = Boolean(question);
  useEffect(() => {
    if (!library || questionOpen) return;
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
    questionOpen,
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
            onClick={() => void run(() => openDeck(deck))}
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
                  onClick={() => void run(() => openDeck(deck, review))}
                >
                  {label} {count}
                </button>
              ),
          )}
        </span>
      </div>
    );
  };
  /** True when a reading chat's own section is not the one open on Materials. */
  const readingMissing = (current: any) =>
    Boolean(current?.readingPath) &&
    (current.readingPath !== readingPath || current.readingTitle !== sectionKey);
  // The open chat is a reading chat whose section is not loaded: it cannot be continued,
  // because its material would be another section's text.
  const chatMaterialMissing = readingMissing(chat);
  /**
   * Continue a saved conversation (from History or a saved AI note) where it belongs. A
   * reading chat first reopens its own file and section on Materials, so the next reply
   * carries that section's text. When that section is gone (file removed, or edited so
   * the numbered heading no longer matches), the chat opens on `otherPage` marked as
   * missing its material. Other chats open on `otherPage`. Returns the page shown.
   */
  const continueChat = async (summary: any, otherPage: Page) => {
    const saved = await api(chatUrl(summary));
    if (saved.readingPath) {
      const openedKey = await openReading(
        saved.readingPath,
        Number.parseInt(saved.readingTitle, 10) - 1,
      ).catch(() => null);
      if (openedKey === saved.readingTitle) {
        setChat(saved);
        setPage("Materials");
        return "Materials";
      }
    }
    setChat(saved);
    setPage(otherPage);
    return otherPage;
  };
  /** Send one message to the tutor in the current place (question, section, or Ask AI). */
  const sendToTutor = (text: string, fresh = false) =>
    run(async () => {
      // fresh: start a new conversation instead of continuing the open one.
      let current = fresh ? null : chat;
      if (readingMissing(current))
        throw new Error(
          `Open "${current.readingTitle}" in ${current.readingPath} on Materials to continue this conversation.`,
        );
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
          // The open section is the tutor's context for a material chat; readingMissing
          // above made sure it is this chat's own section.
          ...(current.readingPath
            ? { material: sections[readingSection]?.text ?? "" }
            : {}),
          ...(chatSetId(current) ? { setId: chatSetId(current) } : {}),
          operationId: operation(),
        });
        if (result.run?.id) {
          setActiveRun(result.run.id);
          // The chat holds the reply's status and error: one request per tick.
          let reply: any = result.run;
          while (reply.status === "running") {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                document.hidden ? RUN_POLL_HIDDEN_MS : RUN_POLL_MS,
              ),
            );
            const fresh = await api(chatUrl(current));
            showChatIfOpen(fresh);
            reply =
              fresh.messages?.find((m: any) => m.id === result.run.id) ??
              (await api(`${scope}/runs/${result.run.id}`));
          }
          if (reply.error)
            setError(
              typeof reply.error === "string"
                ? reply.error
                : reply.error.message,
            );
        }
      } finally {
        setActiveRun(null);
        showChatIfOpen(await api(chatUrl(current)));
      }
    });
  const tutorConversation = (
    <>
      {chat?.messages?.map((m: any) => (
        <article key={m.id} className={`message ${m.role}`}>
          {m.reasoning && (
            // The model's reasoning summary, folded away until asked for.
            <LazyDetails className="reasoning" summary="Reasoning">
              {() => <Markdown text={m.reasoning} />}
            </LazyDetails>
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
      {/* On Materials a mismatch only lasts until the section's own chat loads. */}
      {chatMaterialMissing && page !== "Materials" && (
        <p className="muted" role="note">
          This conversation is about “{chat.readingTitle}” in{" "}
          {chat.readingPath}, which is not open (it may have been moved or
          edited), so the tutor cannot see its text. Start a new conversation
          from that section on Materials.
        </p>
      )}
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
              disabled={busy || chatMaterialMissing}
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
          <button disabled={busy || !prompt.trim() || chatMaterialMissing}>
            Send
          </button>
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
      <nav aria-label="Main navigation">
        {pages.map((p) => (
          <button
            className={page === p ? "active" : ""}
            key={p}
            onClick={() => {
              // Practice again while a question is open: back to the topic list.
              if (p === "Practice" && page === "Practice") closeSet();
              setPage(p);
            }}
          >
            {p}
          </button>
        ))}
        {libraries.length > 1 && (
          <select
            aria-label="Library"
            value={library}
            onChange={(e) => {
              setLibrary(e.target.value);
              setLastPracticeSetId(null);
              closeSet();
            }}
          >
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
      </nav>
      <main>
        {/* Markdown loads as its own chunk; until then its places stay empty. */}
        <Suspense fallback={null}>
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
              <div className="row practice-heading">
                <h1>Practice</h1>
                <div className="practice-actions">
                  <button
                    disabled={busy || !resumableSet}
                    title={
                      resumableSet
                        ? resumableSet.title
                        : "Start a practice set to enable Resume"
                    }
                    onClick={() =>
                      void run(() =>
                        openSet(resumableSet.id, { keepPosition: true }),
                      )
                    }
                  >
                    Resume last session
                  </button>
                  {/* Flagged questions are few, so their set spans every topic. */}
                  {sumRows(overview.catalog ?? []).flagged > 0 && (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(() => openDeck({ topic: "" }, "flagged"))
                      }
                    >
                      ★ Flagged {sumRows(overview.catalog ?? []).flagged}
                    </button>
                  )}
                  {(
                    [
                      ["wrong", "✗ Mistakes"],
                      ["unsure", "? Unsure"],
                    ] as const
                  ).map(
                    ([review, label]) =>
                      (overview.counts[review] || 0) > 0 && (
                        <button
                          key={review}
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            void run(() => openDeck({ topic: "" }, review))
                          }
                        >
                          {label} {overview.counts[review]}
                        </button>
                      ),
                  )}
                </div>
              </div>
              {allSources.length > 1 && (
                <div
                  className="chips source-chips practice-sources"
                  aria-label="Sources"
                >
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
                      const isOpen = (e.currentTarget as HTMLDetailsElement)
                        .open;
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
              {overview.catalog && !overview.counts.total && (
                <p className="muted">
                  No questions yet. Choose a question-bank folder (desktop app:
                  File → Question-bank folder; server: MATERIAL_ROOT), or import
                  a Markdown bank on Materials.
                </p>
              )}
              <details className="panel practice-custom">
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
                        (field !== "chapter" ||
                          !source ||
                          row.source === source),
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
                      className={
                        statuses.includes(s) ? "selected" : "secondary"
                      }
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
            </>
          )}
          {library && page === "Practice" && question && (
            <>
              {/* Stays at the top while scrolling, so Next is never a scroll away. */}
              <div className="question-nav">
                <button
                  className="secondary"
                  disabled={position === 0 || busy}
                  onClick={() => void run(() => navigate(position - 1))}
                >
                  ← Previous
                </button>
                <span className="muted">
                  {position + 1} / {activeSet.questionIds.length}
                </span>
                <span className="question-nav-end">
                  {question.answerKey &&
                    draft &&
                    submitted &&
                    draft !== question.answerKey && (
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
                    disabled={
                      position === activeSet.questionIds.length - 1 || busy
                    }
                    onClick={() => void run(() => navigate(position + 1))}
                  >
                    Next →
                  </button>
                </span>
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
                        {caseOpen && (
                          <Markdown
                            text={question.caseText}
                            bankDirectory={bankFolder(question.path)}
                          />
                        )}
                      </details>
                    )}
                    <Markdown
                      text={question.stem || ""}
                      bankDirectory={bankFolder(question.path)}
                    />
                    <div className="choices">
                      {question.choices?.map((choice: any) => (
                        <button
                          key={choice.label}
                          className={`choice ${draft === choice.label ? "chosen" : ""}`}
                          aria-pressed={draft === choice.label}
                          onClick={() =>
                            submitted || answerOnClick
                              ? answer(choice.label)
                              : setDraft(choice.label)
                          }
                        >
                          <span className="choice-label">{choice.label}</span>
                          <Markdown
                            text={choice.text}
                            bankDirectory={bankFolder(question.path)}
                          />
                        </button>
                      ))}
                    </div>
                    <div className="answer-row">
                      {(!submitted || question.setState.status !== "wrong") && (
                        <span role="radiogroup" aria-label="Confidence">
                          {["sure", "unsure"].map((c) => (
                            <label className="check" key={c}>
                              <input
                                type="radio"
                                name="confidence"
                                checked={confidence === c}
                                onChange={() =>
                                  submitted
                                    ? answer(draft, c)
                                    : setConfidence(c)
                                }
                              />
                              {c === "sure" ? "Sure" : "Unsure"}
                            </label>
                          ))}
                        </span>
                      )}
                      {!submitted && !answerOnClick && (
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
                    </div>
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
                        <Solution
                          // The trailing "*Source: …*" line is for tracing, not for reading.
                          text={question.solution
                            .replace(SOURCE_LINE, "")
                            .trim()}
                          bankDirectory={bankFolder(question.path)}
                        />
                      </div>
                    )}
                  </>
                )}
              </section>
              {/* Where you are in the set, kept below the question so it does not distract. */}
              <div className="set-progress">
                <span className="eyebrow">{activeSet.title}</span>
                <progress
                  value={position + 1}
                  max={activeSet.questionIds.length}
                />
                <QuestionStrip
                  questionIds={activeSet.questionIds}
                  statuses={activeSet.itemStatuses}
                  position={position}
                  onPick={pickQuestion}
                />
              </div>
              <section className="panel tutor-inline">
                <h2>Ask AI</h2>
                {tutorConversation}
              </section>
              <button
                className="secondary"
                onClick={closeSet}
              >
                ← Back to Practice
              </button>
            </>
          )}
          {library && page === "Materials" && (
            <>
              {readingFiles === null ? (
                <p className="muted">
                  Set READING_ROOT in .env to a folder of Markdown study
                  material to read it here.
                </p>
              ) : (
                <div className="reader">
                  <aside className="reader-files">
                    {[
                      ...new Set(
                        readingFiles.map((f) =>
                          f.includes("/") ? f.split("/")[0] : "",
                        ),
                      ),
                    ].map((group) => (
                      <details
                        key={group}
                        open={!group || readingPath.startsWith(`${group}/`)}
                      >
                        <summary>{group || "General"}</summary>
                        {readingFiles
                          .filter((f) =>
                            group
                              ? f.startsWith(`${group}/`)
                              : !f.includes("/"),
                          )
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
                    ))}
                  </aside>
                  <article className="panel reader-body">
                    {readingPath ? (
                      <>
                        {previousReading && previousReading !== readingPath && (
                          <button
                            className="quiet small reader-return"
                            disabled={busy}
                            title="Return to the file you read before, where you left it"
                            onClick={() =>
                              void run(() => openReading(previousReading))
                            }
                          >
                            ↩ Back to {readingLabel(previousReading)}
                          </button>
                        )}
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
                            onChange={(e) =>
                              showSection(Number(e.target.value))
                            }
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
                  <div className="chips">
                    <label className="secondary file-button">
                      Choose a folder
                      <input
                        type="file"
                        multiple
                        // Non-standard but supported by Chrome, Edge, Firefox, Safari and Electron.
                        {...({ webkitdirectory: "" } as any)}
                        onChange={(e) => {
                          const input = e.target;
                          void run(async () => {
                            setImportFiles(
                              await readMarkdownFiles(input.files),
                            );
                            input.value = "";
                            showImportPreview(null);
                          });
                        }}
                      />
                    </label>
                    <label className="secondary file-button">
                      Choose a file
                      <input
                        type="file"
                        accept=".md,.markdown,text/markdown"
                        onChange={(e) => {
                          const input = e.target;
                          void run(async () => {
                            setImportFiles(
                              await readMarkdownFiles(input.files),
                            );
                            input.value = "";
                            showImportPreview(null);
                          });
                        }}
                      />
                    </label>
                  </div>
                  {importFiles.length > 0 && (
                    <p className="muted">
                      {importFiles.length} Markdown file
                      {importFiles.length === 1 ? "" : "s"}:{" "}
                      {importFiles
                        .slice(0, 8)
                        .map((file) => file.path)
                        .join(", ")}
                      {importFiles.length > 8 ? " …" : ""}
                    </p>
                  )}
                  <button
                    disabled={busy || !importFiles.length}
                    onClick={() =>
                      void run(async () =>
                        showImportPreview(
                          await api(`${scope}/imports/preview`, {
                            files: importFiles.map((file) => ({
                              ...file,
                              type: "questions",
                            })),
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
                            !proposal.automatic &&
                            proposal.candidates.length > 0,
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
                            setImportFiles([]);
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
              {notesView === "ai" && (
                <section className="panel tutor-inline" id="notes-chat">
                  <div className="row">
                    <h2>Ask AI</h2>
                    <button className="secondary" onClick={() => setChat(null)}>
                      New conversation
                    </button>
                  </div>
                  {tutorConversation}
                </section>
              )}
              {notes.some(
                (n) => (n.provenance === "ai") === (notesView === "ai"),
              ) ? (
                notes
                  .filter(
                    (n) => (n.provenance === "ai") === (notesView === "ai"),
                  )
                  .map((n) => (
                    <LazyDetails
                      className="panel note-card"
                      key={n.id}
                      summary={
                        <>
                          <span>{n.title}</span>
                          <button
                            className="quiet small note-delete"
                            disabled={busy}
                            onClick={(event) => {
                              // A button inside <summary> must not also fold the card.
                              event.preventDefault();
                              if (
                                !window.confirm(
                                  `Delete "${n.title}"? This cannot be undone.`,
                                )
                              )
                                return;
                              void run(async () => {
                                await api(
                                  `${scope}/notes/${n.id}`,
                                  {},
                                  "DELETE",
                                );
                                setNotes((await api(`${scope}/notes`)).notes);
                              });
                            }}
                          >
                            Delete
                          </button>
                        </>
                      }
                    >
                      {() => (
                        <>
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
                            {n.provenance === "ai" && n.chatId && (
                              <button
                                className="quiet"
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    // A reading chat continues on its own section in Materials.
                                    if (
                                      (await continueChat(
                                        { id: n.chatId },
                                        "Notes",
                                      )) === "Notes"
                                    )
                                      document
                                        .getElementById("notes-chat")
                                        ?.scrollIntoView({ behavior: "smooth" });
                                  })
                                }
                              >
                                Continue this chat
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </LazyDetails>
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
          {library &&
            page === "History" &&
            (() => {
              // An unknown saved view (a renamed group) falls back to All.
              const view = CHAT_GROUPS.some((g) => g.label === historyView)
                ? historyView
                : "All";
              const shownGroups = CHAT_GROUPS.filter(
                (g) => view === "All" || g.label === view,
              );
              const shown = chats.filter((c) =>
                shownGroups.some((g) => g.matches(c)),
              );
              return (
                <>
                  <h1>Conversation history</h1>
                  <div className="chips">
                    {["All", ...CHAT_GROUPS.map((g) => g.label)].map(
                      (label) => (
                        <button
                          key={label}
                          aria-pressed={view === label}
                          className={view === label ? "selected" : "secondary"}
                          onClick={() => {
                            setHistoryView(label);
                            savePreference("historyView", label);
                          }}
                        >
                          {label} ·{" "}
                          {label === "All"
                            ? chats.length
                            : chats.filter(
                                CHAT_GROUPS.find((g) => g.label === label)!
                                  .matches,
                              ).length}
                        </button>
                      ),
                    )}
                  </div>
                  {!shown.length ? (
                    <section className="panel">
                      <p>No conversations yet.</p>
                    </section>
                  ) : (
                    shownGroups.map((group) => {
                      const inGroup = chats.filter(group.matches);
                      return (
                        inGroup.length > 0 && (
                          <section className="history-group" key={group.label}>
                            {view === "All" && (
                              <h2>
                                {group.label}{" "}
                                <span className="muted">{inGroup.length}</span>
                              </h2>
                            )}
                            {inGroup.map((c) => (
                              <div className="history-row" key={c.id}>
                                <button
                                  className="list-card"
                                  onClick={() =>
                                    // A reading reply must carry its own section, even when opened from History.
                                    void run(() => continueChat(c, "Ask AI"))
                                  }
                                >
                                  <strong>{c.title}</strong>
                                  <span>Read →</span>
                                </button>
                                <button
                                  className="quiet small"
                                  aria-label={`Delete ${c.title}`}
                                  disabled={busy}
                                  onClick={() => {
                                    if (
                                      !window.confirm(
                                        `Delete "${c.title}"? This cannot be undone.`,
                                      )
                                    )
                                      return;
                                    void run(async () => {
                                      await api(
                                        `${scope}/chats/${c.id}`,
                                        {},
                                        "DELETE",
                                      );
                                      if (chat?.id === c.id) setChat(null);
                                      setChats(
                                        (await api(`${scope}/chats`)).chats,
                                      );
                                    });
                                  }}
                                >
                                  Delete
                                </button>
                              </div>
                            ))}
                          </section>
                        )
                      );
                    })
                  )}
                </>
              );
            })()}
          {page === "Guide" && <Guide />}
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
                  <a href={`/api${scope}/export/study-data`} download>
                    Study progress (JSON)
                  </a>
                </div>
              </section>
              <section className="panel">
                <h2>Import study progress</h2>
                <label>
                  Study progress (JSON) exported from this app
                  <input
                    type="file"
                    accept=".json,application/json"
                    disabled={busy}
                    onChange={(e) => {
                      const input = e.target;
                      void run(async () => {
                        const selected = input.files?.[0];
                        if (!selected) return;
                        const result = await api(`${scope}/import/study-data`, {
                          operationId: operation(),
                          content: await selected.text(),
                        });
                        input.value = "";
                        await refresh();
                        setSaveStatus(
                          `Imported ${result.answers} answers, ${result.annotations} flags or question notes, ${result.notes} notes; ${result.unchanged} already the same` +
                            namedEntries(
                              result.unmatched,
                              "not found in this library (import that bank first)",
                            ) +
                            namedEntries(
                              result.ambiguous,
                              "left unchanged because more than one question matches",
                            ),
                        );
                      });
                    }}
                  />
                </label>
                {saveStatus.startsWith("Imported") && (
                  <p className="muted">{saveStatus}</p>
                )}
              </section>
              <section className="panel">
                <h2>Display</h2>
                <div className="chips display-tools">
                  <span className="muted">Text size</span>
                  <button
                    className="secondary"
                    aria-label="Smaller text"
                    disabled={fontSize <= FONT_SIZES[0]}
                    onClick={() =>
                      setFontSize(
                        [...FONT_SIZES]
                          .reverse()
                          .find((size) => size < fontSize) ?? FONT_SIZES[0],
                      )
                    }
                  >
                    A−
                  </button>
                  <button
                    className="secondary"
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
                  <span className="muted">Theme</span>
                  <button
                    className="secondary"
                    aria-label={`Theme: ${theme}`}
                    title="Switch theme: system, light, dark"
                    onClick={() =>
                      setTheme(
                        THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length],
                      )
                    }
                  >
                    {theme === "dark"
                      ? "☾ Dark"
                      : theme === "light"
                        ? "☀ Light"
                        : "◐ Auto"}
                  </button>
                  <span className="muted">Line width</span>
                  <select
                    aria-label="Line width"
                    id="page-width"
                    value={pageWidth}
                    onChange={(e) => setPageWidth(e.target.value as PageWidth)}
                  >
                    {Object.keys(PAGE_WIDTHS).map((label) => (
                      <option key={label}>{label}</option>
                    ))}
                  </select>
                  <span className="muted">Line spacing</span>
                  <select
                    aria-label="Line spacing"
                    value={lineSpacing}
                    onChange={(e) =>
                      setLineSpacing(e.target.value as LineSpacing)
                    }
                  >
                    {Object.keys(LINE_SPACINGS).map((label) => (
                      <option key={label}>{label}</option>
                    ))}
                  </select>
                </div>
              </section>
              <section className="panel">
                <h2>Practice</h2>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={answerOnClick}
                    onChange={(e) => setAnswerOnClick(e.target.checked)}
                  />
                  Show the answer as soon as I pick a choice (no Submit button)
                </label>
              </section>
              <AIProviderSettings
                onSaved={() => void api("/models").then(setSettings)}
              />
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
                    // A disabled model is usually waiting for a key or sign-in;
                    // the server's reason says which, on hover.
                    <option
                      key={entry.id}
                      value={entry.id}
                      disabled={!entry.enabled}
                      title={entry.enabled ? undefined : entry.reason}
                    >
                      {entry.name}
                      {entry.enabled ? "" : " · not ready"}
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
        </Suspense>
      </main>
      {page === "Materials" && <BackToTop />}
      {citation && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}
    </>
  );
}
// Fetch the Markdown chunk once the page has loaded, before the first question needs it.
window.addEventListener("load", () => void import("./Markdown"), {
  once: true,
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
