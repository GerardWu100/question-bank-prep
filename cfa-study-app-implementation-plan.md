# CFA Study App — Detailed Implementation Plan

**Prepared:** October 14, 2026  
**Basis:** `cfa-study-app-design.md`, supplied by the user.  
**Deliverable:** An implementation specification and sequenced build backlog; not an implemented or deployed application.

## 1. Decision summary

Build a **TypeScript-first, self-hosted web application**. Use React and Vite for the browser, Node.js and Fastify for the application server, SQLite for durable records and full-text search, and pi-ai behind a replaceable provider adapter. Keep Python limited to the isolated calculator, initially through Pyodide.

The central architectural decision is to separate three things: **original study content, your learning records, and AI-created content**. Separately, distinguish a question's overall latest answer from its answer inside a particular saved set. These boundaries are more important than adding another framework.

Keep the original product scope: question-first practice, saved sets, inline corrections, a question tutor, library-wide Ask AI, explicitly requested AI notes, an evidence-backed Focus list, materials reading/editing, searchable chat history, and single-user hosting. The source specification explicitly excludes question generation and automatic material reformatting. [D1, §§1–3]

### 1.1 Working assumptions and proposed resolutions

These are implementation decisions, not additional requirements claimed to be in the source.

| Area | Decision |
|---|---|
| Users | One account, potentially several devices and browser tabs. |
| Hosting | One Linux host with Docker Compose. Keep the access layer replaceable; default to authenticated HTTPS access and no publicly exposed application port. |
| Library size | Design and test initially for 10,000 questions, 100,000 indexed sections/chunks and 100,000 chat messages. These are proposed test loads, not measured capacity claims. |
| Material preparation | The app consumes prepared Markdown. PDF conversion, translation and restructuring remain separate upstream workflows. |
| File layout | Accept configured existing folders. Do not move materials to fit an example directory tree. |
| Choices | Default A–C in the CFA library; validate against that library's configurable label list. Do not hard-code three choices. |
| Library metadata | Store source/topic/chapter mapping rules in app settings, not YAML inserted into the user's files. |
| Offline operation | Practice and materials work when the AI provider is unavailable, provided the browser can still reach the self-hosted app. Full disconnected-device synchronization is outside version 1. |
| Authentication | Preserve subscription-based use and the request to reuse Codex login where compatible. Treat credential reuse as a tested integration requirement, not an assumed pi-ai feature. |
| AI writes | Only explicitly authorized Focus and AI-note operations; never original materials or answers. |
| Missing keys | Keep affected questions readable. Exclude them from graded set selection by default and disable grading until fixed. |
| Case quantity | Treat requested quantity as a target when keeping selected case groups together would exceed it. Show the exact actual quantity before starting. |
| Progress semantics | Done means a saved response, not mastery. Current status is not a first-attempt accuracy statistic. |

### 1.2 Explicit non-goals

Do not build user-generated quizzes, automatic answer-key repair, autonomous source editing, timed mock exams, date-based spaced repetition, leaderboards, social features, a mobile-native app, payment features, external web search, or a generic plugin/agent platform. Do not add a vector database, Redis, PostgreSQL or a distributed job system without a measured need.

## 2. Technology and system boundaries

### 2.1 Selected stack

| Layer | Choice | Reason for this project |
|---|---|---|
| Browser | React + TypeScript + Vite | Retains the supplied design and allows shared request/response types. |
| Routing and data | A small client router and a query-cache layer | Keep navigation, server state and temporary form state separate. |
| Presentation | CSS with a small reusable component set | A single-column study interface does not need a large design-system dependency. |
| Server | Node.js + Fastify + TypeScript | One application server for login, records, import, editing, search and streams. |
| Validation | TypeBox/JSON Schema contracts | Validate every external request and every model tool call. Fastify documents schema-based request validation and response serialization. [R14] |
| Persistence | better-sqlite3 + explicit, versioned SQL migrations | Keep joins, constraints and FTS behavior visible; no heavyweight object-relational mapper initially. |
| Search | SQLite FTS5 | Implements the source design without a second database. [D1, §11; R11] |
| Parsing | unified/remark abstract syntax tree | Parse structural Markdown instead of trying to recognize whole documents with regular expressions. [R15] |
| Rendering | react-markdown + remark-gfm + remark-math + rehype-katex | One configured renderer for source content, editor preview and AI responses, as specified. [D1, §12] |
| Editor | CodeMirror-based Markdown editor | Text editing with a separate Preview tab, not a side-by-side layout. |
| AI | pi-ai behind an application-owned adapter | Keep account authentication, model selection and provider changes out of domain logic. |
| Calculator | Pyodide in an isolated calculator service | Retain Python calculations while enforcing restrictions outside the language runtime too. |
| Tests | Vitest and Playwright | Unit/integration testing plus real-browser end-to-end flows. Their documented capabilities fit these roles. [R18; R19] |
| Packaging | One repository, a package-manager workspace and Docker Compose | One release and lockfile, with process isolation only where useful. |

Pin exact versions during the initial compatibility work and record them in the lockfile. Test upgrades before adopting them. Do not build against a moving upstream main branch.

### 2.2 Runtime topology

The recommended deployment has one application and two restricted helpers. This is a security separation, not a proposal for a large microservices system.

| Process | Responsibilities | Accessible data | Network |
|---|---|---|---|
| `study` | Serves the browser; login; database; import; editor; search; tool authorization; durable jobs | Materials, AI notes, app data; no provider credentials | Browser/proxy and narrowly defined helper connections |
| `ai-runtime` | pi-ai, account adapter, provider streaming | Its own credential store and only the context supplied for a run; no materials or database mounts | Required provider/authentication endpoints only; narrow IPC with the application |
| `calculator` | Executes a bounded calculation and returns structured output | Runtime libraries, disposable memory filesystem, dedicated IPC endpoint; no app data or credentials | No IP networking; use a dedicated Unix-domain socket for application communication |

The application executes validated search/read/write tool operations; the AI runtime does not receive a general filesystem handle. A tool result is data, not permission to execute another operation.

The manual editor is deliberately part of trusted application code. It needs write access to original materials, but no AI tool points at that endpoint. Check server-side origin, session, anti-forgery token and operation permissions. Do not imply that a JavaScript path variable is an operating-system sandbox.

### 2.3 Repository organization

| Directory | Ownership |
|---|---|
| `apps/web/` | Pages, browser routing, components and client state |
| `apps/server/` | HTTP routes, authorization, jobs and application services |
| `apps/ai-runtime/` | pi-ai integration, credentials and provider transport |
| `apps/calculator/` | Calculator supervisor, Pyodide bootstrap and result protocol |
| `packages/domain/` | Grading, set selection, reconciliation rules and Focus evidence logic |
| `packages/contracts/` | Shared validated request/response and tool schemas |
| `packages/markdown/` | Parser utilities, rendering policy and source-location helpers |
| `packages/database/` | Migrations, repositories and transaction helpers |
| `tests/fixtures/` | Synthetic examples and private representative samples |
| `tests/e2e/` | Browser workflows and regression tests |
| `ops/` | Container definitions, backup/restore procedure and deployment documentation |
| `docs/` | Product decisions, architecture decisions and acceptance checklist |

