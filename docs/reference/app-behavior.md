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
| The left side of each volume line | Those are the folders on your computer | Your `question_bank`, `md_materials` and sign-in folder; leave out the notes or the sign-in folder to run without that feature |
| A ChatGPT sign-in exists | The folder `${CODEX_HOME:-~/.codex}` is mounted read-write at `/codex`; only its `auth.json` is read | Make one with `one-time-projects/codex-auth-maker` (no Codex CLI needed). Without it only the ChatGPT connection is off |
| `AI_MAX_REQUESTS_PER_HOUR`, `AI_MAX_REQUESTS_PER_DAY` | Caps how many Codex requests the whole app sends (default 60 an hour, 300 a day), so a leaked password cannot drain your ChatGPT plan | Raise them if the tutor stops you during normal study; `0` turns a cap off |
| `HOST_UID`, `HOST_GID` in `.env` (from `id -u`, `id -g`), and the data folder made first | The database should belong to you, and the Codex login is readable only by you. The `/data`, `/question_bank` and `/materials` mounts use `create_host_path: false`, so Docker never creates a folder for root, and a missing bank folder stops the start instead of being synced as empty (which would remove every bank) | Required; the start stops without them. The app also stops with a message naming the folder when it cannot write there |
| `STUDY_PASSWORD` | The container listens beyond the server itself, so the app refuses to start without a password (Compose also refuses to start without it) | Set it in `.env` |
| `TRUST_PROXY` | Behind a reverse proxy that serves HTTPS, the login cookie should be marked Secure and the login limit should count each visitor, not the proxy | Set `TRUST_PROXY=true` in that case; forwarding headers then count only from a proxy on the same machine or a private network (Docker networks included). Leave `false` when the app is reached directly |

Then open **`http://<server address>:6848`** and sign in.

### On the public internet

1. Put an HTTPS reverse proxy (Caddy, nginx, Traefik) in front, on the `single` network or the same machine.
2. Let only the proxy reach the app: change the ports line to `"127.0.0.1:6848:3000"`, or remove it when the proxy joins the `single` network.
3. Set `TRUST_PROXY=true`. The login cookie is then `Secure`, HTTPS responses carry HSTS, and the limit of 10 password attempts per 15 minutes counts each visitor.
4. Use a long random `STUDY_PASSWORD` (for example `openssl rand -base64 24`); it is the only lock.
5. Keep the AI request caps on, so a leaked password cannot drain your plan or API credit.

Every response carries a Content-Security-Policy (scripts only from the app), `X-Frame-Options: DENY` and `nosniff`. A saved API key is sent only to the base URL it was saved with: changing the URL asks for the key again. The question folder syncs every time the app opens; the database lives in `/data`.

### Update

| Installed with | Update with |
|---|---|
| Compose | `docker compose pull && docker compose up -d` |
| `docker run` | `docker pull ghcr.io/gerardwu100/question-bank-prep:latest`, then `docker rm -f question-bank-prep`, then the same `docker run` command again |

Your progress, chats and notes live in `/data`, not in the container, so updating never loses them. **Pin a version** by replacing `latest` with `1`, `1.0` or `1.0.0` once releases are tagged (`git tag v1.0.0 && git push --tags` publishes them).

## Banks and practice

Set `MATERIAL_ROOT` in `.env` to a folder of bank files: the app syncs it every time a library opens (Settings → Folders → Sync now forces it), and the upload button is hidden. The desktop app sets `MATERIAL_ROOT` and `READING_ROOT` from **Settings → Folders** (or the File menu): each **Choose folder…** opens the system folder picker, saves the path and restarts the app; the page can reach this picker only in local mode, never on a connected server. A file deleted from the folder (even the last one) leaves practice; its answers stay as history, and putting back the identical file brings back the same questions with their answers, flags, notes and chats. A folder that cannot be read is reported as an error and changes nothing. Without a folder, **Settings → Folders → Upload a folder…** picks a whole bank folder (every `.md` file in it and its subfolders; `README.md` and `.git` are skipped; the first subfolder becomes the topic and the file name the source, as with `MATERIAL_ROOT`). Preview, then confirm. Materials are never uploaded: they come only from `READING_ROOT`. **The full format guide is [docs/user/question-format.md](docs/user/question-format.md)**, with working examples in [examples/](examples). In short:

