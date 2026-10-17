# Question Review Prompt (step 3)

Step 3 of the CFA bank pipeline: remove duplicate and near-duplicate questions, and write missing answer keys that are clearly marked as AI-written. Open a Claude Code session in the `cfa` repository (`~/projects/cfa`) and send:

```text
Use the cfa-question-review skill on question_bank/<NN-topic>/ (or the whole question_bank/). Dedupe first, then write missing answers using md_materials as reference. Do not edit md_materials. Run every check in the skill, update review-log.md, report the counts, then commit and push.
```

Result:

- Duplicate questions (including the same question with different numbers or names) are removed, keeping the best copy; every removal is logged with the copy that was kept.
- Questions the source left without a key get an `Answer (AI)` key and a solution that opens with "AI-written answer and explanation, not from the source". The app shows these with an "AI-written answer · not from the source" label.
- Questions the AI could not solve reliably stay without a key and are listed as unresolved.
- Source keys are never changed; suspected source errors are flagged in the solution.

Tools used by the skill, from this repository: `npm run check-bank` and `npm run find-duplicates`.