Keep runtime state and credentials out of source control. Do not change the tracking or location of existing material files merely to fit this structure. AI notes should remain outside `materials/`, with their version-control policy chosen explicitly rather than inherited accidentally.

## 3. Early compatibility gates

### 3.1 Subscription authentication and requested models

The supplied design names GPT-6.1 Sol and GPT-6 Luna, with reuse of `.codex` credentials and no API-key billing. [D1, §10]

The model identifiers are present in current official OpenAI documentation, but that does not establish access for the user's account or through a particular provider adapter. Use the signed-in account's model catalog and a minimal completed request to establish availability. [R6; R3]

Current pi-ai documentation describes its own credential-store interface, locked token refresh, and an OpenAI Sign in with ChatGPT route; it labels the older Codex provider as legacy. Therefore, simply mounting `.codex` must not be treated as proof that a chosen pi-ai version can consume and safely refresh those credentials. [R1]

Codex may store its credentials in `auth.json` or an operating-system credential store. Inspect authentication mode and file compatibility without exposing tokens. A successful browser sign-in alone is not proof that a reusable file exists. [R2]

**Required compatibility work:** choose and pin the adapter version; identify its documented supported authentication path; test existing Codex credential reuse where supported; verify actual model availability, streaming and a tool call; test refresh, restart and revoked credentials; and prove that a missing/failed subscription credential cannot trigger API-key fallback.

If direct credential reuse is incompatible, surface an explicit setup blocker. A supported, app-specific subscription login is a proposed alternative requiring an explicit setup choice, not an invisible change to the design. OpenAI now documents a Sign in with ChatGPT plan-usage flow for open-source and locally hosted applications, including self-hosted virtual machines. Eligibility and registration for the actual deployment must be checked. [R5; R4]

For that supported flow, the adapter should use the account-specific model catalog, request streaming with provider-side storage disabled, and regard the request as successful only at its terminal completed event. A usage error can arrive after partial text has streamed. These are transport-specific rules and belong in the adapter. [R3]

**Credential ownership:** one designated process owns refresh. Do not copy the same rotating session into two independently active writers and assume that makes sessions independent. When moving a supported login session to a VM, preserve the VM's host identifier and assign subsequent refresh ownership to the VM, following the relevant provider procedure. [R4]

**Fail-closed billing policy:** do not install a Platform API-key fallback, inherit API-key credentials, automatically enable paid credits, or silently switch models. Unavailable models are disabled with a reason. A rate limit leaves existing study features usable. The UI labels the provider/account route and selected model, but never displays tokens.

### 3.2 Calculator isolation

Pyodide has a virtual filesystem and can be connected to a native filesystem by its host. A plain worker does not by itself satisfy the design's claim of no file access. Node worker resource limits also do not constrain all external allocations. [R7; R8]

Interpret the required boundary precisely: **no access to host/application files, secrets or network; only disposable runtime memory and bundled libraries**. Do not claim Python has no internal filesystem at all.

Before exposing calculations, demonstrate denial of network access and application-file access, termination of an endless loop, bounded output, memory exhaustion containment, and recovery without taking down the main application. Docker supports memory limits and a network-isolated mode; configure and verify them rather than relying on defaults. [R9; R10]

### 3.3 Import and identity

Create representative fixtures before developing the full browser. The initial gate must prove standalone questions, cases, mixed chapters, multiline choices, tables, equations, missing keys, duplicate headings, a renamed source file and an answer-key-only correction.

The critical result is not just extracting a question: it is retaining that question's record after safe edits and refusing ambiguous identity matches.

## 4. Domain rules: the authoritative behavior contract

Implement these rules as pure domain functions and transaction tests before embedding them in UI handlers. [D1, §4]

### 4.1 Grade and confidence

| Situation | Effective result | Confidence stored |
|---|---|---|
| No submitted selection | Unanswered | Empty |
| Selection matches valid answer key; Sure | Correct | Sure |
| Selection matches valid answer key; Unsure | Unsure | Unsure |
| Selection differs from valid answer key | Wrong | Empty |
| Missing, invalid or ambiguous key | Grade unavailable | Do not invent a grade |

Store the selected label and confidence; derive the effective grade from the current valid key. Do not maintain an independently editable `is_correct` field.

Before submission, local choice changes are drafts and do not affect overall status. Submission reveals the result and source solution without moving to the next question. After submission, choosing a different answer immediately saves and regrades it. Wrong hides the confidence control and clears confidence; switching to a correct answer initializes Sure, which can then be changed to Unsure.

A key correction regrades stored responses without pretending the user answered again. When a previously wrong response becomes correct, default its previously empty confidence to Sure. When a previously correct response becomes wrong, clear confidence. Do not increment answer recency merely because an importer or key repair ran.

If a previously valid key becomes invalid, retain the saved selection and annotate grade unavailable. Do not count it as Wrong or silently erase it. Show a separate material-quality count so the four graded-status counts are not misleading. Ungradable is an eligibility condition, not an invented fifth confidence/result category.

### 4.2 Two layers of saved state

`question_state` holds the latest overall selection, confidence, answer sequence and annotation state. `set_items` holds the most recent selection and confidence within each particular set, plus whether it has been submitted there.

Example, assuming the key is B:

| Step | Overall state | Set 1 state | Set 2 state |
|---|---|---|---|
| Submit A in Set 1 | Wrong, sequence 120 | A, submitted | Not created |
| Correct the misclick to B in Set 1 | Correct/Sure, sequence 121 | B, submitted | Not created |
| Create Set 2 containing this question | Still Correct/Sure, sequence 121 | Unchanged | Blank, not submitted; last status tag is Correct |
| Submit C in Set 2 | Wrong, sequence 122 | Still B, submitted | C, submitted |
| Return to Set 1 without editing | Still Wrong, sequence 122 | Shows B as left | Unchanged |

When a saved set's answer differs from the latest overall answer, label those two facts rather than overwriting either silently. Simply navigating to an old set never promotes its old selection to the overall latest answer.

This is not an attempt-history system. Each set stores its current working answer, not an append-only list of every click. Global progress still uses one latest answer per question.

### 4.3 Sequence and writes

Maintain a monotonic answer counter per library. Each genuinely accepted answer save, including a correction or confidence change, receives the next sequence number. A retry of the same request must not increment it again. Opening a question, editing My note, flagging and reimporting do not increment it.

The Older ordering sorts previously answered questions by ascending answer sequence. Unanswered is separately selectable and is never assigned a fabricated date or answer sequence. Timestamps may exist for diagnostics, chat headers and revisions; they do not drive Older ordering.

