# Question bank sources and status

Update the **Status** column after every extraction. Status values: `not started`, `in progress (<topics done>)`, `done`, `no questions`.

## Topic codes

| Folder in `question_bank/` | Code | Curriculum LMs | `md_materials` folder number |
|---|---|---|---|
| `01-quantitative-methods` | QM | LM01–LM07 | 01 |
| `02-economics` | EC | LM08–LM09 | 02 |
| `03-financial-statement-analysis` | FSA | LM10–LM15 | 03 |
| `04-corporate-finance` | CF | LM16–LM19 | 04 (Corporate Issuers) |
| `05-equity` | EQ | LM20–LM25 | 05 |
| `06-fixed-income` | FI | LM26–LM30 | 06 |
| `07-derivatives` | DER | LM31–LM32 | 07 |
| `08-alternative-investments` | ALT | LM33–LM36 | 08 |
| `09-portfolio-construction` | PC | LM37–LM42 | 09 (Portfolio Management) |
| `10-ethics` | ETH | LM43–LM51 | 10 |

LM numbers and titles come from `notes/CFA_Level_II_Curriculum.md` (2027 outline).

## Sources

Paths are relative to `md_materials/`. "Where the key is" says how the source stores answers.

| Code | Source | Path | Where the key is | Output file name | Status |
|---|---|---|---|---|---|
| JC100 | JC 100 Combined (item sets) | `JC 100 Combined/<NN>. <Topic> - Q+A/*.md` | `## Solutions` section at the end of each file, grouped by case: `#### 1. Solution: B.` Count: `grep -c '^#### Question'`. | `jc-100-combined.md` | in progress (QM) |
| QB25 | Qbank 2025 (one file, all topics) | `others/Qbank 2025/Qbank 2025.md` | Every quiz block appears twice. Use the copy whose choices carry `[Correct]` / `[Incorrect]`; it also has `Explanation` and `(Module x.y, LOS x.z)`. Dedupe by `Question ID` (same text with a different ID is kept). Case passages appear only in the first copy (text after the previous question's last choice). Markers may end a choice line or sit in table rows. Each quiz = one Qbank module; module N is not LM N. QM = modules 1–4 (first 4 quiz pairs). Count: unique `Question ID` values. | `qbank-2025.md` | in progress (QM) |
| KAP | SchweserNotes 2026 module quizzes | `Kaplan/schwesernotes-*/notes.md` | `MODULE QUIZ x.y` inside each reading; keys under `ANSWER KEY FOR MODULE QUIZZES` after the reading | `kaplan-module-quizzes.md` | not started |
| SS25 | Schweser Secret Sauce 2025 | `Kaplan/schweser-secret-sauce-2025/notes.md` | check | `secret-sauce-2025.md` | not started |
| SS24 | CFA 2024 L2 Secret Sauce | `others/CFA 2024 L2 Secret Sauce/*.md` | check | `secret-sauce-2024.md` | not started |
| GDF | GD Foundation lectures | `GD Foundation/<NN>. <Topic>*/*.md` | examples inside lectures; many are open-ended | `gd-foundation.md` | not started |
| JCF | JC Foundation lectures | `JC Foundation/<NN>. <Topic>/*.md` | examples inside lectures; many are open-ended | `jc-foundation.md` | not started |
| GDR | GD Review | `others/GD Review/*.md` | check; one `#` per CFA topic, so extract each topic's section into that topic's folder | `gd-review.md` | not started |
| JCR | JC Review | `others/JC Review/*.md` | check; one `#` per CFA topic, so extract each topic's section into that topic's folder | `jc-review.md` | not started |
| MM25 | MM 2025 | `others/MM 2025/*.md` | check | `mm-2025.md` | not started |
| NOBS | NO BS Ethics 2025 | `others/NO_BS_Ethics_2025_*/*.md` | check | `no-bs-ethics-2025.md` | not started |

Probably no questions (confirm, then mark `no questions`): `others/GD Framework`, `others/JC Formula Sheet 2026`, `others/Quick Sheet`.

## Extraction log

One row per finished output file. "Source count" is the number of multiple-choice questions you counted in the source; "Skipped" are items you did not extract, with the reason.

| Output file | Source count | Extracted | Keyed | Skipped (reason) | Date |
|---|---|---|---|---|---|
| `01-quantitative-methods/jc-100-combined.md` | 50 | 50 | 50 | 0 | 2026-10-17 |
| `01-quantitative-methods/qbank-2025.md` | 273 | 273 | 273 | 0 | 2026-10-17 |
