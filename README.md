# Question Bank Prep

A local, single-user study application for prepared Markdown question banks. Practice is independent of the AI provider. Answers, frozen review sets, annotations, imported sources, revisions, chats and review items live in SQLite.

## Run with Docker

You need a computer that stays on, with [Docker](https://docs.docker.com/engine/install/). No clone and no build: the image is published for ordinary PCs and servers (amd64) and Raspberry Pi or ARM servers (arm64).

### Option A: Docker Compose (recommended)

Save this as `docker-compose.yml` in an empty folder, and put `STUDY_PASSWORD=<a password>` in a file named `.env` beside it:

```yaml
services:
  question-bank-prep:
    image: ghcr.io/gerardwu100/question-bank-prep:latest
    container_name: question-bank-prep
    restart: unless-stopped
    user: "1000:1000"                 # your `id -u`:`id -g`
    ports:
      - "6848:3000"                   # web page at http://<server>:6848
    environment:
      - TZ=America/Toronto
      - STUDY_PASSWORD=${STUDY_PASSWORD}
    volumes:
      - ~/.containers/question-bank-prep:/data              # database and backups
      - ~/projects/cfa/question_bank:/question_bank:ro      # question banks
      - ~/projects/cfa/md_materials:/materials:ro           # study notes
      - ~/.codex:/codex:ro                                  # Codex login, for the tutor
```

Then start it from that folder:

```bash
docker compose up -d
```

A [fully commented version](docker-compose.example.yml) of this file is in the repository too. It also joins a Docker network named `single`, where a reverse proxy can reach it. [`docker-compose.yml`](docker-compose.yml) builds the same service from a checkout.

### Option B: one `docker run` command

```bash
docker run -d --name question-bank-prep --restart unless-stopped \
  --user 1000:1000 -p 6848:3000 \
  -e TZ=America/Toronto -e STUDY_PASSWORD=change-me \
  -v ~/.containers/question-bank-prep:/data \
  -v ~/projects/cfa/question_bank:/question_bank:ro \
  -v ~/projects/cfa/md_materials:/materials:ro \
  -v ~/.codex:/codex:ro \
  ghcr.io/gerardwu100/question-bank-prep:latest
```

### Before you start: three things to check

| Check | Why | What to change |
|---|---|---|
| The left side of each volume line | Those are the folders on your computer | Your `question_bank`, `md_materials` and Codex folders; leave out the notes or Codex line to run without that feature |
| Run `id -u` and `id -g` | The database should belong to you, and the Codex login is readable only by you | If either is not `1000`, change `user:` |
| `STUDY_PASSWORD` | The container listens beyond the server itself, so the app refuses to start without a password (Compose also refuses to start without it) | Set it in `.env` |
| `TRUST_PROXY` | Behind a reverse proxy that serves HTTPS, the login cookie should be marked Secure | Set `TRUST_PROXY=true` only in that case; leave `false` when the app is reached directly |

Then open **`http://<server address>:6848`** and sign in. The question folder syncs every time the app opens; the database lives in `/data`.

### Update

| Installed with | Update with |
|---|---|
| Compose | `docker compose pull && docker compose up -d` |
| `docker run` | `docker pull ghcr.io/gerardwu100/question-bank-prep:latest`, then `docker rm -f question-bank-prep`, then the same `docker run` command again |

Your progress, chats and notes live in `/data`, not in the container, so updating never loses them. **Pin a version** by replacing `latest` with `1`, `1.0` or `1.0.0` once releases are tagged (`git tag v1.0.0 && git push --tags` publishes them).

## Run without Docker

Requires Node.js 24 or newer and npm. Native SQLite installation requires a working C++ toolchain when no matching binary is available.

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:3000`. The default binds only to this computer. Copy `.env.example` to `.env` to set a password, storage directory, port or existing material folder. The app refuses a non-loopback listener without a password. Use HTTPS through a trusted reverse proxy for remote hosting.

For interface development, run `npm run dev` and `npm run dev:web` in separate terminals, then open `http://127.0.0.1:5173`.

## Prepare a bank

Set `MATERIAL_ROOT` in `.env` to a folder of bank files: the app syncs it every time a library opens (Settings → Sync folder now forces it), and the manual import panel is hidden. Without a folder, import Markdown through Materials. Select `note` for reading material without question headings. **The full format guide is [docs/user/question-format.md](docs/user/question-format.md)**, with working examples in [examples/](examples). In short:

```markdown
# Chapter 1

## Question 1
What is two plus two?

### Choices
A. Three
B. Four
C. Five

### Answer
B

### Solution
Two pairs make four.
```

Put `Question` headings one level below a `Case` heading to share its passage. Keep choice, answer and solution headings one level deeper than the question. Preview reports missing keys and structural errors before committing; `npm run check-bank -- <file-or-folder>` runs the same checks from the command line. Missing keys remain readable but cannot be graded. Choices never shuffle. Review sets retain their membership and order after answers change.

The Practice page has one toggle per source (switch a source off to practise only the others; remembered per browser) and lists every topic as a foldable panel (all open until you fold one), with an "All chapters" line and one line per chapter (sources are merged; each chapter names its sources in small text), each with a progress bar (green correct, amber unsure, red wrong), answered/total and accuracy. **Start / Continue / Review** reopens that chapter's set where you left off (the first unanswered question); **Mistakes** and **Unsure** (shown when there are any) build sets of your wrong and unsure-but-correct questions; one central **★ Flagged** button at the top practises all starred questions from every source, even sources switched off. Unsure answers count as correct in the accuracy figure. After a wrong answer, a small **Misclicked** button beside Previous/Next re-saves the key so a slip does not land in Mistakes. Answers are remembered across sets: a question you answered anywhere shows your latest answer and its solution. A folded **Custom practice set** builder filters by **Topic** (the bank's folder, such as `01-quantitative-methods`), **Source** (the file name) and **Chapter**; each option shows answered/total. The number strip colours finished questions by result (green correct, amber unsure, red wrong). The URL keeps the current page and open set, so refresh stays in place and the browser Back button returns to the previous view. Free-form notes live on the **Notes** page (Markdown, editable), with separate **My notes** and **AI notes** (saved tutor replies) tabs; any note can be deleted after a confirmation. **Settings → Export** downloads my notes and AI notes (Markdown) and progress (CSV, one row per answered question: topic, source, chapter, your answer, key, result, flag). There is no per-question note box.