```markdown
# Chapter 1

## AI and calculator

**Settings → AI provider** lists the AI connections for the whole app, tried top to bottom. A connection is the **ChatGPT subscription** (a Codex-format `auth.json`) or an **API key**: Anthropic (`https://api.anthropic.com`, Messages API) or any OpenAI-compatible Chat Completions endpoint (presets: OpenAI, OpenRouter, DeepSeek, Groq, Google Gemini, a local Ollama). **+ Anthropic key** fills Anthropic's base URL and `claude-sonnet-5-5`, `claude-opus-5-5`; a key starting `sk-ant-` pasted into any API connection moves it to Anthropic's base URL (and fills those models when the list is empty). Each lists its model IDs, one per line; the first is its backup model. A reply goes to the connection that offers the chosen model. If that fails before any text arrives (no sign-in, expired login, bad key, rate limit, server error), the next ready connection answers with its first model, and the reply records which model and connection answered; when all fail, the error lists each one's reason. Usage caps, a cancel and the output limit never fall back. **Browse the endpoint's models** lists what a saved API connection offers (OpenRouter marks free ones; filter for `free`). On OpenRouter, `openrouter/free` routes to whichever free model is up; a model marked "no tools" cannot search your notes or use the calculator. Keys are saved in `ai-settings.json` in the data folder (owner-only file permissions), never in the database or backups, and never sent back to the browser. The ChatGPT sign-in is `CODEX_AUTH_FILE`, else `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. A file made by `one-time-projects/codex-auth-maker` is app-owned: the app refreshes it under a shared lock, so a server needs no Codex CLI. A Codex CLI file is only read; reopen Codex when it expires. The ChatGPT models offered are those you list that the pinned pi-ai catalog knows. Every model request (one per reply plus one per tool round, fallback attempts included) counts toward a project-wide cap, `AI_MAX_REQUESTS_PER_HOUR` (default 60) and `AI_MAX_REQUESTS_PER_DAY` (default 300), kept in `ai-usage.json` in the data folder so a restart does not reset it; past the cap the tutor says when it can answer again. Only explicitly sent context and retrieved excerpts go to the provider. Pick the tutor model (the menu names each model's connection; a model marked **not ready** still needs its key or sign-in, and hovering it says which) and its **Thinking** level once on **Settings → AI model** (stored with the library; default `gpt-6.1-sol` at medium). The chat box has no model picker: Enter sends, Shift+Enter adds a line. **Review my study** (Ask AI page) has the tutor read your per-chapter results and mistakes, the questions you asked it, and your notes, then name your weak concepts and the next 3 chapters to practise. **Hint** (before you answer) and **Explain** (after you answer, and under each material section) send a ready-made request. With `READING_ROOT` set, the tutor can search your study notes (a read-only `rg`, or a built-in `search_study_notes` where ripgrep is not installed, plus `list_files` like ls/find and `read_file` by line offset, all locked to that folder; no general shell) to cite the exact file and section; these tools are off in hint mode because the notes include solved question banks. When the model returns a reasoning summary, the reply shows a folded **Reasoning** line above it. The tutor writes math with `$`/`$$` (`\[ \]` and `\( \)` are converted too) and ends with a `Source:` line naming the notes or library sources it used (left out under a practice question when it used only that question). After you answer, the tutor also sees your choice and whether it was right, so Explain addresses your mistake. Ask AI sits directly below each practice question; the conversation is saved per question (your messages and the tutor's replies, with model and sources) and reopens when you return to that question, and History lists every conversation, grouped as Materials, Practice questions or Ask AI. Buttons at the top of History show all conversations or one group, remembered in this browser. Deleting a conversation removes it and its runs, stops a reply still streaming into it, and keeps AI notes saved from it (they lose **Continue this chat**). **Continue this chat** on a saved AI note from a material section reopens that section first; if the section is gone, the chat says so and cannot be continued. Before you answer, hint-mode messages are shown only in the set where they were written.

The calculator runs each job in a fresh Node process with Pyodide, time and output limits, and an empty environment. Node's permission model lets that process read only Pyodide and its own script: no other files (database, API keys, sign-in, `.env`), no writes and no child processes, even if code gets past the Python filter. It may still open network connections, and WebAssembly memory has no hard cap.

## Back up and restore

```sh
npm run backup -- backup app-data/study.sqlite app-data/backups/study.sqlite
npm run backup -- restore app-data/backups/study.sqlite app-data/restored/study.sqlite
```

The snapshot contains imported source versions and all database records; it does not copy credentials or unrelated external-folder files. Keep its adjacent checksum manifest. Restore accepts only a new destination, verifies the checksum and SQLite integrity, and never overwrites a live database. Stop the app before switching `STUDY_DATA_DIR` to the restored directory (name the restored file `study.sqlite`). Logins are stored in the database (as hashes), so they survive restarts; restoring a backup restores its logins too.

The study-data export (answers, flags, question notes and notes) moves progress to a library that holds the same bank. Import applies an entry only to the one question with the same content (fingerprint) and, when several have it, the same file path, chapter, case and number; entries that fit no question or more than one are listed and change nothing. Older exports without path, chapter and case still import.

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
