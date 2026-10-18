# Prompt 3: Review the question bank (dedupe and missing answers)

Step 3 of 3. Removes duplicate and near-duplicate questions across sources, writes missing answer keys, and adds short explanations where a solution is missing or thin, all marked as AI-written.

How to use: fill in **Settings** and give everything below the line to an AI agent. The prompt is self-contained.

---

## Settings

- **REPOSITORY**: `<git URL of your study repository>`
- **EXAM**: `<exam name and level>`
- **MATERIALS**: `md_materials/` (Markdown study material; reference only, never edited)
- **BANK**: `question_bank/`
- **OUTLINE**: `<file listing the exam's topics, chapters and learning objectives>`
- **TRACKING**: `docs/question-bank/` (holds `sources.md` and `review-log.md`)
- **SCOPE**: `<BANK>/<NN-topic>/` (one topic folder per session works best; several sessions can run in parallel on different topics)
- **SOURCE_PRIORITY**: `<source codes from sources.md, highest first, for example "A > B, C > D"; or "none">`

## Task

First pull the latest REPOSITORY (`git pull`; clone it if you do not have it). Then review SCOPE: dedupe first (Part A), then write missing answers (Part B), then write missing explanations (Part C). Edit only bank files in SCOPE and `TRACKING/review-log.md`. Read MATERIALS and the original PDFs freely, but never edit them. Run every check, update the log, report the counts, then commit and push.

Write two small scripts in a scratch folder outside the repository (Python through `uv run python`), and keep their reports there too, never inside BANK: every `.md` file in BANK is read as a question bank.

- **Format check.** Bank files are read by their Markdown headings (a `#` line inside a fenced code block is not a heading). Report as an *error*: a file with no `Question` heading; a question with fewer than two choices or a repeated label (a choice is a line starting `A. `, `B. ` …, letters A to Z in order); a choice letter out of order (the app reads it as text of the previous choice). Report as *no valid key*: a question with no `Answer` or `Answer (AI)` sub-heading, or whose answer's first non-blank line is not exactly one of its choice labels. A `Case` heading's passage runs to its first `Question` heading; its questions sit one level deeper.
- **Duplicate finder.** Compare questions only within one topic folder, never two questions of the same case. Normalize each question's stem plus choices: lower-case, strip Markdown and LaTeX markup. Classify a pair as *same text* (identical), *numbers differ* (identical once every number is replaced by `#`), or *similar* (Jaccard similarity of the two number-masked word sets at or above a threshold, where Jaccard(A, B) = shared words / all distinct words; skip "similar" when either set has fewer than 8 words). When either question belongs to a case, also require the two case passages to pass the same threshold, because one stem over different exhibit data is a different question. Join matches into groups (A~B and B~C give one group) and list each group with file, line, and whether each copy has a key and a solution.

## The review log

`TRACKING/review-log.md` has these sections; create any that are missing:

- **Counts**: date, bank file, questions removed as duplicates (cases), AI keys written, unresolved, possible source errors flagged.
- **Removed duplicates**: date, removed (ID or case), file, kept (ID or case), reason.
- **Reviewed, kept both**: date, questions, file, why they are not duplicates.
- **AI-written keys**: date, question ID, file, AI key, reference used.
- **Unresolved (left without a key)**: date, question ID, file, why.
- **Possible source errors (source key kept)**: date, question ID, file, source key, AI view.
- **AI explanations**: date, question ID, file, visual used.

A later re-extraction of a source (prompt 2) reapplies this log, so be exact, and always include the source's own ID (a question-bank ID, the source's case number), because extraction-order labels can change.

## Part A: dedupe

1. **Find candidates.** Run the duplicate finder on each topic folder in SCOPE with threshold 0.9, then once with 0.85 to catch renamed case sets.
2. **Judge each group by reading the questions.** A group is a duplicate when it asks the same thing about the same kind of data:
   - same text: duplicate;
   - the same question with different numbers, names or small wording changes: duplicate (keep one copy of each variant family);
   - same stem but a different concept, learning objective, or choices that test different ideas: not a duplicate, keep both;
   - a question whose answer is one step of another (a one-period vs a two-period forecast): not a duplicate, because the multi-step version is its own skill; keep both.
   - Groups already under "Reviewed, kept both" need no new judgement.
3. **Which copy to keep.** A question's source is the source code in its ID (`<TOPIC>-<SRC>-…`, codes in `TRACKING/sources.md`), not its file name: one file can hold several sources. Follow SOURCE_PRIORITY: when copies come from different sources, keep the copy from the highest-priority source and remove the others, even if a lower-priority copy has the longer solution. Sources listed together (`B, C`) rank equally. Between copies of equal priority, or when SOURCE_PRIORITY is `none`, keep any one copy, preferring one with a source key and a solution. If the kept copy has no key but a removed copy has one, write that key and source in the log so Part B can use it as its reference.
4. **Cases move as a whole.** Remove a case only when more than half of its questions duplicate questions of one other case. Of two such cases from sources of different priority, remove the one from the lower-priority source; otherwise remove the one with the higher duplicate share (tie: keep the case with more questions, then the longer solutions). A standalone question that duplicates a question inside a case of a higher-priority source is removed; one that duplicates a question in a lower-priority case is kept, and that case question stays too unless its whole case goes. Before you delete, check each of its questions that has no copy: if no other question in the topic tests that concept, keep the case. Log each unique question you drop and where its concept is still tested.
5. **Delete** the removed questions or cases from their bank file. Leave every other question untouched.
6. **Log** every removal (removed → kept, with the reason), and every group you judged not a duplicate.

