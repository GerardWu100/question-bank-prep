# PDF-to-Markdown Conversion Prompt

Run this in the `cfa` repository (`~/projects/cfa`); `materials/` and `md_materials/` below are relative to it. The conversion is finished; this prompt is kept for reference and for new PDFs.

Convert the full study-material PDFs into faithful Markdown lecture notes.

## Content and structure

- Convert every page of each PDF, not a summary or selection.
- Simplify the slide layout while preserving study content, order, wording, values, and units.
- Use meaningful topic headings, such as “The Gordon Growth Model.” Remove page-number prefixes and consolidate repeated headings without losing content or changing its order.
- Omit author credits, logos, decorative cover images, and other non-study elements.
- Translate all non-English study text into English.
- Preserve every exercise and supplied answer. Do not invent answers, fill unsupported blanks, or silently correct apparent source errors. Clearly flag apparent source errors and genuinely unreadable or uncertain content.

## Equations

- Recreate every equation and every other LaTeX expression using double-dollar delimiters: `$$...$$` or `$...$`. This applies to all LaTeX, including expressions that appeared inline in the source.
- Do not use single-dollar delimiters, `\(...\)`, or `\[...\]` for math.
- Put standalone equations in display blocks with the opening and closing `$$` on separate lines. Reflow surrounding prose where necessary without changing its meaning or content.
- Verify symbols, subscripts, superscripts, fractions, operators, values, and units against the rendered original slides. Do not rely on extracted text alone.
- Preserve literal currency symbols as ordinary text; do not turn currency amounts into math solely because they contain a dollar sign. Escape each literal dollar sign in Markdown prose, tables, and non-code annotations as `\$` (a backslash immediately followed by a dollar sign, with no space), for example `\$100`, so it is not confused with a math delimiter.
- Do not escape actual math delimiters or double-escape an existing `\$`. Within a LaTeX expression, use `\$` when a literal dollar symbol is part of the expression. Preserve formulas, values, and wording.
- Leave literal dollars inside fenced code blocks, inline code, and Mermaid diagram code unchanged: Markdown math delimiters are not parsed there, and adding a backslash can alter code or display an unwanted backslash in a diagram label.
- After all conversions are finished, recheck every equation against the original PDF and confirm that every LaTeX expression uses double-dollar delimiters. Formatting changes must not alter the formulas.

## Tables, diagrams, and pictures

- Recreate tables as Markdown tables, preserving column order, row order, values, and blank cells.
- Recreate diagrams in Mermaid or readable text diagrams. Preserve their labels and relationships; do not screenshot diagrams or tables.
- Screenshot only study-related pictures that cannot be represented as text, tables, or diagrams. Save necessary image assets alongside the Markdown and use relative image links.

## Inspection and verification

- Inspect the rendered pages as well as extracted text so image-based content and corrupted formulas are not missed.
- Verify completeness and accuracy before delivery, including content from every page, exercises, supplied answers, equations, tables, diagrams, and required pictures.
- Check the rendered Markdown to ensure math delimiters, tables, diagrams, and image links work as intended. Report any unresolved source uncertainty explicitly rather than guessing.

## Output and GitHub workflow

- Leave every original PDF untouched.
- Put final outputs under `md_materials/`, mirroring the source folder structure under `materials/`.
- Within the corresponding mirrored folder, use a descriptive per-PDF task folder containing one final Markdown version and any necessary image assets.
- Process the PDFs one by one. Finish and verify one PDF, then commit and push that PDF's final outputs to GitHub before proceeding to the next.
- Keep one final version of each deliverable. Remove only task-created temporary files; preserve original files and unrelated work.
- Do the work using the assistant's own cloud tools and the connected GitHub service. Do not use my computer or create a Codex task.
