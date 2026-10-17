---
name: cfa-question-bank
description: Extract multiple-choice questions from the CFA Level II study material in md_materials/ into the question_bank/ practice files, one folder per topic, in the format the question-bank-prep study app imports. Use when the user asks to extract, convert, add, or check CFA practice questions, item sets, quizzes, or the question bank. Do not use for writing study notes or converting PDFs to Markdown.
---

# CFA question bank extraction

> This skill is kept in both the `cfa` and `question-bank-prep` repositories (`.agents/skills/`); keep the two copies identical. Run it from the `cfa` repository root: its logs (`sources.md`, `review-log.md`) belong to the `cfa` copy, which works on the data.

Turn questions in `md_materials/` into practice files under `question_bank/`. The files are imported by the study app in `../one-time-projects/question-bank-prep` (paths in this skill are relative to the `cfa` repository root). That app's parser rules are in its `docs/user/question-format.md`; this skill adds CFA naming on top.

Read these first:

- [template.md](template.md) — the exact output layout. Its text is shortened for illustration; real files copy everything in full.
- [sources.md](sources.md) — topic codes, source codes, where each source keeps its answer key, and extraction status.
- `notes/CFA_Level_II_Curriculum.md` — the 51 learning modules (LM) used as chapters.

## Storage layout

```text
question_bank/
├── 01-quantitative-methods/
│   ├── jc-100-combined.md        ← one file per source per topic
│   ├── qbank-2025.md
│   └── assets/                   ← images copied from md_materials, if any
├── 02-economics/
│   ...
└── 10-ethics/
```

- Only bank files go in `question_bank/`. The app imports **every** `.md` there as questions, so no README or notes files inside.
- One file per source per topic keeps files small enough to check, and lets you re-extract one source without touching others.

## Output rules

### Headings (depth matters)

| Depth | Heading | Use |
|---|---|---|
| `#` | `CFA L2 · <NN> <Topic> · <Source name>` | File title, once, followed by one line naming the source path |
| `#` | `Chapter LM<NN> <LM title>` | One per learning module that has at least one question, in LM order. LM number has two digits. |
| `##` | `Case <TOPIC>-<SRC>-C<NN> <case name>` | Item set passage. Its exhibits and other sub-headings come before its first question, re-levelled to `###` or deeper so they nest under the case. Keep their titles as in the source. |
| `###` | `Question <TOPIC>-<SRC>-C<NN>-<n>` | Question inside a case; its `Choices`/`Answer`/`Solution` use `####` |
| `##` | `Question <TOPIC>-<SRC>-<id>` | Standalone question; its `Choices`/`Answer`/`Solution` use `###` |

- `<TOPIC>` and `<SRC>` are the codes in [sources.md](sources.md). `<id>` is the source's own stable identifier when it has one (Qbank `Question ID`, Kaplan quiz `1.1-3`), else a running number.
- Question IDs must be unique within the whole bank. Never reuse an ID for a different question.
- `C<NN>` is the source's own case number; if the source has none, number cases C01, C02… in source order. Name a case after its main person or company, else a 2–4 word subject. Cases are reordered by LM, so gaps and out-of-order numbers are expected.
- A case whose questions span two LMs goes under the LM most of its questions test. On a tie, use the LM the passage mainly describes; if still tied, the higher LM number. Choose only among the tied LMs. Never split a case.

### Content

