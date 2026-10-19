## Start here

**Desktop app.** Click **Create library**. Then, in the menu bar:

1. **File → Question-bank folder…**: pick the folder that holds your question banks (for the CFA, `question_bank`). The app restarts and loads every bank in it.
2. **File → Study-notes folder…**: pick your Markdown notes (for the CFA, `md_materials`). They appear on **Materials**.

Already run the app on a server? Choose **File → Connect to a server…** and enter its address. Your questions, notes and progress then come from the server; sign in with its password. **File → Use this computer** switches back.

**In a browser.** Open the server's address and sign in. The question folder is synced each time you open the app, so a new or fixed bank file shows up on its own.

No folder? **Materials → Import Markdown → Choose a folder** imports a whole bank folder; **Choose a file** imports one file.

## Practice

The **Practice** page lists every topic. Each chapter row shows a progress bar: green is correct, amber is unsure, red is wrong.

| Button | What it does |
|---|---|
| **Start / Continue / Review** | Opens that chapter's questions where you left off |
| **Mistakes** (on a chapter) | Only the questions you got wrong in that chapter |
| **★ Flagged**, **✗ Mistakes**, **? Unsure** (top) | All starred, wrong or unsure questions, from every source |
| **Resume last session** | Back to the exact question you left |
| Source buttons (JC 100, Kaplan, …) | Switch a source off to practise only the others |

**Answering a question**

1. Pick **Sure** or **Unsure**. Choose *Unsure* when you guessed: a lucky guess then goes to the Unsure set instead of hiding among correct answers.
2. Click a choice, then **Submit answer**. The key and the worked solution appear. A short **Intuition (AI)** note, when the bank has one, sits above the source's solution.
3. Clicked the wrong letter by accident? **Misclicked** saves the correct answer instead, so the slip does not land in Mistakes.

Want the answer at once, without Submit? Turn on **Settings → Practice → Show the answer as soon as I pick a choice**.

Text hard to read? **Settings → Display** sets the text size (A− / A+), theme, line width (Full to Narrow) and line spacing.

**Previous** and **Next** stay at the top of the screen; the left and right arrow keys do the same. The numbers under the question jump to any question in the set and are coloured by result. **☆ Flag** stars a question for later. **← Back to Practice** is at the bottom.

Your answer is remembered everywhere: if you answered a question in one set, every other set shows that answer too.

## Materials

Your study notes, one section at a time, with formulas, tables and pictures. The app remembers where you stopped. **Ask AI about this section** under each section asks the tutor about exactly that section; **↑ Top** jumps back up. Open another file, then **↩ Back to …** at the top (or the browser's Back) returns to the file you read before, at the same section and scroll position, so you can switch between two files. Notes are read-only here: the app never changes your files.

## The AI tutor

The tutor sits under every question, under every Materials section, on **Ask AI**, and on **Notes → AI notes**.

- **Hint** (before you answer): one hint at a time. The tutor cannot see the key or the solution, so it cannot give the answer away.
- **Explain** (after you answer): why the key is right and why your choice was wrong.
- **Review my study** (Ask AI page): reads your results by chapter, your mistakes, your questions and your notes, then names your weak spots and the next three chapters to practise.
- It searches your study notes and ends each answer with a **Source:** line naming the file and section it used.
- **Save as AI note** under a reply keeps it on the Notes page.

It only sends the current question or section, the recent messages of that chat, and what it looks up.

**Choose how the tutor connects** in **Settings → AI provider**:

- **ChatGPT subscription (Codex login)**: uses your existing ChatGPT plan through the Codex app on this computer. Nothing to pay per message.
- **API key**: use your own key. Free option: make a key at [openrouter.ai/keys](https://openrouter.ai/keys), choose **API key**, keep the base URL `https://openrouter.ai/api/v1`, paste the key, click **Browse the endpoint's models**, type `free`, click `openrouter/free`, then **Save**. Free models are sometimes busy; just try again.

Then pick the model in **Settings → AI model**. The app caps AI use at 60 requests an hour and 300 a day, so a mistake cannot run up a bill.

## Notes

**My notes** are your own Markdown notes (**New note**, **Edit**, **Delete**). **AI notes** are tutor replies you saved; that tab also has a chat box, and **Continue this chat** reopens the conversation a note came from.

## Move your progress to another device

1. On the old device: **Settings → Export → Study progress (JSON)**.
2. On the new device: load the same question bank first.
3. **Settings → Import study progress** → choose that file.

Your answers, sure/unsure marks, flags and notes come across. The app tells you which questions it could not find.

## Build a question bank from your PDFs

You do not type questions in. An AI coding agent (Claude Code, Codex or similar) does it with three prompts, below, plus an optional fourth that fixes charts. Keep your study files in a **private** Git repository, because they are copyrighted.

```text
your-study-repo/
├── materials/      your PDFs
├── md_materials/   step 1 writes Markdown notes here  → Materials page
└── question_bank/  step 2 writes question banks here  → Practice page
    ├── 01-quantitative-methods/
    │   ├── qbank-2025.md
    │   └── others.md
    └── 02-economics/ …
```

| Step | Prompt | What it does |
|---|---|---|
| 1 | PDF → Markdown | Turns each PDF into faithful Markdown notes, with formulas and tables |
| 2 | Extract questions | Copies the multiple-choice questions word for word into bank files, one source and one topic per run |
| 3 | Review the bank | Removes duplicate questions across sources, writes missing answer keys and short explanations, marked as AI-written |
| 4 (optional) | Redraw charts | Redraws charts left as text or blurry page crops, in the notes and the question bank |

How to use a prompt:

1. Open it below and click **Copy**.
2. Paste it into a new AI-agent session and fill in its **Settings** block (your repository, exam, folders).
3. Run step 2 once per source and topic, and step 3 once per topic. Several sessions can run at the same time.
4. Run the steps in order. Run step 3 again after you add a new source. Run step 4 only if some charts still show as text or blurry page crops.

## Problems

| You see | Do this |
|---|---|
| "Codex subscription token expired" | Open the Codex app so it refreshes its login, then try again |
| "API request failed: 429 … rate-limited" | A free model is busy. Try again, or add another model in Settings → AI provider |
| "AI usage limit reached" | Wait until the time shown |
| A bank file does not appear | Look at the messages after the folder sync, or open the file and check its headings against the question format below |
| The desktop app cannot reach your server | Check the server is running; the app offers Retry, Change server or Use this computer |
