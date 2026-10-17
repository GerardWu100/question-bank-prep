# PDF-to-Markdown Conversion Prompt

Run this in the `cfa` repository (`~/projects/cfa`); `materials/` and `md_materials/` below are relative to it. The conversion is finished; this prompt is kept for reference and for new PDFs.

Convert the full study-material PDFs into faithful Markdown lecture notes.

## Content and structure

- Convert every page of each PDF, not a summary or selection.
- Simplify the slide layout while preserving study content, order, wording, values, and units.
- Use meaningful topic headings, such as “The Gordon Growth Model.” Remove page-number prefixes and consolidate repeated headings without losing content or changing its order.
- Heading levels: one `#` for the file title, then `##` for readings and `###` below. A file that covers the whole curriculum (a review or framework) keeps the title as its first `#` and then uses exactly one `#` per CFA topic, with these names in this order: Quantitative Methods, Economics, Financial Statement Analysis, Corporate Issuers, Equity, Fixed Income, Derivatives, Alternative Investments, Portfolio Management, Ethics; its readings are `##`. The study app opens such a file as one section per topic.
- For practice questions, keep each answer key on its own explicit line (for example `Answer: B`) and keep the question numbering, so questions and keys can be matched later. Keep choice labels as `A.`, `B.`, `C.`.
- Omit author credits, logos, decorative cover images, and other non-study elements.
- Translate all non-English study text into English.
- Preserve every exercise and supplied answer. Do not invent answers, fill unsupported blanks, or silently correct apparent source errors. Clearly flag apparent source errors and genuinely unreadable or uncertain content.

## Equations

- Write inline math as `$...$` and standalone equations as `$$...$$` blocks. Do not use `\(...\)` or `\[...\]`. Write US-dollar amounts as `\$45`, never a bare `$45`, so a price is never read as the start of a formula (details below).
- A display block's opening and closing `$$` each stand alone on their own line: no text before or after them on that line (not `$$ Actual P/E is…`, not `\end{aligned}$$`). Inside a list item, indent both fences and the formula exactly like the item's text. Reflow surrounding prose where necessary without changing its meaning or content.
- Use `&` alignment and `\\` line breaks only inside `\begin{aligned}…\end{aligned}`. Use `\tag` only in display blocks.
- Verify symbols, subscripts, superscripts, fractions, operators, values, and units against the rendered original slides. Do not rely on extracted text alone.
- Preserve literal currency symbols as ordinary text; do not turn currency amounts into math solely because they contain a dollar sign. Escape each literal dollar sign in Markdown prose, tables, and non-code annotations as `\$` (a backslash immediately followed by a dollar sign, with no space), for example `\$100`, so it is not confused with a math delimiter.
- Do not escape actual math delimiters or double-escape an existing `\$`. Within a LaTeX expression, use `\$` when a literal dollar symbol is part of the expression. Preserve formulas, values, and wording.
- Leave literal dollars inside fenced code blocks, inline code, and Mermaid diagram code unchanged: Markdown math delimiters are not parsed there, and adding a backslash can alter code or display an unwanted backslash in a diagram label.
- After all conversions are finished, recheck every equation against the original PDF and confirm the delimiter rules above. Formatting changes must not alter the formulas.

## Tables, diagrams, and pictures

- Recreate tables as Markdown tables, preserving column order, row order, values, and blank cells. Do not put HTML in cells (no `<br>`); separate items in one cell with `; `. The only HTML allowed anywhere is a page marker comment such as `<!-- Source PDF page 12 -->`.
- Recreate diagrams in Mermaid or readable text diagrams. Preserve their labels and relationships; do not screenshot diagrams or tables.
- Screenshot only study-related pictures that cannot be represented as text, tables, or diagrams. Save necessary image assets alongside the Markdown and use relative image links.

## Inspection and verification

- Inspect the rendered pages as well as extracted text so image-based content and corrupted formulas are not missed.
- Verify completeness and accuracy before delivery, including content from every page, exercises, supplied answers, equations, tables, diagrams, and required pictures.
- Check the rendered Markdown to ensure math delimiters, tables, diagrams, and image links work as intended. The study app's Materials page (`READING_ROOT` pointing at `md_materials/`) renders math, Mermaid and images the same way the app will; red formula text there is a KaTeX error to fix. Quick text checks: `grep -nE '^\s*\$\$.+|.+\$\$\s*$' <file>` should list only one-line `$$…$$` formulas, and `grep -n '\\(' <file>` should find no `\(` math.
- Report any unresolved source uncertainty explicitly rather than guessing.

## Output and GitHub workflow

- Leave every original PDF untouched.
- Put final outputs under `md_materials/`, mirroring the source folder structure under `materials/`.
- Within the corresponding mirrored folder, use a descriptive per-PDF task folder containing one final Markdown version and any necessary image assets.
- Process the PDFs one by one. Finish and verify one PDF, then commit and push that PDF's final outputs to GitHub before proceeding to the next.
- Keep one final version of each deliverable. Remove only task-created temporary files; preserve original files and unrelated work.
- Do the work using the assistant's own cloud tools and the connected GitHub service. Do not use my computer or create a Codex task.