## Part B: write missing answers

1. **Find questions without a key**: the format check's *no valid key* list. If there are none, Part B is done; do not audit source keys unless asked.
2. **Solve each one yourself.** Read the stem, case passage, exhibits and choices. Look up the concept and formula in MATERIALS (search the topic's notes, lectures and formula sheets) and in OUTLINE. Compute every calculation with `uv run python`, not by mental arithmetic.
3. **Check before you commit to a key.** Work the answer a second, independent way (another formula, a sanity bound, or ruling out the other choices). If the two ways disagree, or you are not sure, **do not write a key**; log the question as unresolved.
4. **Write the key in the AI format.** The `(AI)` in the heading is the only marker, so do not write "AI-written" anywhere else in the text.

   ```markdown
   #### Answer (AI)

   B

   #### Solution

   <short worked explanation in the Part C style: the deciding idea, the formula with the question's numbers, and why each wrong choice is wrong when the choices are statements>

   *Reference: <notes or lecture>, <section> (<concept>).*

   *Source: <source name>, Question ID <id>.*
   ```

   - Use the heading depth of the question's other sub-headings (`###` or `####`).
   - Math: `$…$` inline, each `$$` fence alone on its own line, money as `\$`.
   - Keep any source text already in the solution, and keep the existing `*Source: …*` line last.
5. **Never change a source key.** If you believe a source key is wrong, leave it and add one line to that solution: `> **Possible source error (AI):** <one-sentence reason>.` Log it.

## Part C: write missing explanations

1. **Find solutions that need help.** Count a solution's words without its `*Source: …*` and `*Reference: …*` lines. **A solution of 40 words or more is kept as it is: add nothing.** A shorter one needs an explanation when it is empty, only restates the key or a number without saying why, or (for a question whose choices are statements or concepts) does not say why the wrong choices are wrong. Use your judgement: a short solution that already makes the answer clear needs nothing. Have the format check list the candidates. Skip questions that already have an `Intuition (AI)` heading.
2. **Solve each one yourself** as in Part B steps 2 and 3. If your answer disagrees with the source key, write no explanation; flag it as a possible source error (Part B step 5) instead.
3. **Write the explanation for a reader who wants few words and strong intuition.**
   - At most 60 words of prose. Open with the one idea that decides the answer, in plain words.
   - Add exactly one visual, the one that makes the idea fastest to see: the formula worked with the question's own numbers (define each symbol once), a small table (2–5 rows; for example each choice and why it is right or wrong), or a Mermaid diagram of at most 6 nodes for a process or cause and effect.
   - **Wrong choices.** When the choices are statements or concepts, say why each wrong choice is wrong, one short line each (or as rows of the table). When the choices are just numbers, skip this: the worked formula already shows them wrong. Decide case by case whether a wrong choice needs a line at all; an obviously unrelated choice does not.
   - No restating the question, no LOS text, no filler.
4. **Place it inside the Solution**, under a sub-heading one level deeper than `Solution`, after the source's own text and before the `*Source: …*` line, which stays last. Never change the source's text. Math as `$…$` and `$$…$$` fences on their own lines, money as `\$`.

   ````markdown
   #### Solution

   <source text, unchanged>

   ##### Intuition (AI)

   Higher leverage makes equity riskier, so its required return rises with D/E.

   $$
   r_e = r_0 + (r_0 - r_d)\frac{D}{E} = 10\% + (10\% - 6\%)(0.5) = 12\%
   $$

   *Source: <unchanged>*
   ````

   The choices here are numbers, so there are no wrong-choice lines. For statement choices, a small table does both jobs:

   ```markdown
   | Choice | Why |
   |---|---|
   | A. Coefficients are biased | ✗ Heteroskedasticity leaves coefficients unbiased |
   | B. t-statistics are unreliable | ✓ Standard errors are wrong, so t-tests mislead |
   | C. Regressors are correlated | ✗ That is multicollinearity |
   ```

5. **Log** each one in the review log under **AI explanations**: date, question ID, file, visual used (formula, table or diagram).

## Finish

1. The format check shows 0 errors, and every question left on its *no valid key* list is logged as unresolved.
2. `grep -rn "Answer (AI)" <SCOPE> | wc -l` equals the number of AI keys the log lists for files in SCOPE, and `grep -rn "Intuition (AI)" <SCOPE> | wc -l` equals the AI explanations it lists.
3. Update the Counts table in the log.
4. Commit and push the study repository. Other sessions may review other topic folders at the same time: before each push run `git pull --rebase`, and if the log conflicts, keep every row from both sides. Never copy question text into a public repository.

## Report

End with: duplicates removed (questions and cases), groups kept, AI keys written, AI explanations written, unresolved questions, possible source errors, and any case these rules did not cover.