Every mutation carries an operation ID and expected record version. The operation ID makes retries idempotent: sending the same save twice has one effect. The record version prevents an old browser tab from silently overwriting a newer answer. A conflict is shown inline with the server's current value, not mistaken for a successful save.

Use one database transaction for the library sequence increment, overall answer update, set-item update, evidence revision and operation receipt. Display Saved only after commit. Never hold the transaction open while waiting for AI or file parsing.

Within one browser, serialize answer writes per question while keeping the choice cards responsive. Coalesce superseded unsent selections, carry forward the acknowledged version and ignore late responses for older local intents. A rapid A → B → C correction must finish on C, not whichever network request happens to return last. Keep Saving visible until the newest intended value is committed; an unrelated older acknowledgement must not display Saved for an unsaved choice.

### 4.4 Filters, case groups and frozen sets

Interpret selected statuses as OR: Wrong plus Unsure includes either. Topic/chapter/source scope intersects the status selection. Flagged and In Focus are additional intersecting filters. All clears the status restriction; Older is an ordering rule, not a correctness status.

Shuffle groups eligible questions by case, treats standalone questions as one-question groups, shuffles groups, and preserves the original order within each group. Never shuffle answer choices. In a Wrong-only set, grouping does not add correct siblings automatically; it groups only the eligible case questions while retaining their shared passage.

Save the exact resulting ordered question IDs, seed, filters and import revision. Once started, membership and order do not change when grades improve. A source deletion leaves a visible removed-source placeholder, not a silent shrinkage of the set.

## 5. Database model

All ordinary application state lives under `app-data/`. Credentials are a separate protected mount, excluded from ordinary study backups. [D1, §§11–13]

| Table/group | Important fields and role |
|---|---|
| `libraries` | ID, name, settings, archive state, next answer sequence, current import generation |
| `sources`, `topics`, `chapters` | Stable IDs and display order; mappings live outside original materials |
| `files` | Stable ID, library, area, relative path, source/type metadata, current hash, current revision, active/removed state |
| `file_revisions` | File ID, content hash, immutable stored-content location, origin and creation metadata |
| `sections` / `section_versions` | Stable section identity where reconciled; heading path, revision, lines/offsets and content |
| `search_chunks` | Internal retrieval slices, owning section version, text, offsets and search-only normalized fields |
| `cases` / `case_versions` | Stable case identity and immutable passage/exhibit versions |
| `questions` / `question_versions` | Stable ID; current content version; case association; stem, choices, key, solution, fingerprints and source locations |
| `question_state` | One current overall selection/confidence, last answer sequence and optimistic-lock version |
| `question_annotations` | Flag and My note with their own versions; avoids overwriting an answer when saving a note |
| `sets` | Library, title, frozen filters/order seed, cursor, creation revision and version |
| `set_items` | Unique set/position; question ID; submitted flag; current selection/confidence in that set; content revision used |
| `chats` | Library, kind, optional question ID and title; unique question-chat relationship |
| `messages` | Chat, order, role, Markdown, actual model ID, provider, completion state and optional study-context annotation |
| `message_sources` | Message, validated source handle, file/section/question version and citation location |
| `generation_runs` | Message/run IDs, model, prompt/tool-policy versions, terminal status, usage metadata and cancellation state |
| `focus_items` | Stable ID, topic/chapter, title, body, Open/Resolved state and evidence digest |
| `focus_links` | Specific question-state, annotation, message and material references with observed evidence versions |
| `focus_suppressions` | Resolved/deleted concept identity and evidence versions already considered |
| `ai_note_metadata` | Note/file identity, originating chat/message, generated and edited provenance, source references |
| `import_runs`, `import_issues`, `identity_matches` | Staging status, precise issues and approved old-to-new mappings |
| `jobs` | Durable import/Focus/backup status, lease, checkpoints and recoverable errors |
| `write_operations` | Idempotency receipts and file-operation recovery metadata, not a learning-attempt ledger |
| `sessions` | Hashed session identifiers, expiry and revocation |
| FTS tables | Search indexes for authorized material views and chat messages |

Use foreign keys, explicit uniqueness constraints, parameterized queries and schema migrations. Keep stable identity distinct from changeable content hashes; do not use a hash of the whole question as its permanent ID.

Use SQLite write-ahead logging on a local disk, short write transactions and a busy timeout. SQLite permits concurrent readers with a writer in WAL mode, but still only one writer at a time. Keep database ownership in the main application process and avoid long write locks. [R12]

Treat search indexes as rebuildable. Treat user records, identity mappings, source revisions referenced by chats, and suppression records as durable data. Never label the latter as disposable cache.

## 6. Material import and reimport

### 6.1 Parser design

Parse Markdown into an abstract syntax tree: a structured representation of headings, paragraphs, lists, tables, code blocks and math. Recognize the specified Chapter → optional Case → Question → Choices/Answer/Solution hierarchy using heading depth and parent context. Recognize heading labels only after parsing; a heading-like string inside a code fence is not a real heading. [D1, §9; R15]

Retain original source slices and byte/character positions. Derive display and search fields without rewriting the source file. Validate multiline choices and preserve their block content. A missing solution is allowed; an answer must contain one configured label belonging to an existing choice.

Notes need no question-bank template. A note heading such as Question in a lecture file must not automatically turn that file into a question bank. File type comes from import configuration and preview.

### 6.2 Pipeline

Scan configured roots; reject escaping paths and unsafe symlinks; snapshot hashes; parse changed files into staging; validate and classify issues; propose identity matches; present a preview; confirm; verify hashes still match; atomically activate the new database generation; and refresh affected indexes and counters.

The preview shows files, sections, cases, questions, gradable/ungradable counts, additions/removals, source/topic mappings and unresolved identity matches. Every issue includes the file, heading path, line and expected structure. Warnings may be accepted explicitly; structural failures do not replace a previously valid file's active import.

Unchanged files are skipped by content hash. A cancelled or failed import leaves the previous active generation usable. If a file changes between preview and confirmation, invalidate the preview rather than applying stale matches.

### 6.3 Reconciliation algorithm

| Priority | Evidence | Action |
|---|---|---|
| 1 | Same tracked file and unchanged question content | Reuse stable question ID. |
| 2 | Same structure and stem/choices; only answer/solution changed | Reuse ID, version content and regrade when needed. |
| 3 | File moved/renamed; unique whole-file fingerprint | Propose/accept the unique file identity, then reuse compatible child identities. |
| 4 | Heading changed; uniquely identical stem/choices in the same library | Reuse only when the match is unambiguous and case context remains compatible. |
| 5 | Minor text changes or multiple plausible candidates | Present suggestions for manual reconciliation; do not silently attach. |
| 6 | Materially changed question/choice meanings, split/merge or unresolved duplicates | Require explicit identity decision or create a new question. Preserve old records. |

