# Question bank format

A question bank is a plain Markdown (`.md`) file. The app reads its **headings** to find chapters, cases and questions. Everything else is ordinary Markdown: tables, lists, bold text, and math in `$...$` or `$$...$$`.

Working examples are in [`examples/`](../../examples):

| File | Shows |
|---|---|
| [basic-bank.md](../../examples/basic-bank.md) | Chapters, questions, choices, answers, solutions, math |
| [case-bank.md](../../examples/case-bank.md) | A shared case passage with an exhibit table, plus a standalone question after it |
| [lecture-note.md](../../examples/lecture-note.md) | Reading material with no questions (import it as type **note**) |

## The shape of one question

```markdown
# Chapter 1 Time Value of Money      ← optional; groups the questions below it

## Question 1                         ← starts a question; title must be "Question <something>"
What is the future value of $1,000    ← the stem: everything up to the next sub-heading
at 5% for two years?

### Choices                           ← one level deeper than the question
A. $1,100.00
B. $1,102.50
C. $1,105.00

### Answer                            ← one level deeper than the question
B

### Solution                          ← optional; shown only after you answer
FV = 1000 × 1.05² = 1102.50.
```

```text
Chapter  (# or any depth)
└── Question (##)
    ├── stem text
    ├── Choices (###)
    ├── Answer (###)
    └── Solution (###)
```

## Heading rules

| Heading text (not case-sensitive) | Meaning |
|---|---|
| `Chapter ...` | Sets the chapter for the questions after it. Also ends any open case. |
| `Case ...` or `Vignette ...` | Starts a shared passage for the questions below it. |
| `Question <id>` | Starts a question. `<id>` can be any text: `Question 1`, `Question 3.2`, `Question A-7`. |
| `Choices` or `Choice` | The answer options. Optional if the options follow the stem directly. |
| `Answer`, `Answer key` or `Correct answer` | The key. |
| `Answer (AI)` (also `Answer key (AI)`, `Correct answer (AI)`) | A key written by AI because the source gave none. It grades like any key, and the app labels it "AI-written answer · not from the source". |
| `Solution` or `Explanation` | The worked explanation. |

- Put `Choices`, `Answer` and `Solution` **one level deeper** than their `Question` heading.
- A question ends at the next heading at its own level or higher.
- Any heading depth works (`#` to `######`) as long as the nesting is consistent.
- Headings inside fenced code blocks (```` ``` ````) are ignored, so you can quote examples.

## Choices

Write one choice per line, starting with its label and `.`, `)` or `:`:

```markdown
A. Text            A) Text            A: Text
- A. Text          **A.** Text        **A**. Text is NOT recognized
```

- The default labels are `A` to `E`. For more options or other labels (for example `1, 2, 3, 4`), set **Settings → Choice labels** *before* you import.
- A choice can span several lines; it runs until the next label.
- If the bank uses a letter after the last configured label (for example `F.` with labels `A`–`E`), the import shows an error. It does not merge `F` into `E`.
- Choices never shuffle.

## Answer

The first non-empty line under `Answer` must name exactly one label. These all work:

```markdown
B        B.        B)        (B)        **B**        Answer: B        b        B. $1,102.50
```

`A or B` and `A, C` do not work. A question without a usable key still imports, with a warning. You can read and answer it, but it cannot be graded ("ungradable").

## Cases (shared passages)

```markdown
## Case Maple Leaf Utilities          ← case at level 2
Shared passage text...

### Exhibit 1                          ← deeper headings before the first question
| Input | Value |                       stay part of the passage
|---|---|
| D1 | $2.00 |

### Question 1                         ← questions one level deeper share the passage
...
### Question 2
...

## Question 3                          ← same level as the case: the case has ended
...
```

- The passage is the text from the case heading to its first `Question` heading.
- The case ends at the next heading at its own level or higher, or at a `Chapter` heading.
- "Shuffle case groups" keeps a case's questions together, in source order.

## Notes (reading material)

A file with no `Question` headings is reading material. Import it with type **note**. If you import it as a question bank, the import stops with "No Question headings found". The tutor can search and cite notes.

## Editing a bank you already imported

The app keeps your progress when you re-import an edited file:

| Change | What happens to your saved answer |
|---|---|
| Edit the solution or answer key only | Kept. A key change re-grades your answer. |
| Reorder or add other questions | Kept, matched by content. |
| Change the stem or choices of a question | You choose: keep the progress or start fresh. Changed choices cannot keep the progress, because the saved letter would mean something else. |
| Delete a question | Kept as removed-source history; it leaves practice. |

Preview always lists errors (block the import) and warnings (you can accept them) before anything is saved.

## Checklist before importing

- [ ] Every question heading starts with `Question`.
- [ ] `Choices`, `Answer`, `Solution` sit one level below their question.
- [ ] Each choice line starts with a configured label and `.`, `)` or `:`.
- [ ] Each `Answer` names one label.
- [ ] Case questions sit one level below the case heading.
- [ ] Reading material without questions is imported as **note**.

## Check a bank from the command line

The same parser runs without the app. It prints counts per file and every import error and warning, and also warns about duplicate question titles and questions outside a chapter. It exits with status 1 when any file has an error, and skips `README.md` files.

```sh
npm run check-bank -- path/to/bank.md path/to/folder
```

When `MATERIAL_ROOT` is set, the app syncs that folder each time a library opens, and every `.md` file in it and its subfolders is imported as a question bank, so keep notes and README files outside it.
