# Prompt 3: Review the question bank (dedupe and missing answers)

Step 3 of 3. Removes duplicate and near-duplicate questions across sources, and writes missing answer keys marked as AI-written.

How to use: open an AI coding session in your study repository, fill in **Settings**, and send everything below the line.

---

## Settings

- **EXAM**: `<exam name and level>`
- **MATERIALS**: `md_materials/` (Markdown study material; reference only, never edited)
- **BANK**: `question_bank/`
- **OUTLINE**: `<file listing the exam's topics, chapters and learning objectives>`
- **TRACKING**: `docs/question-bank/` (holds `sources.md` and `review-log.md`)
- **APP**: `<path to the question-bank-prep repository>`
- **SCOPE**: `<BANK>/<NN-topic>/` (or the whole BANK)

## Task

Review SCOPE: dedupe first (Part A), then write missing answers (Part B). Edit only bank files in SCOPE and `TRACKING/review-log.md`. Read MATERIALS and the original PDFs freely, but never edit them. Run every check, update the log, report the counts, then commit and push.

Tools, run from the study repository (write reports to a scratch folder, never inside BANK, because the app imports every `.md` file there):

```bash
npm --prefix <APP> run -s check-bank -- "$PWD/<BANK>"
npm --prefix <APP> run -s find-duplicates -- "$PWD/<BANK>/<NN-topic>" --out /tmp/duplicates.md
```

`find-duplicates` compares questions across sources inside one topic folder: stems and choices, plus similar case passages.

## The review log

`TRACKING/review-log.md` has these sections; create any that are missing:

- **Counts**: date, bank file, questions removed as duplicates (cases), AI keys written, unresolved, possible source errors flagged.
- **Removed duplicates**: date, removed (ID or case), file, kept (ID or case), reason.
- **Reviewed, kept both**: date, questions, file, why they are not duplicates.
- **AI-written keys**: date, question ID, file, AI key, reference used.
- **Unresolved (left without a key)**: date, question ID, file, why.
- **Possible source errors (source key kept)**: date, question ID, file, source key, AI view.

A later re-extraction of a source (prompt 2) reapplies this log, so be exact, and always include the source's own ID (a question-bank ID, the source's case number), because extraction-order labels can change.

## Part A: dedupe

1. **Find candidates.** Run `find-duplicates` on each topic folder in SCOPE (default threshold 0.9; also try `--threshold 0.85` once to catch renamed case sets).
2. **Judge each group by reading the questions.** A group is a duplicate when it asks the same thing about the same kind of data:
   - same text: duplicate;
   - the same question with different numbers, names or small wording changes: duplicate (keep one copy of each variant family);
   - same stem but a different concept, learning objective, or choices that test different ideas: not a duplicate, keep both;
   - a question whose answer is one step of another (a one-period vs a two-period forecast): not a duplicate, because the multi-step version is its own skill; keep both.
   - Groups already under "Reviewed, kept both" need no new judgement.
3. **Which copy to keep.** Practice is by topic and chapter, so the source does not matter. Keep any one copy; only prefer one with a source key and a solution over one without.
4. **Cases move as a whole.** Remove a case only when more than half of its questions duplicate questions of one other case. Of two such cases, remove the one with the higher duplicate share (tie: keep the case with more questions, then the longer solutions). Before you delete, check each of its questions that has no copy: if no other question in the topic tests that concept, keep the case. Log each unique question you drop and where its concept is still tested.
5. **Delete** the removed questions or cases from their bank file. Leave every other question untouched.
6. **Log** every removal (removed → kept, with the reason), and every group you judged not a duplicate.

## Part B: write missing answers

1. **Find questions without a key**: the `check-bank` warnings `missing or ambiguous answer key`. If there are none, Part B is done; do not audit source keys unless asked.
2. **Solve each one yourself.** Read the stem, case passage, exhibits and choices. Look up the concept and formula in MATERIALS (search the topic's notes, lectures and formula sheets) and in OUTLINE. Compute every calculation with `uv run python`, not by mental arithmetic.
3. **Check before you commit to a key.** Work the answer a second, independent way (another formula, a sanity bound, or ruling out the other choices). If the two ways disagree, or you are not sure, **do not write a key**; log the question as unresolved.
4. **Write the key in the AI format.** The `(AI)` in the heading is the only marker: the app stores it but does not show it while practising (hover the Answer line to see it), so do not write "AI-written" anywhere in the visible text.

   ```markdown
   #### Answer (AI)

   B

   #### Solution

   <worked explanation: formula, numbers, and why each other choice is wrong>

   *Reference: <notes or lecture>, <section> (<concept>).*

   *Source: <source name>, Question ID <id>.*
   ```

   - Use the heading depth of the question's other sub-headings (`###` or `####`).
   - Math: `$…$` inline, each `$$` fence alone on its own line, money as `\$`.
   - Keep any source text already in the solution, and keep the existing `*Source: …*` line last.
5. **Never change a source key.** If you believe a source key is wrong, leave it and add one line to that solution: `> **Possible source error (AI):** <one-sentence reason>.` Log it.

## Finish

1. `check-bank` shows 0 errors, and every remaining `missing or ambiguous answer key` warning is logged as unresolved.
2. `grep -rn "Answer (AI)" <BANK> | wc -l` equals the number of AI keys in the log.
3. Update the Counts table in the log.
4. Commit and push the study repository. Never copy question text into a public repository.

## Report

End with: duplicates removed (questions and cases), groups kept, AI keys written, unresolved questions, possible source errors, and any case these rules did not cover.