Set `READING_ROOT` in `.env` to a folder of Markdown study material (for example `cfa/md_materials`) to read it on the **Materials** page: files grouped by folder, long files split into sections with Previous/Next (a whole-curriculum file whose top headings are the CFA topics opens as one section per topic), images and Mermaid diagrams shown, last place remembered, and an **Ask AI about this section** box under each section that sends that section to the tutor as context (the conversation is saved per section). It is read-only; the upload import appears there only when no `MATERIAL_ROOT` is set. The header has **A− / A+** (text size) and a theme switch (Auto, Light, Dark), remembered per browser; both themes keep body text at high contrast and use bundled fonts, so the app looks the same on every device. Sources are read-only in the app; there is no editor and no Progress page. The app tracks two distinct answers: the latest overall answer, and the answer within each set. A set without its own answer for a question shows the latest overall answer; answering again in a set updates both. Sure/Unsure applies only to correct answers. A saved response means done, not mastery.

## CFA material prompts

The prompts below and the two skills (`.agents/skills/cfa-question-bank`, `.agents/skills/cfa-question-review`) are kept identical in this repository and in `cfa`. The CFA Level II bank is built in three steps, both run in the private `cfa` repository so no study text lands in this public repository:

1. **PDF → Markdown:** [docs/prompts/pdf-to-markdown.md](docs/prompts/pdf-to-markdown.md) converted `materials/` PDFs into `md_materials/` (finished).
2. **Markdown → question bank:** send [docs/prompts/extract-questions.md](docs/prompts/extract-questions.md); it runs the `cfa-question-bank` skill in `cfa/.agents/skills/cfa-question-bank/` (`SKILL.md`, `template.md`, `sources.md`), which extracts questions into `cfa/question_bank/<NN-topic>/<source>.md`.
3. **Dedupe and missing answers:** send [docs/prompts/review-questions.md](docs/prompts/review-questions.md); the `cfa-question-review` skill removes duplicate and near-duplicate questions (`npm run find-duplicates -- <bank-folder>` lists candidates) and writes missing keys under an `Answer (AI)` heading; the app keeps that marker in its data but does not show it while you practise.