Identity fingerprints exclude answer and solution, because correcting a key must not create a new question. They retain meaningful numbers, mathematical symbols and choice content. Conservative whitespace normalization is acceptable; stripping punctuation, digits or mathematical operators is not.

Keep repeated question numbers valid under different case parents. A heading path is a structural path, not a globally unique text string.

If choices are reordered or their labels change meaning, do not regrade old labels against new semantics without reconciliation. Preserve the version associated with each set response and mark incompatible edits as needing review.

### 6.4 Source revisions and deletions

Preserve imported source versions referenced by chats and notes. A citation remains linked to the cited revision even if the current file has moved or changed; offer the current version separately. External edits can be captured from the last imported snapshot and the newly imported version without writing to original files.

A removed question/file becomes inactive. Exclude it from new-set selection and current active-material totals, but retain linked chats, annotations and old-set entries. Never cascade a material deletion into lost learning records.

## 7. Practice and reading experience

Build the original navigation: Practice, Progress, Ask AI, Materials, History and Settings. The default route is Practice with an exact Continue action. Retain the single-column constraint across desktop and phone. [D1, §§3, 5, 7]

### 7.1 Practice home and set builder

Show saved sets, last active position, completion count and the topic/chapter/source browser. Lazy-load expanded tree nodes rather than rendering the entire library. Marker clicks open a question in a defined practice context without creating an answer record.

Preview the set's actual size and case grouping. Source order, random seed and Older ordering must be deterministic after creation. Empty filters produce a useful empty state rather than a broken Start button.

### 7.2 Question page

Render breadcrumb, set progress, case passage/exhibits, stem, choices, confidence and submission, result, original solution, My note, Focus links, related notes, tutor and navigation in one column. Persist the case's expanded/collapsed preference across its questions.

Use labels as well as visual markers so status is not communicated by color alone. The entire answer card is clickable; keyboard focus is visible. Arrow navigation is disabled in text inputs, editors and other typing contexts. Long question strips scroll or virtualize rather than creating thousands of DOM elements.

Pin the tutor composer without covering answer controls or the last paragraph. Account for the mobile on-screen keyboard and safe areas. Stream without pulling the reader to the bottom if they have deliberately scrolled upward.

### 7.3 Shared renderer

Use the same math/table/link policy everywhere. Keep raw HTML disabled, restrict link schemes, serve only authorized local assets, and avoid automatic loading of remote images. Large tables and equations scroll within their block rather than widening the whole page.

**Proposed material-compatibility addition:** support Mermaid code fences if they occur in the converted notes. Render them with restrictive settings, no executable callbacks or external loading, and show the original text on failure. This is an addition to the supplied renderer list, not an existing explicit requirement in that list.

Render old citations in a large overlay with return-to-chat position preserved. The materials outline is collapsible above the content, not a sidebar.

## 8. Search, retrieval and citations

### 8.1 Internal chunks, not thousands of new files

Keep provider/chapter-sized Markdown files intact. Index notes by heading. Split unusually long sections internally at paragraph or block boundaries, not by rewriting files. Keep a formula and its immediately associated worked example together where practical; do not cut a table or math block in the middle. [D1, §§9, 11]

Each chunk retains the library, file area, source label, topic/chapter, heading path, stable entity ID, source revision, original line/offset range and parent section. Keep question stem/choices separate from answer/solution for spoiler-safe access.

Use SQLite FTS5 ranking with stronger weighting for headings and topic terms. Normalize a search-only representation, retaining raw Markdown separately. FTS5 supports tokenization and relevance ranking; measure retrieval quality on the actual materials rather than assuming keyword search captures every paraphrase. [R11]

Introduce a small configurable synonym list only as needed. Do not silently replace the source terminology. If unsegmented Chinese remains, explicitly test tokenization and choose a language-aware search preprocessing strategy before claiming those files are fully searchable.

### 8.2 Two access surfaces

The human Materials reader and general Ask AI can intentionally access complete library content. The pre-submit tutor uses a separate restricted search/read policy. Applying a filter to returned results is insufficient when snippets were generated from forbidden answer text; build restricted indexes/views from permitted fields first.

Related notes are deterministic full-text matches, not generated recommendations. Label matches as original material, personal note or AI note. Prefer original sources over AI notes, but permit an AI note to be retrieved and cited as such.

### 8.3 Citation contract

Tool results include application-issued source handles. The model cites those handles, not invented paths or line numbers. The server validates that each cited handle was available to the run, is in the active library and is permitted for that mode.

Persist the actual source version with each message. Render valid handles as source chips opening the relevant original section. Invalid handles receive no fabricated link and must be corrected or surfaced as an unsupported citation.

A valid citation proves that a referenced passage exists, not that it supports every sentence. Include human-reviewed grounding tests and require an explicit statement when the supplied material does not support a claim. Source disagreement is reported, not silently reconciled.

## 9. AI orchestration and chat persistence

### 9.1 One adapter and a small tool loop

Implement an application-owned provider interface for account status, model discovery, streaming, cancellation and normalized terminal errors. pi-ai is the chosen implementation, not a dependency that controls the database schema.

Expose only mode-specific tools. Do not attach a general coding-agent harness, shell tool, generic URL fetcher, filesystem traversal or arbitrary SQL tool. The application's local tools have no external web access. The provider connection still sends selected content off-host, as the supplied privacy statement already recognizes. [D1, §10]

### 9.2 Tool permissions

| Tool | Pre-submit tutor | Post-submit tutor / Ask AI | Focus run |
|---|---|---|---|
| `search_materials` | Restricted source views; no answer/solution fields | Scoped full library access | Scoped full library access |
| `read_material` | Same restrictions; deny whole-bank bypass | Read authorized IDs and versions | Read relevant authorized IDs |
| `get_my_results` | Exclude current-question prior answers and other spoiler-bearing fields | Read-only within library | Read-only evidence packet |
| `get_my_chats` | Do not expose prior spoiler-bearing conversations | Read-only scoped history | Read-only evidence, especially user messages |
| `calculate` | Permitted with bounds | Permitted with bounds | Only if needed |
| `save_focus_items` | Unavailable | Unavailable unless an explicit Focus update is initiated | Validated writes for this run |
| `write_ai_note` | Only after explicit user request and within this run's permitted context | Only after explicit user request | Unavailable by default |

Every tool receives a server-created library/mode context. A model-provided library ID or claimed permission never overrides it. Validate types, maximum sizes, entity ownership and output shape.

### 9.3 Spoiler protection

Before the current set item is submitted, withhold the key, solution and current question's previous result from the API response, model prompt, tool results and retrieval snippets. Hide old post-answer tutor content by default in a new blank review, while preserving it in History. Use conversation-context annotations to avoid replaying that content back into hint mode.

Exclude known duplicate solved versions of the active question from restricted retrieval where detectable. Do not let the tutor request a full source file containing the hidden Answer section. Material excerpts and old chat messages are untrusted content, not instructions to relax restrictions.

