# Prompt 2: Markdown study material → question bank

Step 2 of 3. Copies multiple-choice questions from the Markdown study material into question-bank files in a fixed Markdown format: one folder per topic, one file per source.

How to use: fill in **Settings** and give everything below the line to an AI agent. The prompt is self-contained. Run one job (one source × one topic) per agent.

---

## Settings

- **REPOSITORY**: `<git URL of your study repository>`
- **EXAM**: `<exam name and level>`
- **MATERIALS**: `md_materials/` (Markdown study material from prompt 1; read only)
- **BANK**: `question_bank/` (output)
- **OUTLINE**: `<file listing the exam's topics and chapters, with chapter codes and learning objectives>`
- **TRACKING**: `docs/question-bank/` (holds `sources.md` and `review-log.md`)
- **JOB**: extract `<source name>`, topic `<NN Topic>`, into `<BANK>/<NN-topic>/<source-file>.md`
- **SHARED_FILE** (optional): `<small sources that share one others.md per topic, in order>`, or `none`

## Task

First pull the latest REPOSITORY (`git pull`; clone it if you do not have it). Then do JOB. Copy the questions word for word into the layout below, run every check, update the tracking files, report the counts and anything these rules did not cover, then commit and push.

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
│   ├── <source-file>.md     ← one file per source per topic (or others.md, see Shared file)
│   └── assets/              ← images copied from MATERIALS, if any
└── 02-<topic-slug>/
```

- Only bank files go in BANK. Every `.md` file there is read as a question bank, so put no README or notes inside. Keep each folder's `.gitkeep`.
- One file per source per topic keeps files small enough to check and lets you re-extract one source without touching others.
- **Shared file.** The sources named in SHARED_FILE go into `others.md` instead: first a title `# <EXAM> · <NN> <Topic> · Others` and one line naming the sources it combines, then one section per source in SHARED_FILE order. Each section is exactly the file this prompt would otherwise write for that source, starting with its own file-title heading. When JOB names one of these sources, write or replace only its section (create `others.md` with the title if it is missing) and leave the other sections byte for byte unchanged; the checks below apply to the whole file.

## Headings (depth matters: a parser reads them)

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

## Format rules

A parser reads the bank files by their Markdown headings. Only real headings count: a `#` line inside a fenced code block is not a heading.

- **Errors** (the file cannot be used until fixed):
  - The file has no `Question` heading.
  - A `Question` heading (text starting with `Question `) has fewer than two choices, or two choices with the same label. A choice is a line starting with its label and a period: `A. `, `B. `, `C. ` … (letters A to Z, in order; a question may have more than five choices).
  - A choice letter is out of order (for example `D. ` right after `B. `): the app reads it as text of the previous choice.
- **No valid key** (allowed only when the source has no key): there is no `Answer` or `Answer (AI)` sub-heading, or its first non-blank line is not exactly one of that question's choice labels.
- A question's `Choices`, `Answer` and `Solution` sub-headings are one level deeper than its `Question` heading and use exactly those words.
- A `Case` heading starts a passage that runs to its first `Question` heading, so exhibits under deeper headings stay in it. Its questions are one level deeper than the case. The case ends at the next heading of the same or a shallower level.
- A `Chapter` heading (text starting with `Chapter`) sets the chapter for every question below it and ends any open case.

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

## Question ST-PB-1234567

Which of the following is least likely a test for heteroskedasticity?

### Choices

A. Scatter plot.

B. Breusch-Pagan test.

C. Breusch-Godfrey test.

### Solution

> Key not given in source.

*Source: Practice Book, Question ID 1234567.*
```

## Workflow

1. **Check the job.** Read `sources.md` so you do not redo finished work.
2. **Map the source.** List its headings (`grep -n '^#' <file>`) and find where questions and keys are. Count the multiple-choice questions you expect, with the count method in `sources.md` when one is given, and write the number down.
3. **Extract.** For a source with regular structure, write a small transform script in a scratch folder outside the repository (Python through `uv run python`) instead of retyping, so nothing can be misquoted. Otherwise work one case, quiz or chapter at a time and append to the output file. For a source over about 1,500 lines, use one subagent per topic, each writing only its own output file.
4. **Check the format** with a small script you write in the scratch folder, against the **Format rules** below. Fix every error. Each question the script reports without a valid key must be one that truly has no key in the source.
5. **Check the content.**
   - Extracted + skipped = the count from step 2. Explain any gap.
   - Compare every key with the source key, question by question, and check that every non-blank source line of each question appears in the output (a script does both cheaply). Then read at least five random questions, plus every question with a table, chart or image, against the source.
   - `grep -rn '\[Correct\]\|\[Incorrect\]' <BANK>` returns nothing.
   - Preview a few questions with formulas, tables or charts in a Markdown viewer with KaTeX math: every formula renders, and no raw `$` shows.
6. **Record.** Update the source's Status in `sources.md` (`in progress (<topics done>)`, or `done` when every topic it covers is finished) and add a row to the Extraction log.
7. **Commit and push** each bank file as soon as it is finished, one file at a time, before you start the next. Keep the repository private when it holds copyrighted material, and never copy question text into a public repository.

## Report

End with: source count, extracted, keyed, skipped (with reasons), what you spot-checked, and any case these rules did not cover.