## AI and calculator

AI uses the existing Codex ChatGPT subscription login read-only through the pinned pi-ai adapter. It does not refresh or copy credentials and has no API-key billing fallback. Codex remains the credential refresh owner. The app checks the local account model catalog and disables unavailable models; reopen Codex if its catalog or login has expired. Only explicitly sent context and retrieved excerpts go to the provider. Every model Codex lists for your account is offered; pick the tutor model and its **Thinking** level (the levels Codex lists for that model) once on **Settings → AI model** (stored with the library; defaults `gpt-6.1-sol` and the model's Codex default level). The chat box has no model picker: Enter sends, Shift+Enter adds a line. **Review my study** (Ask AI page) has the tutor read your per-chapter results and mistakes, the questions you asked it, and your notes, then name your weak concepts and the next 3 chapters to practise. **Hint** (before you answer) and **Explain** (after you answer, and under each material section) send a ready-made request. With `READING_ROOT` set, the tutor can search your study notes (a read-only `rg`, or a built-in `search_study_notes` where ripgrep is not installed, plus `list_files` like ls/find and `read_file` by line offset, all locked to that folder; no general shell) to cite the exact file and section; these tools are off in hint mode because the notes include solved question banks. When the model returns a reasoning summary, the reply shows a folded **Reasoning** line above it. The tutor writes math with `$`/`$$` (`\[ \]` and `\( \)` are converted too) and ends with a `Source:` line naming the notes or library sources it used (left out under a practice question when it used only that question). After you answer, the tutor also sees your choice and whether it was right, so Explain addresses your mistake. Ask AI sits directly below each practice question; the conversation is saved per question (your messages and the tutor's replies, with model and sources) and reopens when you return to that question, and History lists every conversation. Before you answer, hint-mode messages are shown only in the set where they were written.

The calculator uses a disposable Pyodide worker with time and output limits. It needs no Docker. This is practical local containment, **not an operating-system sandbox** or a hard host memory limit. Do not expose it to untrusted public users.

## Back up and restore

```sh
npm run backup -- backup app-data/study.sqlite app-data/backups/study.sqlite
npm run backup -- restore app-data/backups/study.sqlite app-data/restored/study.sqlite
```

The snapshot contains imported source versions and all database records; it does not copy credentials or unrelated external-folder files. Keep its adjacent checksum manifest. Restore accepts only a new destination, verifies the checksum and SQLite integrity, and never overwrites a live database. Stop the app before switching `STUDY_DATA_DIR` to the restored directory (name the restored file `study.sqlite`). Logins are stored in the database (as hashes), so they survive restarts; restoring a backup restores its logins too.

Local-folder editor saves retain journals under the data directory until reimport succeeds. Settings shows pending recovery. If an external editor changes the file, resolve the conflict before retrying; the app does not silently discard that edit.

## Verify

The test image runs the type check, unit tests, production build and Chromium browser tests on Node 24 (Linux):

```sh
docker build --target test -t question-bank-prep-test .
docker run --rm question-bank-prep-test
```

Or natively:

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Tests use synthetic material and the files in `examples/`, not a proprietary bank. Browser tests use the production build on port 3100, a fresh temporary database, and bundled reading fixtures; they refuse to reuse a running server. Run the build first. See [GUIDE_ROOT.md](GUIDE_ROOT.md) for architecture, known limits and acceptance evidence.