**Limit of the promise:** the model can solve a visible question from general knowledge, and complete duplicate detection is not guaranteed. The enforceable guarantee is that the application does not deliberately supply the hidden key/solution in hint mode; model behavior is also tested, not guaranteed mathematically. General Ask AI and the Materials reader remain intentional unrestricted study tools, not locked exam surfaces.

### 9.4 Durable streaming

Save the user's message before calling the provider. Create an assistant message/run with a streaming state, persist partial content in bounded batches, and store the final content only as completed after a successful terminal event. Keep interrupted, cancelled, failed and complete states distinct.

Use Server-Sent Events (SSE), a one-way stream from server to browser, for replies and progress. The initial authenticated mutation creates a run; reconnecting attaches to the same run and does not generate another answer. An explicit Stop cancels the upstream request. A server restart marks unrecoverable active runs interrupted rather than silently repeating them.

Store actual model/provider, validated sources, attachments, tool result summaries, prompt-policy version and available token usage per reply. Do not show an estimated API price as a subscription charge. Search both user and assistant text in History.

Allow one active generation per chat and initially one active foreground AI run per account. Queue manual Focus work behind foreground tutor requests, with cancellation and bounded work. Do not process an entire large library in every turn.

### 9.5 Explicit write authorization

An AI note may be created from Save as AI note or a direct user request. A server-owned authorization record binds the action to the initiating user turn, library, target area and optional existing note ID. Retrieved text and tool output cannot grant that authorization.

If a natural-language request is ambiguous about modifying an existing note, do not overwrite it based only on the model's guess. Ask for the specific target or keep the response in chat. The explicit button path should be deterministic.

Set limits on tool steps, returned source text, result count, run duration and output size. These are engineering defaults to tune, not additional user-facing study limits.

## 10. Calculator service

The calculator receives a small structured request: a calculation ID, permitted Python program, explicitly supplied inputs, requested outputs and limits. It returns structured values, units where provided, bounded explanatory output and a typed failure if necessary.

Use a clean interpreter context for every job. Bundle approved libraries at image build time; do not permit run-time package installation. Begin with standard numerical tools and add packages only for demonstrated study requirements. Avoid persistent state leaking one question's variables into another.

**Proposed initial bounds:** one concurrent job, five seconds of execution after startup, 512 MiB service memory, one CPU, a fixed process-count limit and 64 KiB captured output. Benchmark actual runtime startup and representative calculations before finalizing these values. If Pyodide needs a larger safe startup allocation, revise and document the bound rather than allowing unbounded memory.

Enforce no IP network using the container configuration, no application/credential mounts, a read-only runtime filesystem where possible, non-root execution, dropped capabilities and no Docker daemon socket. Communication uses only a narrowly scoped local IPC endpoint. Kill and replace the execution context on timeout; recover cleanly if the calculator container itself is terminated for memory exhaustion. [R9; R10]

The application should show inputs, formula, substitution and result, following the source requirement. It should also preserve units and rounding assumptions. The calculator proves arithmetic on supplied inputs, not that the model chose the right finance formula.

## 11. AI notes and Focus

### 11.1 AI notes

Create or update only inside the separate `ai-notes/` root. The application, not the model, owns safe filenames, the AI-authorship header, model/date/chat provenance and citation links. Use an existing note ID for updates rather than permitting arbitrary model-generated file paths. [D1, §7.4]

Save as AI note should normally preserve the chosen reply and its citations. A request to compose or combine notes can invoke generation. Do not silently turn a direct save into an extra paid or quota-consuming call.

An update needs an expected content hash. On collision or external change, do not overwrite. Every successful save preserves a revision, reindexes the note and keeps AI-origin labeling even after human edits. Deletion removes it from active search while retaining revision/citation metadata according to the documented retention policy.

### 11.2 Focus pipeline

Focus runs only when requested for a library, topic or chapter. Build a scoped evidence packet from current Wrong/Unsure states, flags, My notes and actual user follow-up messages. Include existing items and suppressions before generation. Process large histories in bounded batches and record the evidence coverage actually processed. [D1, §6]

The model proposes structured items: concept/title, explanation, topic/chapter, specific evidence IDs and related material IDs. The application checks that evidence exists, belongs to the scope and supports the type of claim. An AI reply alone is not evidence that the user repeatedly made a mistake.

Persist items and links only after validation. Maintain a stable concept identity and an evidence digest so rerunning the same evidence updates or leaves an item unchanged rather than duplicating it.

Resolving or deleting an item retains an internal suppression record for the evidence already considered. Only materially new relevant evidence can justify recreation. A new wrong/unsure response, new user follow-up or changed annotation may count; rerunning the agent or rephrasing its own explanation does not.

Revalidate evidence against current answer-key versions. When corrected keys invalidate old evidence, mark the item as needing an updated evidence check instead of asserting the original mistake remains valid.

**Important data limitation:** latest-answer semantics cannot support claims about how many historical attempts were wrong. Focus can cite current mistakes, saved set snapshots with context, and retained user questions, but must not invent an attempt-frequency history.

Practice these creates a frozen set from active questions linked to open Focus items. Counts and sets remain usable if the Focus agent is unavailable.

## 12. Editing and filesystem consistency

Edit opens a whole-file Markdown editor positioned at the question/source section. Preview is a separate tab. Do not create a structured question editor that silently rewrites surrounding Markdown. [D1, §8]

On open, return a content hash. On Save, validate the authenticated human action, acquire the per-file application lock and compare the current disk hash. A mismatch returns a conflict and preserves the user's draft for copying or reconciliation.

Save the previous version, write the new bytes to a temporary file on the same filesystem, flush and atomically replace the target. Record a recoverable file-operation journal and trigger reimport. Because filesystem replacement and database commit are separate operations, explicitly recover a crash between them by comparing hashes and completing/retrying the import.

A save that produced invalid question structure must not silently publish corrupt parsed entities. Show the file as saved with import issues and retain the last valid imported view until the issues are addressed. Label stale imported content clearly. Prefer a pre-save validation preview to reduce this state.

A fully atomic compare-and-swap against arbitrary uncooperative external editors is not guaranteed by an ordinary hash check. Check again immediately before replacement, document the residual race, and test common external-edit workflows. Never claim a plain check-then-write eliminates every filesystem race.

Path safety applies to reads, assets, writes, revisions and export. Resolve library-owned file IDs rather than trusting browser paths; reject absolute paths, traversal components, encoded traversal, escaping symlinks and disallowed extensions. Test that the AI-note root is not a symlink into `materials/`.

## 13. Application programming interface contracts

An application programming interface (API) is the contract the browser and internal components use to request operations. The names below are proposed; the invariants matter more than exact URLs.

