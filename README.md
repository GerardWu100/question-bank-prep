# Question Bank Prep

**A practice app for the CFA® exam and other multiple-choice exams, with an AI tutor built in.** Keep your question banks as plain Markdown, practise them by topic and chapter, see where you lose marks, and get hints and explanations from an AI tutor that cites your own notes. Use the desktop app (Linux, macOS, Windows) or host it yourself with Docker.

[![Tests](https://github.com/GerardWu100/question-bank-prep/actions/workflows/tests.yml/badge.svg)](https://github.com/GerardWu100/question-bank-prep/actions/workflows/tests.yml)
[![Desktop app](https://img.shields.io/github/v/release/GerardWu100/question-bank-prep?label=desktop%20app)](https://github.com/GerardWu100/question-bank-prep/releases/latest)
[![Docker image](https://img.shields.io/badge/docker-ghcr.io-2496ED?logo=docker&logoColor=white)](https://github.com/GerardWu100/question-bank-prep/pkgs/container/question-bank-prep)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/practice-dark.png">
  <img src="docs/images/practice-light.png" alt="Practice page: progress by topic and chapter, with Mistakes and Unsure sets">
</picture>

## Why

Commercial question banks lock your answers inside their site, and flashcard apps do not understand item sets, exhibits or formulas. This app keeps the questions in files you own and the study record on your machine.

- **Practice by topic and chapter**, with a progress bar per chapter and one-click **Mistakes**, **Unsure** and **★ Flagged** reviews.
- **Real exam formats**: standalone questions and CFA-style item sets with exhibits, tables and formulas.
- **Sure or unsure**: a lucky guess goes to the Unsure set instead of hiding among correct answers.
- **Your notes beside the questions** on the Materials page.
- **An AI tutor** under every question and note section (below).
- **Your data stays yours**: plain Markdown banks, one SQLite file for progress, and an export that moves your progress to another device.

<p>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/question-dark.png">
  <img src="docs/images/question-light.png" alt="A case question after answering: correct choice, key and worked solution" width="49%">
</picture>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/reader-dark.png">
  <img src="docs/images/reader-light.png" alt="Materials page: a study note with formulas and a symbol table" width="49%">
</picture>
</p>

## AI tutor

| Feature | What it does |
|---|---|
| **Hint** | Before you answer: one hint at a time; the tutor cannot see the key |
| **Explain** | After you answer: why the key is right and why your choice was wrong |
| **Explain this section** | On Materials: the section in plain words, with a worked example |
| **Review my study** | Finds your weak concepts and names the next three chapters to practise |
| **Cites your notes** | Searches your notes and names the file and section it used |

It runs on your ChatGPT subscription (through the Codex login) or on your own API key: OpenRouter (including free models), OpenAI, or any OpenAI-compatible service. Choose in **Settings → AI provider**. Practice works fully without AI.

## Get started

**Desktop app.** Download the installer from the [latest release](https://github.com/GerardWu100/question-bank-prep/releases/latest): `.AppImage` or `.deb` (Linux), `.dmg` (macOS), `.exe` (Windows). Open it, click **Create library**, then pick your folders in **File → Question-bank folder…** and **File → Study-notes folder…**. No password is needed. Already run a server? **File → Connect to a server…** uses its questions and progress instead. The installers are not signed: on macOS right-click → **Open**; on Windows **More info → Run anyway**.

**Server with Docker** (reach it from any device, with a password). Save this as `docker-compose.yml`, put `STUDY_PASSWORD=<a password>` in a `.env` file beside it, and run `docker compose up -d`:

```yaml
services:
  question-bank-prep:
    image: ghcr.io/gerardwu100/question-bank-prep:latest
    restart: unless-stopped
    user: "1000:1000"                 # your `id -u`:`id -g`
    ports:
      - "6848:3000"                   # open http://<server>:6848
    environment:
      - STUDY_PASSWORD=${STUDY_PASSWORD}
    volumes:
      - ~/.containers/question-bank-prep:/data            # progress and settings
      - ~/projects/cfa/question_bank:/question_bank:ro    # question banks
      - ~/projects/cfa/md_materials:/materials:ro         # study notes
```

To use the ChatGPT subscription inside Docker, see the [commented compose file](docker-compose.example.yml). Update with `docker compose pull && docker compose up -d`; your progress lives in `/data` and is kept.

The [user guide](docs/user/user-guide.md) walks through both, and the app's **Guide** tab explains every page.

## Build a bank from your PDFs

You do not type questions in. Give these prompts to an AI coding agent (Claude Code, Codex or similar) in your own study folder; they work for any exam.

| Step | Prompt | What you get |
|---|---|---|
| 1 | [PDF → Markdown](docs/prompts/pdf-to-markdown.md) | Faithful Markdown notes, shown on the Materials page |
| 2 | [Extract questions](docs/prompts/extract-questions.md) | Questions copied word for word into `question_bank/<topic>/<source>.md` |
| 3 | [Review the bank](docs/prompts/review-questions.md) | Duplicates removed, missing keys and short explanations added, marked as AI-written |
| 4 (optional) | [Redraw charts](docs/prompts/redraw-charts.md) | Charts left as text or page crops redrawn by code, in notes and bank |

A question is ordinary Markdown ([format guide](docs/user/question-format.md)):

```markdown
## Question 1
What is the present value of \$500 received in 2 years at 5%?

### Choices
A. \$453.51
B. \$476.19
C. \$551.25

### Answer
A

### Solution
$PV = 500 / 1.05^2 = 453.51$.
```

Keep your study folder private when it holds copyrighted material; this repository holds only the app and the prompts.

## More

- [User guide](docs/user/user-guide.md): install, daily use, AI setup, problems.
- [App reference](docs/reference/app-behavior.md): detailed behavior, Docker settings, running from source, backup, tests.
- [GUIDE_ROOT.md](GUIDE_ROOT.md): architecture and known limits, for developers.

## License and trademarks

[MIT](LICENSE). The license covers this repository's code and documents, not the question banks or study material you load. CFA® and Chartered Financial Analyst® are trademarks of CFA Institute. This project is not affiliated with or endorsed by CFA Institute and ships no exam questions; the screenshots use an original demo bank.
