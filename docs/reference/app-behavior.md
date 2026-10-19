# App reference

Detailed behavior behind the short [README](../../README.md). Users start with the [user guide](../user/user-guide.md) or the **Guide** tab inside the app; developers also read [GUIDE_ROOT.md](../../GUIDE_ROOT.md).

## Build the desktop app

Build it yourself: `npm ci && npm run build && npm run build:desktop`, then in `apps/desktop` run `npm ci` and `npm run dist` (installers for the current system land in `apps/desktop/release`). `npm start` there runs it without packaging. Pushing a `v*.*.*` tag builds every platform in GitHub Actions and attaches the installers to a release.

## Run from source

Requires Node.js 24 or newer and npm. Native SQLite installation requires a working C++ toolchain when no matching binary is available.

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:3000`. The default binds only to this computer. Copy `.env.example` to `.env` to set a password, storage directory, port or existing material folder. The app refuses a non-loopback listener without a password. Use HTTPS through a trusted reverse proxy for remote hosting.

For interface development, run `npm run dev` and `npm run dev:web` in separate terminals, then open `http://127.0.0.1:5173`.

## Docker settings

### What to check before starting

| Check | Why | What to change |
|---|---|---|
| The left side of each volume line | Those are the folders on your computer | Your `question_bank`, `md_materials` and Codex files; leave out the notes or both Codex entries to run without that feature |
| Codex login files exist | Only `~/.codex/auth.json` and `~/.codex/models_cache.json` go into the container, never the rest of `~/.codex`; the container refuses to start if either is missing | Sign in to Codex with ChatGPT and open it once; after `codex logout` and a new login, restart the container |
| `AI_MAX_REQUESTS_PER_HOUR`, `AI_MAX_REQUESTS_PER_DAY` | Caps how many Codex requests the whole app sends (default 60 an hour, 300 a day), so a leaked password cannot drain your ChatGPT plan | Raise them if the tutor stops you during normal study; `0` turns a cap off |
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

## Banks and practice

Set `MATERIAL_ROOT` in `.env` to a folder of bank files: the app syncs it every time a library opens (Settings → Sync folder now forces it), and the manual import panel is hidden. Without a folder, import on the Materials page: **Choose a folder** picks a whole bank folder (every `.md` file in it and its subfolders; `README.md` and `.git` are skipped; the first subfolder becomes the topic and the file name the source, as with `MATERIAL_ROOT`), or **Choose a file** picks one bank file. Preview, then confirm. **The full format guide is [docs/user/question-format.md](docs/user/question-format.md)**, with working examples in [examples/](examples). In short:

```markdown
# Chapter 1

## AI and calculator

**Settings → AI provider** chooses where tutor requests go, for the whole app. **ChatGPT subscription (Codex login)** (the default) uses the existing Codex login read-only through the pinned pi-ai adapter; it does not refresh or copy credentials, and Codex remains the credential refresh owner. **API key** sends requests to any OpenAI-compatible Chat Completions endpoint (base URL presets: OpenRouter, OpenAI, DeepSeek, Groq, Google Gemini, a local Ollama) with your key, to the model IDs you list one per line; **Browse the endpoint's models** lists what the endpoint offers (OpenRouter marks free ones; filter for `free`). On OpenRouter, `openrouter/free` routes to whichever free model is up; a model marked "no tools" cannot search your notes or use the calculator. The key is saved in `ai-settings.json` in the data folder (owner-only file permissions), never in the database or backups, and never sent back to the browser. Switching never falls back silently: a request fails with the provider's error instead. In Docker only the login file and model list are mounted, not the whole `~/.codex` folder. Every model request (one per reply plus one per tool round) counts toward a project-wide cap, `AI_MAX_REQUESTS_PER_HOUR` (default 60) and `AI_MAX_REQUESTS_PER_DAY` (default 300), kept in `ai-usage.json` in the data folder so a restart does not reset it; past the cap the tutor says when it can answer again. The app checks the local account model catalog and disables unavailable models; reopen Codex if its catalog or login has expired. Only explicitly sent context and retrieved excerpts go to the provider. Every model Codex lists for your account is offered (or your API model list); pick the tutor model and, for Codex models, its **Thinking** level once on **Settings → AI model** (stored with the library; defaults `gpt-6.1-sol` and the model's Codex default level, or the first API model). The chat box has no model picker: Enter sends, Shift+Enter adds a line. **Review my study** (Ask AI page) has the tutor read your per-chapter results and mistakes, the questions you asked it, and your notes, then name your weak concepts and the next 3 chapters to practise. **Hint** (before you answer) and **Explain** (after you answer, and under each material section) send a ready-made request. With `READING_ROOT` set, the tutor can search your study notes (a read-only `rg`, or a built-in `search_study_notes` where ripgrep is not installed, plus `list_files` like ls/find and `read_file` by line offset, all locked to that folder; no general shell) to cite the exact file and section; these tools are off in hint mode because the notes include solved question banks. When the model returns a reasoning summary, the reply shows a folded **Reasoning** line above it. The tutor writes math with `$`/`$$` (`\[ \]` and `\( \)` are converted too) and ends with a `Source:` line naming the notes or library sources it used (left out under a practice question when it used only that question). After you answer, the tutor also sees your choice and whether it was right, so Explain addresses your mistake. Ask AI sits directly below each practice question; the conversation is saved per question (your messages and the tutor's replies, with model and sources) and reopens when you return to that question, and History lists every conversation, grouped as Materials, Practice questions or Ask AI. Buttons at the top of History show all conversations or one group, remembered in this browser. Deleting a conversation removes it and its runs, stops a reply still streaming into it, and keeps AI notes saved from it (they lose **Continue this chat**). Before you answer, hint-mode messages are shown only in the set where they were written.

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

Tests use synthetic material and the files in `examples/`, not a proprietary bank. Browser tests use the production build on port 3100, a fresh temporary database, and bundled reading fixtures; they refuse to reuse a running server. Run the build first. The default `npm run test:e2e` runs each spec file with a fresh server so cumulative test traffic does not exhaust the production request limit. To run one focused selection, use `npm run test:e2e -- tests/e2e/resume.spec.ts`; explicit arguments are passed to one Playwright invocation. See [GUIDE_ROOT.md](GUIDE_ROOT.md) for architecture, known limits and acceptance evidence.