- **Copy word for word**: passage, exhibits, stem, choices, solution. Do not summarize, reword, correct, or add content. Keep math (`$...$`, `$$...$$`), `\$` currency escapes, tables, Mermaid and text charts exactly as in `md_materials`.
- **Fix only broken Markdown** while copying, following the math rules in question-bank-prep's `docs/prompts/pdf-to-markdown.md`: put each `$$` fence alone on its line, wrap `&` alignment in `\begin{aligned}`, replace `\(…\)` / `\[…\]` with `$…$` / `$$…$$`, and `<br>` in tables with `; `. Never change the words or numbers.
- **Choices**: one per line as `A. text`, blank line between choices. Convert `A)`, `A:`, `- A.` and `**A.**` to `A.`. **Delete answer markers such as `[Correct]` / `[Incorrect]`** — they leak the key.
- **Choices in a table** (rows `| A. | x | y |`): the parser cannot read them. Keep the table in the stem, then add a `Choices` section with `A. x, y` built from each row's cells in column order. This is the only text you may add.
- **Answer**: one letter only on the first line.
- **Solution**: the source's explanation, then a last line `*Source: <source name>, <location>; <publisher LOS ref if given>.*` so you can trace it. Keep any error flag as `> Source note: ...` in the solution of the question it concerns, including fidelity notes added during PDF-to-Markdown conversion. Split a note that covers several questions into one note per question, keeping the original words.
- **No key in the source**: leave out the `Answer` heading and write `> Key not given in source.` in the solution. Never solve the question to make a key here; step 3 (skill `cfa-question-review`) writes marked `Answer (AI)` keys.
- **Re-extracting a source** that step 3 already reviewed: reapply the removals in `cfa-question-review/review-log.md`, and keep its AI keys unless the source now gives a key.
- **Only multiple choice with two or more options.** Skip open-ended examples, calculations without choices, and true/false checklists; count them in the log as skipped.
- **Images**: copy the image into `question_bank/<topic>/assets/` and change the link to `assets/<file>`.
- **Duplicates**: inside one source, keep one copy (Qbank repeats every quiz). Across sources, keep both here; step 3 (`cfa-question-review`) dedupes across sources.

### Choosing the learning module

Classify by what the question tests, against the LM titles and LOS (learning outcome statements) in `notes/CFA_Level_II_Curriculum.md`. Publisher module numbers (for example Qbank "Module 42.1") use older or different numbering; use them only as a hint.

## Workflow

1. **Pick the job.** One source × one topic. Check [sources.md](sources.md) so you do not redo finished work.
2. **Map the source.** List its headings (`grep -n '^#' <file>`) and find where questions and keys are. Count the multiple-choice questions you expect, with the count method in [sources.md](sources.md) when one is given; write that number down.
3. **Extract.** For a source with regular structure, write a small transform script (in your scratchpad, not the repository; Python via `uv run python`) instead of retyping: it cannot misquote. Otherwise work one case set, quiz or LM at a time and append to the output file. For sources over about 1,500 lines, use one subagent per topic, each writing only its own output file. Keep each folder's `.gitkeep`.
4. **Check the format** with the app parser:

   ```bash
   npm --prefix ../one-time-projects/question-bank-prep run -s check-bank -- "$PWD/question_bank/<NN-topic>/<file>.md"
   ```

   Fix every `ERROR`. Each `missing or ambiguous answer key` warning must match a question that truly has no key in the source.
5. **Check the content.**
   - Extracted + skipped = the source count from step 2. Explain any gap.
   - Compare every key with the source key, question by question, and check that every non-blank source line of each question appears in the output (a script does both cheaply). Then read at least five random questions, plus any with tables, charts, or images, against the source by eye.
   - `grep -n '\[Correct\]\|\[Incorrect\]' question_bank -r` must return nothing.
   - Open the topic in the app's Practice page and look at a few questions with formulas, tables or charts: no red formula text, no raw `$$`.
6. **Record.** Update the Status column (`in progress (QM, FI)` lists finished topics; `done` when every topic the source covers is finished) and add a row to the Extraction log in [sources.md](sources.md).
7. **Commit and push** the `cfa` repository, which is private (`git add question_bank .agents/skills/cfa-question-bank && git commit && git push`). Never copy question text or study material into `question-bank-prep`; that repository is public.

## Importing into the app

Nothing to import by hand: the app syncs `question_bank/` every time it opens (`MATERIAL_ROOT` in `question-bank-prep/.env`, or the `/question_bank` mount in its Docker image). It reads subfolders recursively and keeps answer history when a file is re-extracted (matched by content).
