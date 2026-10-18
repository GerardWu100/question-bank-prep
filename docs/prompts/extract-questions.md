# Prompt 2: Markdown study material → question bank

Step 2 of 3. Copies multiple-choice questions from the Markdown study material into bank files that the study app imports: one folder per topic, one file per source.

How to use: open an AI coding session in your study repository, fill in **Settings**, and send everything below the line. Run one job (one source × one topic) per session.

---

## Settings

- **EXAM**: `<exam name and level>`
- **MATERIALS**: `md_materials/` (Markdown study material from prompt 1; read only)
- **BANK**: `question_bank/` (output)
- **OUTLINE**: `<file listing the exam's topics and chapters, with chapter codes and learning objectives>`
- **TRACKING**: `docs/question-bank/` (holds `sources.md` and `review-log.md`)
- **APP**: `<path to the question-bank-prep repository>`
- **JOB**: extract `<source name>`, topic `<NN Topic>`, into `<BANK>/<NN-topic>/<source-file>.md`

## Task

Do JOB. Copy the questions word for word into the layout below, run every check, update the tracking files, report the counts and anything these rules did not cover, then commit and push.

## Tracking files

`TRACKING/sources.md` holds, for this exam:

1. **Topic codes**: one row per topic with its bank folder (`01-<topic-slug>`, in OUTLINE order), a short code (for example `QM`), its chapter range and its folder number in MATERIALS.
2. **Sources**: one row per source with a short code (for example `QB25`), its path in MATERIALS, where and how it stores answer keys, how to count its questions, the output file name, and a Status (`not started`, `in progress (<topics done>)`, `done`, `no questions`).
3. **Extraction log**: one row per finished output file: output file, source count, extracted, keyed, skipped (reason), date.

If the file or a row you need is missing, create it from MATERIALS and OUTLINE first. Read `TRACKING/review-log.md` too: step 3 records removals there that a re-extraction must reapply.

## Storage

```text
BANK/
├── 01-<topic-slug>/
│   ├── <source-file>.md     ← one file per source per topic
│   └── assets/              ← images copied from MATERIALS, if any
└── 02-<topic-slug>/
```

- Only bank files go in BANK. The app imports every `.md` file there as questions, so put no README or notes inside. Keep each folder's `.gitkeep`.
- One file per source per topic keeps files small enough to check and lets you re-extract one source without touching others.

## Headings (depth matters: the app's parser reads them)

| Depth | Heading | Use |
|---|---|---|
| `#` | `<EXAM> · <NN> <Topic> · <Source name>` | File title, once, then one line naming the source path |
| `#` | `Chapter <chapter code> <chapter title>` | One per chapter in OUTLINE that has at least one question, in OUTLINE order; the line must start with the word `Chapter` |
| `##` | `Case <TOPIC>-<SRC>-C<NN> <case name>` | Case or item-set passage. Its exhibits and other sub-headings come before its first question, re-levelled to `###` or deeper so they nest under the case; keep their titles |
| `###` | `Question <TOPIC>-<SRC>-C<NN>-<n>` | Question inside a case; its `Choices`, `Answer`, `Solution` use `####` |
| `##` | `Question <TOPIC>-<SRC>-<id>` | Standalone question; its `Choices`, `Answer`, `Solution` use `###` |

- `<TOPIC>` and `<SRC>` are codes from `sources.md`. `<id>` is the source's own stable identifier when it has one (a question-bank ID, a quiz number such as `1.1-3`), else a running number.
- Question IDs are unique in the whole bank. Never reuse an ID for a different question.
- `C<NN>` is the source's own case number; if it has none, number cases C01, C02… in source order. Name a case after its main person or company, else a 2–4 word subject. Cases are reordered by chapter, so gaps and out-of-order numbers are expected.
- A case whose questions span two chapters goes under the chapter most of its questions test. On a tie, use the chapter the passage mainly describes; if still tied, the later chapter. Choose only among the tied chapters. Never split a case.

## Content

