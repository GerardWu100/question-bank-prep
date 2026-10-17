---
name: cfa-question-review
description: Step 3 of the CFA question bank pipeline. Remove duplicate and near-duplicate questions (same question with different numbers or names) from question_bank/ across all sources of a topic, and write missing answer keys with AI, clearly marked as AI-written. Use when the user asks to dedupe, clean, review, or fill missing answers in the CFA question bank. Do not use for extracting questions from md_materials (that is the cfa-question-bank skill) or for converting PDFs.
---

# CFA question bank review: dedupe and missing answers

> This skill is kept in both the `cfa` and `question-bank-prep` repositories (`.agents/skills/`); keep the two copies identical. Run it from the `cfa` repository root: its logs (`sources.md`, `review-log.md`) belong to the `cfa` copy, which works on the data.

Step 3 of the pipeline. Step 1 converted PDFs into `md_materials/`; step 2 (skill `cfa-question-bank`) extracted questions into `question_bank/`. This step edits **only** `question_bank/` files and this skill's [review-log.md](review-log.md). Never edit `md_materials/` or `materials/`; read them freely as references.

Tools live in the study app (paths relative to the `cfa` repository root):

```bash
npm --prefix ../one-time-projects/question-bank-prep run -s check-bank -- "$PWD/question_bank"
npm --prefix ../one-time-projects/question-bank-prep run -s find-duplicates -- "$PWD/question_bank" --out /tmp/duplicates.md
```

Point `find-duplicates` at one topic folder (`question_bank/<NN-topic>`); it compares across sources inside that topic, and step 3 does dedupe across sources (step 2 keeps them all). Write reports to your scratch directory, never inside `question_bank/` (the app imports every `.md` file there).

## Part A: dedupe

1. **Find candidates.** Run `find-duplicates` (default threshold 0.9; try `--threshold 0.85` once to catch renamed case sets). It compares stems and choices within a topic, and also requires the case passages to be similar.
2. **Judge each group by reading the questions.** A group is a duplicate when it asks the same thing about the same kind of data:
   - *same text*: identical question → duplicate.
   - *numbers differ* / *similar*: the same question with different numbers, names, or small wording changes → duplicate (the user wants one copy of each variant family).
   - Not a duplicate: same stem but it tests a different concept, a different LOS, or the choices test different ideas. Keep both.
   - A question whose answer is one step of another (one-period vs two-period forecast) is not a duplicate: multi-step is its own skill. Keep both.
   - Groups already in the log's "Reviewed, kept both" table need no new judgement.
3. **Dedupe across sources.** The user practises by topic and chapter, so which source a copy comes from does not matter. Keep any one copy; only prefer one that has a source key and a solution over one without.
4. **Cases move as a whole.** Remove a case only when more than half of its questions duplicate questions of one other case; of two such cases, remove the one with the higher duplicate share (tie: keep the case with more questions, then the longer solutions). Before deleting, check each of its questions that has no copy: if its concept is not tested elsewhere in the topic, keep the case. Log the unique questions you drop and where their concept is still tested.
5. **Delete** the removed questions or cases from their bank file. Leave every other question untouched.
6. **Log** every removal in [review-log.md](review-log.md) (removed ID → kept ID, reason), always with the source's own ID (Qbank Question ID, source case number) because extraction-order labels can change. Log groups you judged not duplicates under "Reviewed, kept both". Step 2 re-extraction must reapply this log, so be exact.

## Part B: write missing answers

1. **Find questions without a key**: `check-bank` warnings `missing or ambiguous answer key`. If there are none, Part B is done; do not audit source keys unless the user asks.
2. **Solve each one yourself.** Read the stem, case passage, exhibits and choices. Look up the concept and formula in `md_materials/` (grep the topic's SchweserNotes, JC/GD lectures and formula sheets) and in `notes/CFA_Level_II_Curriculum.md`. For any calculation, compute it with `uv run python`, not by mental arithmetic.
3. **Check before you commit to a key.** Work the answer a second, independent way (another formula, a sanity bound, or eliminating the other choices). If the two ways disagree, or you are not sure, **do not write a key**; log it as unresolved.
4. **Write it in the AI format.** The `(AI)` in the heading is the only marker: the app stores it but does not show it to the reader, so do not write "AI-written" anywhere in the visible text.

   ```markdown
   #### Answer (AI)

   B

   #### Solution

   <worked explanation: formula, numbers, why each other choice is wrong>

   *Reference: SchweserNotes Quant & Econ 2026, Module 3.2 (heteroskedasticity).*

   *Source: Qbank 2025, Question ID 1479906.*
   ```

   - Use the heading depth of the question's other sub-headings (`###` or `####`).
   - Math as in the PDF prompt: `$…$` inline, `$$` fences alone on their own lines, money as `\$`.
   - Keep the existing `*Source: …*` line last and any source text that was already in the solution.
5. **Never change a source key.** If you believe a source key is wrong, leave it and add one line to that solution: `> **Possible source error (AI):** <one-sentence reason>.` Log it.

## Finish

1. `check-bank` shows 0 errors; every remaining `missing or ambiguous answer key` warning is in the log as unresolved.
2. `grep -rn "Answer (AI)" question_bank | wc -l` equals the number of AI keys you logged.
3. Update the counts table in [review-log.md](review-log.md).
4. Commit and push the `cfa` repository (private): `git add question_bank .agents/skills/cfa-question-review && git commit && git push`. Never copy question text into `question-bank-prep` (public).