| Operation | Required inputs / contract | Required outcome |
|---|---|---|
| Session/login | Password; rate limits; anti-forgery policy | Secure server-side session; no password echo |
| Get library | Explicit library ID | Settings, archive state and version |
| Preview import | Library, configured roots and current generation | Staged counts, issues, hashes and identity proposals |
| Commit import | Import-run ID, expected hashes and resolved mappings | One activated generation or a precise stale-preview error |
| Browse | Library, topic/chapter/source, cursor | Aggregated counts and paginated children |
| Preview set | Scope, statuses, flags, order and target count | Exact case-aware count and deterministic selection seed |
| Create set | Valid preview/selection and library generation | Frozen question list and blank per-set states |
| Get set item | Set/item ID and current mode | Safe question DTO; hidden key/solution absent before submit |
| Save answer | Item/question ID, label, confidence, operation ID and expected versions | Atomic overall + set update, new sequence and committed status |
| Save annotation | Question ID, flag/note, operation ID and annotation version | Annotation-only update; no answer recency change |
| Save cursor | Set ID, target position and version | Durable exact resume position |
| Read material | Authorized entity/revision ID | Labeled source content, outline and controlled asset references |
| Search | Library, area/scope, text and access mode | Authorized source handles and ranked results |
| Save source | File ID, expected hash, new text and human-save authorization | Revision + safe replacement + reimport status |
| Create chat turn | Chat ID, user text, model ID, excerpt IDs and operation ID | Durable user message and unique generation run |
| Stream run | Run ID and resume cursor | Existing run events, never a duplicate provider request |
| Cancel run | Run ID | Upstream cancellation and persisted terminal state |
| Save AI note | Source message or composition request, target note ID/hash when updating | Separate labeled note and revision |
| Run Focus | Library/scope and operation ID | Durable scoped run with coverage and evidence validation |
| Resolve/delete Focus | Item ID and expected version | Visible state change plus suppression metadata |
| Backup | Authenticated explicit action | Consistent study archive or clearly labeled database-only snapshot |
| Archive library | Library ID and version | Readable historical library; mutations rejected |

Use response schemas to prevent accidentally serializing hidden grading fields. Validate all object ownership server-side, including IDs in nested arrays. Return typed errors for stale versions, missing keys, unimported files, unavailable models, quota failures and partial streams.

## 14. Deployment, backup and operations

### 14.1 Deployment defaults

Serve the application through an existing HTTPS proxy or tunnel; keep the application port bound to loopback or a private container network. Choose a free host port during deployment rather than copying an occupied example. Keep the host user/group IDs configurable instead of assuming 1000.

Initialize the single password through a protected bootstrap path, not an unauthenticated first-visitor setup page. Use argon2id as specified, secure HttpOnly session cookies, explicit SameSite policy, request-origin checks, anti-forgery tokens, login rate limits and session revocation. SameSite is defense in depth, not a replacement for anti-forgery protection. [D1, §13; R16; R17]

Disable development servers, debug traces, source maps containing sensitive configuration and broad proxy trust in production. Bundle browser assets locally. Keep provider credentials out of HTTP responses, logs, tools, calculator requests and normal backups.

### 14.2 Consistent backup

SQLite provides an online backup API; do not assume copying only the live `study.sqlite` file captures its current WAL-backed state. [R13]

Offer a clearly labeled database snapshot and a full study backup. A full backup includes original materials, assets, AI notes, a consistent SQLite snapshot, durable revisions, library mappings, migration version and a manifest of file hashes. Exclude caches, sockets, sessions where appropriate, provider credentials and server secrets.

For a full app-consistent snapshot, temporarily pause application writes and import activation, snapshot the database, and capture the corresponding file versions. Detect external file changes during capture; retry or label the archive unsuccessful rather than mixing revisions silently. The backup manifest lists the content generation and hashes.

Create archives first in a private staging directory, verify them, and expose download only after success. Encrypt off-host backup storage according to the deployment's chosen mechanism. A backup on the same server is not a disaster-recovery copy.

### 14.3 Restore procedure

Restore into a clean staging directory, validate paths and hashes, verify database integrity and schema version, and check referenced assets and revisions. Keep the current application intact until validation passes. Restore/reinitialize credentials through a separate protected procedure, invalidate old browser sessions, then activate the restored dataset.

A release is not complete until a clean-container restore demonstrates retained answers, sets, annotations, chats, citations, AI notes and Focus suppression behavior.

### 14.4 Observability and recovery

Expose separate liveness and readiness checks. Database readiness should not depend on provider availability. Log request IDs, operation IDs, counts, latencies and error codes, but not passwords, tokens or full private prompt bodies by default.

Settings should show database/import health, last successful backup, unresolved import issues, model availability, credential status without secrets, interrupted runs and calculator availability. A durable job table is enough initially; use leases/checkpoints to recover import and Focus jobs without duplicate note writes.

## 15. Sequenced implementation backlog

These are dependency-based milestones, not calendar estimates. Complete a milestone's acceptance checks before building features that depend on it.

### M0 — Behavioral contract and high-risk prototypes

Deliver the grading/state transition contract, representative Markdown fixtures, identity-matching examples, provider/authentication compatibility report and calculator isolation prototype. Record the exact package versions tested and unresolved account-specific blockers.

**Exit:** a minimal real authenticated AI response completes through the intended subscription route, or AI is explicitly marked blocked without blocking the independent study core; parser fixtures and isolation checks establish a viable path. No silent credential or model fallback.

### M1 — Secure foundation and durable schema

Create the workspace, CI, typed contracts, application shell, migration runner, session/bootstrap flow, SQLite configuration, shared renderer and mocked provider. Establish volume boundaries, operation IDs and record versions before adding mutations.

**Exit:** login/logout and protected routes work; fresh install and restart preserve a sample library; migrations and backups are testable; math/table rendering works on desktop and narrow screens.

### M2 — Import, reader and reconciliation

Implement configured material roots, metadata mappings, structural parser, staging preview, issue list, commit, source revisions and stable identities. Build the reconciliation screen and a minimal Materials reader.

**Exit:** mixed case/standalone banks import accurately; key-only changes retain records; rename and ambiguous-edit tests pass; repeated import is idempotent; rejected imports leave the active library intact.

### M3 — Practice without AI

Implement browser counts, set preview/creation, frozen order, cursor/resume, case grouping, question display, submission, inline corrections, confidence, flags, My note and cross-tab conflicts.

**Exit:** the end-to-end learning loop works across two browser sessions and survives restart; a new review is blank without erasing overall status; corrections do not create attempt counts.

### M4 — Safe editor, reimport and retrieval

Add the full-file editor with Preview tab, conflict detection, revisions and recovery journal. Implement heading/chunk indexes, related notes, source overlays and current/historical citation resolution.

**Exit:** external edits cannot silently overwrite detected changes; save/reimport failures are recoverable; retrieved results carry correct provenance; source moves do not break retained citations.

### M5 — Persistent tutor and restricted tools