- **Copy word for word**: passage, exhibits, stem, choices, solution. Do not summarize, reword, correct or add content. Keep math (`$...$`, `$$...$$`), `\$` money escapes, tables, Mermaid and text charts exactly as in MATERIALS.
- **Fix only broken Markdown** while copying: each `$$` fence alone on its line, `&` alignment inside `\begin{aligned}…\end{aligned}`, `\(…\)` / `\[…\]` replaced by `$…$` / `$$…$$`, and `<br>` in tables replaced by `; `. Never change words or numbers.
- **Choices**: one per line as `A. text`, with a blank line between choices. Convert `A)`, `A:`, `- A.` and `**A.**` to `A.`. **Delete answer markers such as `[Correct]` / `[Incorrect]`**: they leak the key.
- **Choices in a table** (rows such as `| A. | x | y |`): the parser cannot read them. Keep the table in the stem, then add a `Choices` section with `A. x, y` built from each row's cells in column order. This is the only text you may add.
- **Answer**: one choice label only, on the first line.
- **Solution**: the source's explanation, then a last line `*Source: <source name>, <location>; <publisher reference if given>.*` so the question can be traced. Keep any error or fidelity note as `> Source note: ...` in the solution of the question it concerns; split a note that covers several questions into one per question, keeping its words.
- **No key in the source**: leave out the `Answer` heading and write `> Key not given in source.` in the solution. Never solve the question to make a key here; prompt 3 writes marked `Answer (AI)` keys.
- **Re-extracting a source** that step 3 already reviewed: reapply the removals in `review-log.md`, and keep its AI keys unless the source now gives a key.
- **Only multiple choice with two or more options.** Skip open-ended examples, calculations without choices and true/false checklists; count them as skipped.
- **Images**: copy the image to `BANK/<NN-topic>/assets/` and change the link to `assets/<file>`.
- **Duplicates**: inside one source, keep one copy (some banks repeat every quiz). Across sources, keep all copies; prompt 3 removes them.

## Choosing the chapter

Classify each question by what it tests, against the chapter titles and learning objectives in OUTLINE. A publisher's own module numbers often follow an older or different numbering; use them only as a hint.

## Example layout

Text shortened for illustration; real files copy everything in full.

```markdown
# EXAM · 01 Statistics · Practice Book

Extracted from `md_materials/Practice Book/01. Statistics.md`. Questions are copied word for word; only the layout changed.

# Chapter 01 Regression Basics

## Case ST-PB-C01 Lena Ortiz

Lena Ortiz, an analyst, forecasts sales with a regression:

$$
Y = 2.1 + 0.4X
$$

### Exhibit 1: Inputs

| Input | Value |
|---|---|
| Observations | 40 |
| Price per unit | \$25.00 |

### Question ST-PB-C01-1

Which of the following is least likely a regression assumption?

#### Choices

A. The residuals are uncorrelated across observations.

B. The residual variances are normally distributed.

C. The independent variable is not random.

#### Answer

B

#### Solution

The assumption is that residual variances are equal across observations.

*Source: Practice Book, Case 1, Question 1.*

# Chapter 03 Model Misspecification

## Question ST-PB-1586011

Which of the following is least likely a test for heteroskedasticity?

### Choices

A. Scatter plot.

B. Breusch-Pagan test.

C. Breusch-Godfrey test.

### Solution

> Key not given in source.

*Source: Practice Book, Question ID 1586011.*
```

## Workflow

1. **Check the job.** Read `sources.md` so you do not redo finished work.
2. **Map the source.** List its headings (`grep -n '^#' <file>`) and find where questions and keys are. Count the multiple-choice questions you expect, with the count method in `sources.md` when one is given, and write the number down.
3. **Extract.** For a source with regular structure, write a small transform script in a scratch folder outside the repository (Python through `uv run python`) instead of retyping, so nothing can be misquoted. Otherwise work one case, quiz or chapter at a time and append to the output file. For a source over about 1,500 lines, use one subagent per topic, each writing only its own output file.
4. **Check the format** with the app's parser, and fix every `ERROR`:

   ```bash
   npm --prefix <APP> run -s check-bank -- "$PWD/<BANK>/<NN-topic>/<source-file>.md"
   ```

   Each `missing or ambiguous answer key` warning must match a question that truly has no key in the source.
5. **Check the content.**
   - Extracted + skipped = the count from step 2. Explain any gap.
   - Compare every key with the source key, question by question, and check that every non-blank source line of each question appears in the output (a script does both cheaply). Then read at least five random questions, plus every question with a table, chart or image, against the source.
   - `grep -rn '\[Correct\]\|\[Incorrect\]' <BANK>` returns nothing.
   - Open the topic on the app's Practice page and look at a few questions with formulas, tables or charts: no red formula text and no raw `$$`.
6. **Record.** Update the source's Status in `sources.md` (`in progress (<topics done>)`, or `done` when every topic it covers is finished) and add a row to the Extraction log.
7. **Commit and push** the study repository. Keep it private when it holds copyrighted material, and never copy question text into a public repository.

## Report

End with: source count, extracted, keyed, skipped (with reasons), what you spot-checked, and any case these rules did not cover.

The app needs no manual import: it syncs BANK each time it opens (`MATERIAL_ROOT` in its `.env`, or the `/question_bank` mount of its Docker image), reads subfolders, and keeps answer history when a file is re-extracted.
