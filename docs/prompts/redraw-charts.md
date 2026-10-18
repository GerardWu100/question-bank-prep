# Prompt 4: Redraw charts (optional)

Optional clean-up after steps 1 to 3. Finds charts that the notes or the question bank show as text art, a text description, or a cropped page picture, and redraws them as real charts drawn by code, in the notes and in every copy in the question bank.

How to use: fill in **Settings** and give everything below the line to an AI agent. The prompt is self-contained. Run it when prompt 1 fell back to text or crops for some charts, for example on notes converted before prompt 1 asked for code-drawn charts.

---

## Settings

- **REPOSITORY**: `<git URL of your study repository>`
- **SOURCE_PDFS**: `materials/` (the original PDFs; read only)
- **MATERIALS**: `md_materials/` (Markdown notes from step 1)
- **BANK**: `question_bank/` (question banks from steps 2 and 3)
- **TRACKING**: `docs/question-bank/`
- **SCOPE**: `<MATERIALS and BANK, or one subfolder of MATERIALS per session; several sessions can run in parallel on different subfolders>`

## Task

First pull the latest REPOSITORY (`git pull`; clone it if you do not have it). In SCOPE, replace every chart that is not a real chart with one drawn by code, and update every copy of that chart in BANK. Change nothing else.

## 1. Find them

Search SCOPE for four forms and list every hit (file, line, form, source PDF and page) before you change anything:

- **Text art**: a fenced code block that draws axes with `|`, `-`, `+` or box characters and marks such as `•`, `*`, `o`, `x`.
- **Text stand-ins**: notes such as `[Graph: …]`, `[Chart: …]`, `[Figure: …]`, "text reconstruction", "readable-text reconstruction", or a bold label followed by bullets that describe axes and curves.
- **Description tables**: a table with a column such as "Text reconstruction" or "Source graph component".
- **Page crops**: an image whose script only cuts it out of the PDF (for example a PyMuPDF `get_pixmap` call), or an image with no script beside it that shows a chart.

## 2. Decide

- **Redraw** a data or function plot (axes with curves, lines, dots, bars or shaded regions: payoff diagrams, yield curves, distributions, scatter plots, supply and demand) and a simple schematic (a timeline, a small tree, a growth-rate diagram).
- **Keep as a picture** a photo, a scanned form, a dense table or text block, or a complex multi-panel figure that a redraw would lose detail from. A text form of such a figure becomes a crop of the original page instead.
- A flow, decision tree or hierarchy with labelled boxes becomes Mermaid, inline in the Markdown.

## 3. Redraw

- Open the source page in SOURCE_PDFS; the Markdown names its source.
- Draw the chart with code, choosing the tool that draws it best: Python with matplotlib or plotly, Mermaid `xychart-beta` for a simple line or bar chart, or another plotting library. Run Python through `uv run --with <library> python`.
- Use the data, table or equation the page gives. When it gives none, read approximate values off the figure and end the caption or alt text with "values approximate". Never invent points, curves or labels.
- Keep the original title, axis labels, units, tick labels, curve labels, key points and annotations. Add no title the original lacks.
- Save the chart as SVG (or PNG), readable on a white background, next to its Markdown file, with its source script under the same name. The script starts with a comment naming the source PDF and page and writes the image beside itself.
- Look at the result beside the original page and fix it until the content matches.

## 4. Replace, and change nothing else

- In MATERIALS, replace only the text chart and its stand-in note (or the old image link) with the new image link. Leave every other byte unchanged. Delete an image file the new one replaces.
- **Copies in BANK.** Search BANK for the same chart: the same source and page, the same case passage or exhibit, the same stand-in text, or the same image name. Replace each copy too. Put the image and its script in that topic's `BANK/<NN-topic>/assets/` folder and link it as `assets/<file>`. Never put any other `.md` file in BANK: every `.md` file there is read as a question bank.

## 5. Check

- For each edited BANK file, count `Question` headings, choices and answer keys before and after with a small script; the counts must not change.
- Every image link in SCOPE points to a file that exists.
- Preview a few edited files in a Markdown viewer with math and Mermaid support.

## Finish

1. Add a section **Redrawn charts** to `TRACKING/review-log.md` (create it if missing): date, file, image, form replaced (text art, stand-in, table or crop), tool, and "values approximate" when it applies.
2. Commit after each finished file. Other sessions may run at the same time: before each push run `git pull --rebase`. Never copy study text into a public repository.

## Report

End with a table: file, charts redrawn, charts kept as pictures (with the reason), BANK copies updated, and any chart left as text with the reason (for example, the source page is unreadable).
