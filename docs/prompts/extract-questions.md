# Question Extraction Prompt

Open a Claude Code session in the `cfa` repository (`~/projects/cfa`) and send this prompt. Replace the three placeholders; source and topic codes are in `cfa/.agents/skills/cfa-question-bank/sources.md`.

```text
Use the cfa-question-bank skill. Extract <source>, topic <NN Topic>, into question_bank/<NN-topic>/<source-file>.md. Run every check in the skill, update sources.md, report the counts and any skill gaps, then commit and push.
```

Example:

```text
Use the cfa-question-bank skill. Extract Qbank 2025, topic 10 Ethics, into question_bank/10-ethics/qbank-2025.md. Run every check in the skill, update sources.md, report the counts and any skill gaps, then commit and push.
```

Result: one bank file per source per topic, checked with `check-bank` (0 errors), a new row in the extraction log in `sources.md`, and a short report (source count, extracted, keyed, skipped, spot checks).