Connect the tested provider adapter; add durable turns, streaming, cancellation, model recording and validated search/read/calculator tools. Enforce restricted pre-submit data views and prior-chat spoiler policy.

**Exit:** pre-submit network payloads and tool results contain no deliberate key/solution leakage; post-submit context is correct; disconnects do not duplicate turns or writes; quota failure leaves the study core working.

### M6 — Ask AI, History and AI notes

Complete the library-wide chat and scope selector, excerpt attachments, searchable history, source overlays, explicit note writes, note edits/revisions and persistent AI-origin labeling.

**Exit:** both sides of conversations are retrievable; note creation never changes a material hash; update collisions are safe; a changed/deleted source is handled honestly in citations.

### M7 — Focus and complete Progress

Build scoped evidence extraction, bounded manual jobs, structured suggestions, evidence validation, deduplication, Resolve/Delete suppression, Practice these and clickable count tables.

**Exit:** an unchanged rerun creates no duplicates; suppressed items stay suppressed without new evidence; invalid evidence is rejected; historical attempt frequencies are never invented.

### M8 — Release hardening and recovery

Complete full backup/restore, archiving, stress tests, accessibility/mobile checks, path/security tests, failure injection, deployment documentation and rollback procedure. Review operational defaults and remove development shortcuts.

**Exit:** all release-critical tests pass and a clean environment restores the complete study library. Benchmarks are recorded rather than assumed.

### Build dependency map

M0 informs M1; M1 enables M2; M2 enables M3 and M4; M3 + M4 + the successful AI gate enable M5; M5 enables M6; M3 + M6 enable M7; all converge into M8.

Move editor/reimport correctness earlier than the original last milestone because stable identities and editable keys are foundational to trustworthy practice. Keep backup primitives early, with the complete restore workflow finalized in M8.

## 16. Release acceptance tests

The cases below are concrete completion criteria, not merely a desired percentage of code coverage.

| ID | Scenario | Expected outcome |
|---|---|---|
| P01 | Submit the correct label with Sure | Correct; choice/Sure saved; source solution revealed; no auto-advance. |
| P02 | Submit the correct label with Unsure | Unsure; included in Wrong/Unsure review. |
| P03 | Submit a wrong label after choosing Unsure | Wrong; confidence cleared and hidden. |
| P04 | Correct a misclick in place | Same question and set item; latest selection updated; no attempt counter added. |
| P05 | Switch correct answer to a wrong answer | Wrong; confidence becomes empty. |
| P06 | Duplicate network delivery of one answer save | One committed mutation and one answer-sequence increment. |
| P07 | Two tabs edit from the same old version | First accepted write wins that version; stale write is rejected visibly, not silently applied. |
| P08 | Open a new review set | Blank per-set response; previous overall result remains until submission. |
| P09 | Revisit an older set | Shows its saved response; navigation alone does not change overall latest state. |
| P10 | Flag or change My note | Answer recency does not change; evidence revision may change. |
| P11 | Restart and resume | Same saved set and exact cursor; no answer loss. |
| P12 | Correct a Wrong answer inside a frozen review | Counts update; question remains in the set. |
| P13 | Rapidly change A to B to C with delayed replies | C is ultimately saved; old acknowledgements do not overwrite the latest local choice. |
| I01 | Chapter mixes standalone and case questions | Correct hierarchy and shared passages. |
| I02 | Repeated Question 1 under different cases | Distinct correct identities, no false duplicate. |
| I03 | Multiline choices with math and tables | Content and source locations preserved. |
| I04 | Missing solution | Readable question with explicit missing-source-solution message. |
| I05 | Invalid/ambiguous answer key | Import issue; no guessed grade. |
| I06 | Key changes B to C | Same stable identity; current responses regrade; no user-answer recency increment. |
| I07 | File rename without content changes | Unique identity retained; chats, notes and sets preserved. |
| I08 | Similar duplicate questions plus edits | Manual reconciliation; no silent reattachment. |
| I09 | Changed choice-label meanings | Incompatible response mapping is flagged rather than guessed. |
| I10 | Deleted material | Removed-source state; retained history; no new-set eligibility. |
| I11 | File changes after preview | Commit refuses stale preview. |
| I12 | Import crashes halfway | Prior active generation remains usable or recovery completes deterministically. |
| S01 | Pre-submit browser payload inspection | No hidden key or solution field. |
| S02 | Hint-mode search/read requests whole bank | Restricted content only; bypass denied. |
| S03 | Old solved chat in a new blank review | Not replayed into hint context; retained in History. |
| S04 | Forged/cross-library source handle | Rejected; no fabricated or foreign citation. |
| S05 | Source moved/edited after citation | Correct cited revision opens, with current-version option. |
| A01 | Model unavailable to account | Disabled with explanation; no silent model or billing fallback. |
| A02 | Credential expires or refresh fails | Typed setup/auth error; study core remains available. |
| A03 | Partial provider output followed by quota error | Message labeled incomplete/failed, not completed. |
| A04 | Browser reconnects during streaming | Same run; no duplicate user message or note creation. |
| A05 | Stop generation | Provider cancellation attempted and cancellation state persisted. |
| A06 | Retrieved text orders a material write | Treated as content; unauthorized operation denied. |
| A07 | Save as AI note | Separate labeled file; original materials unchanged. |
| A08 | AI note updated after an external edit | Hash conflict; no lost update. |
| F01 | Update Focus twice with identical evidence | No duplicate items. |
| F02 | Resolve/Delete then rerun without new evidence | Item not recreated. |
| F03 | Relevant new wrong answer or follow-up appears | Reconsideration permitted with new evidence cited. |
| F04 | Key correction invalidates a Focus claim | Evidence marked stale/rechecked; original accusation not treated as current fact. |
| C01 | Endless Python computation | Timeout; main app remains responsive. |
| C02 | Attempt network or app-file access | Denied by deployment/runtime boundaries. |
| C03 | Excess memory/output | Bounded failure and clean subsequent calculation. |
| E01 | Source changed since editor opened | Save refuses; draft remains recoverable. |
| E02 | Crash between file replacement and import | Journal/hash recovery restores coherent status. |
| H01 | Unauthenticated source/asset/backup request | Access denied. |
| H02 | Path traversal or escaping symlink | Access/write denied across all file endpoints. |
| H03 | Cross-site mutation attempt | Anti-forgery/origin policy rejects it. |
| H04 | Full restore into clean deployment | Answers, sets, chats, source revisions, notes and suppressions retained. |
| U01 | Small phone screen and on-screen keyboard | No page-wide overflow or composer covering required controls. |
| U02 | Keyboard navigation while typing | No accidental question navigation. |

Use Vitest for domain and transaction tests and Playwright for Chromium, Firefox and WebKit browser workflows. Playwright documents support for these engines and mobile emulation. Add a small real-device check where available; emulation is not a substitute for every physical-device behavior. [R18]

