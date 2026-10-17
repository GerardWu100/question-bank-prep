# Question Bank Prep

A local, single-user study application for prepared Markdown question banks. Practice is independent of the AI provider. Answers, frozen review sets, annotations, imported sources, revisions, chats and review items live in SQLite.

## Run with Docker

```sh
docker build --target app -t question-bank-prep .
docker run --rm -p 127.0.0.1:3000:3000 -e STUDY_PASSWORD=change-me -v question-bank-data:/app/app-data question-bank-prep
```

Open `http://127.0.0.1:3000` and sign in with the password. A container listens on a non-loopback address, so it needs `STUDY_PASSWORD`. The named volume keeps the database between runs. AI needs a Codex login inside the container; mounting one read-only (`-v ~/.codex:/root/.codex:ro`) is untested.

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

Import Markdown through Materials. Select `note` for reading material without question headings. **The full format guide is [docs/user/question-format.md](docs/user/question-format.md)**, with working examples in [examples/](examples). In short:

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

The app tracks two distinct answers: the latest overall answer, and the answer within each set. Starting another set leaves that set blank while retaining the overall result. Sure/Unsure applies only to correct answers. A saved response means done, not mastery.

## CFA material prompts

The CFA Level II bank is built in two steps, both run in the private `cfa` repository so no study text lands in this public repository:

1. **PDF → Markdown:** [docs/prompts/pdf-to-markdown.md](docs/prompts/pdf-to-markdown.md) converted `materials/` PDFs into `md_materials/` (finished).
2. **Markdown → question bank:** send [docs/prompts/extract-questions.md](docs/prompts/extract-questions.md); it runs the `cfa-question-bank` skill in `cfa/.agents/skills/cfa-question-bank/` (`SKILL.md`, `template.md`, `sources.md`), which extracts questions into `cfa/question_bank/<NN-topic>/<source>.md`.

## AI and calculator

AI uses the existing Codex ChatGPT subscription login read-only through the pinned pi-ai adapter. It does not refresh or copy credentials and has no API-key billing fallback. Codex remains the credential refresh owner. The app checks the local account model catalog and disables unavailable models; reopen Codex if its catalog or login has expired. Only explicitly sent context and retrieved excerpts go to the provider.

The calculator uses a disposable Pyodide worker with time and output limits. It needs no Docker. This is practical local containment, **not an operating-system sandbox** or a hard host memory limit. Do not expose it to untrusted public users.

## Back up and restore

```sh
npm run backup -- backup app-data/study.sqlite app-data/backups/study.sqlite
npm run backup -- restore app-data/backups/study.sqlite app-data/restored/study.sqlite
```

The snapshot contains imported source versions and all database records; it does not copy credentials or unrelated external-folder files. Keep its adjacent checksum manifest. Restore accepts only a new destination, verifies the checksum and SQLite integrity, and never overwrites a live database. Stop the app before switching `STUDY_DATA_DIR` to the restored directory (name the restored file `study.sqlite`). Browser sessions are invalidated on restart.

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

Tests use synthetic material and the files in `examples/`, not a proprietary bank. See [GUIDE_ROOT.md](GUIDE_ROOT.md) for architecture, known limits and acceptance evidence.
