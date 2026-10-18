import { useRef, useState } from "react";
import { Markdown } from "./Markdown";
import guide from "./guide.md?raw";
import pdfToMarkdown from "../../../docs/prompts/pdf-to-markdown.md?raw";
import extractQuestions from "../../../docs/prompts/extract-questions.md?raw";
import reviewQuestions from "../../../docs/prompts/review-questions.md?raw";
import questionFormat from "../../../docs/user/question-format.md?raw";

/** The three bank-building prompts, shown under "Build a question bank from your PDFs". */
const PROMPTS = [
  { title: "Prompt 1 · PDF → Markdown", text: pdfToMarkdown },
  { title: "Prompt 2 · Extract questions", text: extractQuestions },
  { title: "Prompt 3 · Review the bank", text: reviewQuestions },
];
const PROMPT_SECTION = "Build a question bank from your PDFs";
const REPOSITORY_FILES =
  "https://github.com/GerardWu100/question-bank-prep/blob/main/";

/** guide.md split at its "## " headings into [{ title, body }]. */
const sections = guide
  .split(/^## /m)
  .filter((part) => part.trim())
  .map((part) => {
    const [title, ...body] = part.split("\n");
    return { title: title.trim(), body: body.join("\n").trim() };
  });

/** The format guide's links point into the repository; make them absolute so they open. */
const formatGuide = questionFormat
  .replace(/^# .*\n/, "")
  .replace(
    /\]\((\.\.\/\.\.\/)?(examples\/[^)]+)\)/g,
    `](${REPOSITORY_FILES}$2)`,
  );

/** One prompt, folded, with a Copy button that copies its full text. */
function PromptCard({ title, text }: { title: string; text: string }) {
  const [status, setStatus] = useState("");
  const textRef = useRef<HTMLPreElement>(null);
  const cardRef = useRef<HTMLDetailsElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied");
    } catch {
      // The clipboard API needs HTTPS or this computer; otherwise select the text instead.
      // The text must be shown to be copied, so unfold the card first.
      if (cardRef.current) cardRef.current.open = true;
      const selection = window.getSelection();
      if (selection && textRef.current) {
        selection.selectAllChildren(textRef.current);
        setStatus("Selected: press Ctrl+C (⌘C on a Mac)");
      }
    }
  };
  return (
    <details className="panel guide-prompt" ref={cardRef}>
      <summary>
        <span>{title}</span>
        <button
          className="secondary small"
          onClick={(event) => {
            // A button inside <summary> must not also fold the card.
            event.preventDefault();
            void copy();
          }}
        >
          Copy
        </button>
        {status && <span className="muted">{status}</span>}
      </summary>
      <pre ref={textRef} className="prompt-text">
        {text}
      </pre>
    </details>
  );
}

/** The in-app user guide: how each page works, the AI setup, and the bank-building prompts. */
export default function Guide() {
  return (
    <>
      <h1>Guide</h1>
      {sections.map((section, index) => (
        <details
          className="panel guide-section"
          key={section.title}
          open={index === 0}
        >
          <summary>
            <h2>{section.title}</h2>
          </summary>
          <Markdown text={section.body} />
          {section.title === PROMPT_SECTION &&
            PROMPTS.map((prompt) => (
              <PromptCard key={prompt.title} {...prompt} />
            ))}
        </details>
      ))}
      <details className="panel guide-section">
        <summary>
          <h2>Question file format</h2>
        </summary>
        <Markdown text={formatGuide} />
      </details>
    </>
  );
}
