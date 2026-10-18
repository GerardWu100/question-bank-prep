# Prompt 1: PDF study material → Markdown

Step 1 of 3. Converts exam-prep PDFs into faithful Markdown notes, which prompt 2 then extracts questions from.

How to use: fill in **Settings** and give everything below the line to an AI agent. The prompt is self-contained.

---

## Settings

- **REPOSITORY**: `<git URL of your study repository>`
- **EXAM**: `<exam name and level>`
- **PDF_FOLDER**: `materials/` (source PDFs, never edited)
- **OUTPUT_FOLDER**: `md_materials/` (Markdown output, mirrors PDF_FOLDER)
- **OUTLINE**: `<file listing the exam's topics and chapters in order>`
- **PDFS**: `<which PDFs to convert, or "all not yet converted">`

## Task

First pull the latest REPOSITORY (`git pull`; clone it if you do not have it). Then convert the PDFs in PDFS into faithful Markdown study notes. Convert every page, not a summary or a selection.

## Content and structure

- Simplify the slide layout but keep the study content, its order, wording, values and units.
- Use meaningful topic headings, such as "The Gordon Growth Model". Remove page-number prefixes, and merge repeated headings without losing content or changing its order.
- Heading levels: one `#` for the file title, `##` for readings or chapters, `###` and deeper below them.
- A file that covers the whole syllabus (a review book or a framework) keeps its title as the first `#`, then uses exactly one `#` per exam topic, with the topic names and order from OUTLINE; its readings are `##`. A reader can then open it one topic at a time.
- Practice questions: keep each question's numbering, keep choice labels as `A.`, `B.`, `C.`, and keep each answer key on its own explicit line (for example `Answer: B`), so questions and keys can be matched later.
- Leave out author credits, logos, decorative cover images and other non-study elements.
- Translate all non-English study text into English.
- Keep every exercise and every supplied answer. Do not invent answers, fill unsupported blanks or silently correct apparent source errors. Flag an apparent source error, and unreadable or uncertain content, in place with a short note such as `> Source note: the key says C, but the worked solution gives B.`

## Equations

- Inline math is `$...$`; standalone equations are `$$...$$` blocks. Never use `\(...\)` or `\[...\]`.
- The opening and closing `$$` of a display block each stand alone on their own line, with no text before or after them on that line (not `$$ Actual P/E is…`, not `\end{aligned}$$`). Inside a list item, indent both fences and the formula like the item's text. Reflow the surrounding prose if needed without changing its meaning.
- Use `&` alignment and `\\` line breaks only inside `\begin{aligned}…\end{aligned}`. Use `\tag` only in display blocks.
- Check symbols, subscripts, superscripts, fractions, operators, values and units against the rendered pages, not against extracted text alone.
- Money: write a literal dollar sign as `\$` (backslash, then dollar, no space), for example `\$100`, in prose, tables and annotations, so it is never read as the start of a formula. Do not turn amounts into math. Do not escape real math delimiters or double-escape an existing `\$`; inside a formula, use `\$` for a literal dollar symbol.
- Leave dollar signs in fenced code, inline code and Mermaid code unchanged: math is not parsed there, and a backslash would show or break the code.
- When all conversions are finished, recheck every equation against the PDF and the delimiter rules above. Formatting must never change a formula.

## Tables, diagrams and pictures

These are defaults, not bans. When another form shows a table, diagram or chart more faithfully or more clearly (a picture, a text chart, HTML), use it and say why in your report.

- Recreate tables as Markdown tables with the same column order, row order, values and blank cells. Prefer plain Markdown in cells: separate items in one cell with `; ` rather than `<br>`. Use HTML only where Markdown cannot show the content; page markers are HTML comments such as `<!-- Source PDF page 12 -->`.
- Recreate structure diagrams (flows, decision trees, hierarchies, timelines) as Mermaid with the same labels and relationships.
- Charts and graphs: by default, redraw a simple one with code and keep the original picture of a complex one.
  - **Simple: redraw.** A curve given by an equation, a chart whose data the page gives, or a few readable points (about 20 or fewer per series, a few series): payoff diagrams, yield and term-structure curves, supply and demand, efficient frontiers, a small bar or line chart. Choose the tool that draws it best (for example Python with matplotlib or plotly, Mermaid's `xychart-beta` for a simple line or bar chart, or another plotting library). When the page gives no data, measure the points from the page image's pixels (find each line or bar by its colour, map pixels to values with the axis ticks) and end the caption with "values approximate". Keep the original title, axes, units, labels, key points and annotations. Save it next to the Markdown as a PNG or SVG (readable on a white background), with its source script under the same name, so it can be regenerated or fixed later.
  - **Complex: keep the original picture, even if Python could approximate it.** Dense real data (price paths, intraday series, scatter clouds, histograms with many bars), many overlapping series, or values you would have to read point by point or cannot read (cut off at the axis). A redraw would smooth away or invent detail. In a born-digital PDF, extract the chart's own embedded picture at full resolution (for example with the `tools` repository's `pdf-to-markdown/pdf2md.py prepare <PDF> --pages <N>`, which saves each page's embedded pictures in `work/images/`; the `my-tools` skill says how to run it); otherwise crop the chart from the rendered page. Include the chart's title, axes and legend, not its caption, which you write as text.
  - Embed either kind with a relative link.
- Also keep the original picture for what Mermaid, a table or a chart cannot show (a photo, a scanned form). Keep image files next to the Markdown and use relative links.

## Check before you deliver

- Look at the rendered pages as well as the extracted text, so image-only content and broken formulas are not missed.
- Confirm completeness: every page, exercise, supplied answer, equation, table, diagram and needed picture is present.
- Check that the Markdown renders: math, tables, diagrams and image links. Preview each file in a Markdown viewer with KaTeX math and Mermaid (for example VS Code's preview or GitHub) and fix every formula that fails to render.
- Quick text checks on each file: `grep -nE '^\s*\$\$.+|.+\$\$\s*$' <file>` lists only one-line `$$…$$` formulas, and `grep -n '\\(' <file>` finds no `\(` math.
- Report every unresolved uncertainty in the source instead of guessing.

## Output and version control

- Never change the original PDFs.
- Write outputs under OUTPUT_FOLDER, mirroring the folders under PDF_FOLDER. Inside each mirrored folder, use one descriptive folder per PDF with one final Markdown file and its images.
- Work one PDF at a time: finish and check it, then commit and push its Markdown as soon as it is finished, before you start the next.
- Keep one final version of each file. Remove only temporary files you created; keep original files and unrelated work.