Run tests with a deterministic fake provider in ordinary CI. Keep a small separate authenticated compatibility suite for provider upgrades, never requiring private tokens in pull requests or exposing proprietary question banks in public logs.

## 17. Proposed performance and resource targets

These are engineering acceptance targets to measure on the actual host, not promises based on benchmarks already performed.

| Measure | Initial target |
|---|---|
| Answer/annotation save | Under 200 ms server-side at the 95th percentile, excluding network delay |
| Indexed scoped search | Under 300 ms server-side at the 95th percentile on the test corpus |
| Application behavior during AI outage | All non-AI study operations remain usable |
| Import work | Changed files only; CPU-heavy parsing outside request handlers |
| UI rendering | Paginated/lazy browser; bounded question-strip and chat DOM sizes |
| Foreground AI concurrency | One initial active run per account, one per chat |
| Calculator concurrency | One; resource bounds from §10 |
| Study-core memory | Initial budget around 512 MiB–1 GiB; measure renderer/import behavior before enforcing |
| Full deployment memory | Reserve separately for AI runtime and calculator; avoid unmeasured host-wide commitments |
| Recoverability | Retry-safe mutations and demonstrated restoration of all durable user data |

A synthetic benchmark should include a large provider bank, repeated headings, long cases, equations, tables, many saved sets and many messages. Measure peak import memory separately from normal reading/practice. Do not send the benchmark corpus wholesale to the hosted model.

## 18. Main risks and mitigations

| Risk | Mitigation and release gate |
|---|---|
| Incorrect record attachment after edits | Stable IDs, conservative fingerprints, explicit reconciliation and old-content retention. |
| Codex/pi-ai compatibility drift | Pinned adapter, actual account catalog, completed-request test and explicit setup blocker. |
| Surprise billing or quota use | Subscription-only route, no API-key fallback or automatic paid-credit opt-in, visible model and bounded runs. |
| Spoiler leakage through retrieval/history | Separate restricted fields/indexes, server-side serializers, scoped tools and regression tests. |
| AI note escapes its write root | ID-based note updates, path resolution, symlink checks and no material-writing AI tool. |
| Calculator escapes or exhausts resources | No-network isolated service, no sensitive mounts, host-enforced limits and fault tests. |
| Focus duplicates or unsupported accusations | Validated evidence, stable concept IDs, suppression records and no invented attempt statistics. |
| Corrupt/mismatched backup | Online database snapshot, captured source generation, manifest and clean restore test. |
| External editing race or partial save | Hash checks, application locks, atomic replace, operation journal and explicit residual-race documentation. |
| Keyword retrieval misses relevant concepts | Curated retrieval evaluation; small measured improvements before adding embeddings. |
| Model receives private/paid study content | Clear outbound-content disclosure, narrow context selection and no automatic external uploads/search. |
| Overengineering | Single database, one release, narrow helpers, no feature outside the stated study loop without a concrete reason. |

## 19. Traceability to the supplied design

| Source design section | Implementation coverage |
|---|---|
| 1–3: principles, concepts, features | §§1–2, 7 and all state/tool boundaries |
| 4: answers and done-tracking | §§4–5 and P01–P13 |
| 5: Practice and tutor | §§7, 9 and M3/M5 |
| 6: Focus and counts | §§11.2, 15/M7 and F01–F04 |
| 7: Ask AI, Materials, History, AI notes | §§7–9, 11.1 and M6 |
| 8: editor | §12, M4 and E01–E02 |
| 9: formats and import | §6, M2 and I01–I12 |
| 10: AI tools, account and rules | §§3, 8–11 and M0/M5/M6 |
| 11: data | §5 and migration/recovery tests |
| 12: architecture | §2, with stronger runtime boundaries |
| 13: hosting and backup | §14 and M8 |
| 14: build plan | §15, expanded and dependency-ordered |
| 15: open questions | Configurable choice labels and replaceable access layer in §1.1; no need to block the initial build on either |

## 20. Implementation handoff rules

Use the supplied design as the product authority and this document as the engineering plan. Treat explicitly marked resolutions as decisions to record in architecture notes, not as quotations from the original specification.

Build one vertical slice at a time with a passing acceptance test. Keep database migration ownership centralized. Frontend work can proceed against mocked contracts while the importer and provider adapter are developed independently, but merge only against the shared contract version.

The first usable slice is: **import a real bank → start a set → answer → correct a misclick → add My note → restart → resume**. Do not postpone proving that loop until after constructing a complex AI system.

The release-critical priorities are identity preservation, truthful saved-state behavior, safe source handling, subscription-auth verification and restore reliability. The AI layer must not become a dependency for ordinary study operations.

## Sources and verification notes

External references below were reviewed on October 14, 2026. They support factual compatibility and safety points; architecture and performance targets are proposed engineering decisions. No account-authenticated integration, benchmark or deployment was performed for this planning deliverable.

[D1] User-supplied `cfa-study-app-design.md`, sections 1–15.

[R1] pi-ai upstream README, credential stores and OAuth providers: https://github.com/earendil-works/pi/blob/main/packages/ai/README.md

[R2] OpenAI, Codex authentication and credential storage: https://learn.chatgpt.com/docs/auth

[R3] OpenAI, Sign in with ChatGPT — Models and inference: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference

[R4] OpenAI, Sign in with ChatGPT — Self-hosted VMs: https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms

[R5] OpenAI, Sign in with ChatGPT — Plan-usage overview: https://developers.openai.com/siwc/token-sharing-open-source

[R6] OpenAI model catalog: https://developers.openai.com/api/docs/models

[R7] Pyodide, Dealing with the file system: https://pyodide.org/en/stable/usage/file-system.html

[R8] Node.js, Worker threads — resourceLimits: https://nodejs.org/api/worker_threads.html

[R9] Docker, Resource constraints: https://docs.docker.com/engine/containers/resource_constraints/

[R10] Docker, None network driver: https://docs.docker.com/engine/network/drivers/none/

[R11] SQLite FTS5: https://sqlite.org/fts5.html

[R12] SQLite write-ahead logging: https://www.sqlite.org/wal.html

[R13] SQLite Online Backup API: https://www.sqlite.org/backup.html

[R14] Fastify, Validation and Serialization: https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/

[R15] remark parser: https://unifiedjs.com/explore/package/remark-parse/

[R16] OWASP, Cross-Site Request Forgery Prevention: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html

[R17] OWASP, Session Management: https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html

[R18] Playwright documentation: https://playwright.dev/docs/intro

[R19] Vitest documentation: https://vitest.dev/guide/

## TL;DR

- **Request** — Create a detailed implementation plan for the supplied CFA study-app design, choosing an appropriate programming language and stack.
- **Answer** — Build a TypeScript-first application with SQLite and restricted AI/calculator helpers; implement and test record identity, grading, set state and source safety first, then add persistent tutoring, Ask AI, AI notes, Focus and verified recovery.
