import { memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

// remark-math ends a formula at any "$", even an escaped "\$" meaning a literal dollar
// sign (banks write "$=\$10+\$8$"). Hide "\$" behind a private-use character before
// parsing, then put it back: "\$" inside math and code (KaTeX draws a dollar sign),
// a plain "$" in prose.
const ESCAPED_DOLLAR = "\uE000";
const LITERAL_INSIDE = new Set(["inlineMath", "math", "inlineCode", "code"]);
function restoreEscapedDollars() {
  // Everything below a math or code node is literal, however deeply it is nested.
  const visit = (node: any, insideLiteral = false) => {
    const literal = insideLiteral || LITERAL_INSIDE.has(node.type);
    if (typeof node.value === "string")
      node.value = node.value.replaceAll(ESCAPED_DOLLAR, literal ? "\\$" : "$");
    // remark-math copies the formula into data.hChildren (nested for display math),
    // which rehype-katex reads.
    node.data?.hChildren?.forEach((child: any) => visit(child, literal));
    node.children?.forEach((child: any) => visit(child, literal));
  };
  return (tree: any) => visit(tree);
}
/**
 * Raw HTML stays escaped for safety, but two harmless forms are common in converted notes:
 * <br> (a line break, often inside table cells) becomes a real break, and <!-- comments -->
 * are dropped instead of showing as text.
 */
function tidyInlineHtml() {
  const visit = (node: any) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child: any) => {
      if (child.type === "html") {
        if (/^<br\s*\/?>$/i.test(child.value.trim()))
          return [{ type: "break" }];
        if (/^<!--[\s\S]*-->$/.test(child.value.trim())) return [];
      }
      visit(child);
      return [child];
    });
  };
  return (tree: any) => visit(tree);
}
/** A line that starts with a toggle tag: <details>, <details open>, <summary> or a close. */
const TOGGLE_LINE = /^[ \t]*<\/?(details|summary)\b/i;
const TOGGLE_TAGS = /(<details(?:\s+open)?\s*>|<\/details\s*>|<\/?summary\s*>)/i;
/**
 * Put each toggle tag on its own line between blank lines, so the parser sees every tag
 * as a separate HTML node and the Markdown between them as normal Markdown:
 *   "<details><summary>## Title</summary>"  ->  "<details>", "<summary>", "## Title", "</summary>"
 * Lines keep their indentation (a toggle inside a list stays in the list). Fenced code and
 * lines holding backticks (`<details>` written as an example) are left alone.
 */
function splitToggleTags(text: string) {
  let fence = "";
  return text
    .split("\n")
    .flatMap((line) => {
      const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && !fence) fence = marker;
      else if (marker && marker[0] === fence[0] && marker.length >= fence.length)
        fence = "";
      else if (!fence && TOGGLE_LINE.test(line) && !line.includes("`")) {
        const indent = /^[ \t]*/.exec(line)![0];
        return line
          .split(TOGGLE_TAGS)
          .map((part) => part.trim())
          .filter(Boolean)
          .flatMap((part) => ["", indent + part, ""]);
      }
      return [line];
    })
    .join("\n");
}
/**
 * A "$$" fence pair must share its indentation. When the opening fence is indented deeper
 * than its closing fence (a list item whose formula was pasted flush left), move the
 * opening fence out to the closing fence's indent. Matching pairs are left alone, so a
 * properly indented formula inside a list stays in the list.
 */
function alignFenceIndents(text: string) {
  const lines = text.split("\n");
  const fence = /^([ \t]*)\$\$[ \t]*$/;
  for (let open = 0; open < lines.length; open++) {
    const start = fence.exec(lines[open]);
    if (!start) continue;
    let close = open + 1;
    while (close < lines.length && !fence.test(lines[close])) close++;
    if (close >= lines.length) break;
    const end = fence.exec(lines[close])!;
    if (end[1].length < start[1].length) lines[open] = `${end[1]}$$`;
    open = close;
  }
  return lines.join("\n");
}
/**
 * Source text -> parser input. Hides escaped dollars (see above) and repairs common
 * conversion slips around display math, each of which would otherwise swallow the rest
 * of the page into one formula:
 *   - text on the same line after an opening or closing "$$" ("$$\\begin{aligned}",
 *     "$$ Actual P/E is…");
 *   - text on the same line before a closing "$$" ("\\end{aligned}$$").
 * Lines holding two "$$" (a one-line display formula) are left alone.
 */
function prepareMarkdown(text: string) {
  return (
    alignFenceIndents(splitToggleTags(text))
      // \[ … \] and \( … \) (common in AI replies) become $$ … $$ and $ … $.
      .replace(
        /\\\[([\s\S]+?)\\\]/g,
        (_, math) => `\n$$$$\n${math.trim()}\n$$$$\n`,
      )
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => `$${math.trim()}$`)
      .replaceAll("\\$", ESCAPED_DOLLAR)
      .replace(/^([ \t]*)\$\$[ \t]*(?=\S)(?!.*\$\$)/gm, "$1$$$$\n")
      .replace(
        /^(?!.*\$\$.*\$\$)(?![ \t]*\$\$)(.*\S)[ \t]*\$\$[ \t]*$/gm,
        "$1\n$$$$",
      )
  );
}
/** Display formulas that use "&" alignment without an environment get an aligned block. */
function alignDisplayMath() {
  const visit = (node: any) => {
    if (
      node.type === "math" &&
      node.value.includes("&") &&
      !/\\begin\{/.test(node.value)
    ) {
      node.value = `\\begin{aligned}${node.value}\\end{aligned}`;
      node.data?.hChildren?.forEach(function setText(child: any) {
        if (child.type === "text") child.value = node.value;
        child.children?.forEach(setText);
      });
    }
    node.children?.forEach(visit);
  };
  return (tree: any) => visit(tree);
}
const DETAILS_OPEN = /^<details(\s+open)?\s*>$/i;
const DETAILS_CLOSE = /^<\/details\s*>$/i;
const SUMMARY_OPEN = /^<summary\s*>$/i;
const SUMMARY_CLOSE = /^<\/summary\s*>$/i;
/**
 * Turn <details>/<summary> tag nodes (one per tag after `splitToggleTags`) into a real
 * Notion-style toggle wrapping the Markdown between them. Nesting works; a missing
 * </details> closes at the end of its parent; stray tags are dropped. A summary that is
 * one paragraph becomes inline text; a heading ("## Title") stays a heading, which makes
 * a toggle heading.
 *   html"<details>" html"<summary>" heading html"</summary>" paragraph… html"</details>"
 *   -> toggle{ toggleSummary{ heading }, paragraph… }  (rendered <details class="toggle">)
 */
function groupToggles() {
  interface Frame {
    open: boolean;
    summary: any[] | null;
    inSummary: boolean;
    children: any[];
  }
  const tagOf = (node: any) => (node.type === "html" ? node.value.trim() : "");
  const toggleOf = (frame: Frame) => {
    const summary = frame.summary ?? [];
    const only = summary.length === 1 ? summary[0] : null;
    return {
      type: "toggle",
      data: {
        hName: "details",
        hProperties: { className: ["toggle"], ...(frame.open && { open: true }) },
      },
      children: [
        {
          type: "toggleSummary",
          data: { hName: "summary" },
          children:
            only?.type === "paragraph"
              ? only.children
              : summary.length
                ? summary
                : [{ type: "text", value: "Details" }],
        },
        ...frame.children,
      ],
    };
  };
  const visit = (parent: any) => {
    if (!parent.children) return;
    const stack: Frame[] = [
      { open: false, summary: null, inSummary: false, children: [] },
    ];
    for (const child of parent.children) {
      const tag = tagOf(child);
      const frame = stack.at(-1)!;
      const opening = DETAILS_OPEN.exec(tag);
      if (opening)
        stack.push({
          open: Boolean(opening[1]),
          summary: null,
          inSummary: false,
          children: [],
        });
      else if (SUMMARY_OPEN.test(tag)) {
        if (stack.length > 1 && !frame.summary) {
          frame.summary = [];
          frame.inSummary = true;
        }
      } else if (SUMMARY_CLOSE.test(tag)) frame.inSummary = false;
      else if (DETAILS_CLOSE.test(tag)) {
        if (stack.length > 1) stack.at(-2)!.children.push(toggleOf(stack.pop()!));
      } else {
        visit(child);
        (frame.inSummary ? frame.summary! : frame.children).push(child);
      }
    }
    while (stack.length > 1) stack.at(-2)!.children.push(toggleOf(stack.pop()!));
    parent.children = stack[0].children;
  };
  return (tree: any) => visit(tree);
}
const remarkPlugins = [
  remarkGfm,
  remarkMath,
  restoreEscapedDollars,
  alignDisplayMath,
  groupToggles,
  tidyInlineHtml,
];
const rehypePlugins = [rehypeKatex];
const imagePlaceholder = (alt?: string) => (
  <span className="muted">[Image: {alt || "external image not loaded"}]</span>
);
let mermaidCount = 0;
/**
 * Draw a ```mermaid block as an SVG diagram. Mermaid loads on first use (it is large) in
 * strict security mode, which sanitizes labels; a diagram that fails to parse stays as code.
 * Strict mode also runs DOMPurify over the finished SVG; the server's Content-Security-
 * Policy (no inline scripts) backs it up, since diagrams come from notes and AI replies.
 */
function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    const root = document.documentElement;
    // "dark" and "sepia-dark" are dark; no theme set follows the device.
    const dark = root.dataset.theme
      ? root.dataset.theme.endsWith("dark")
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "neutral",
        });
        const result = await mermaid.render(`mermaid-${++mermaidCount}`, code);
        if (current) setSvg(result.svg);
      })
      .catch((error) => {
        // A tab older than the latest build asks for a code file that no longer exists:
        // reload once to fetch the current build, otherwise show the diagram source.
        if (
          String(error).includes("dynamically imported module") &&
          !sessionStorage.getItem("reloadedForBuild")
        ) {
          sessionStorage.setItem("reloadedForBuild", "1");
          window.location.reload();
          return;
        }
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [code]);
  if (failed)
    return (
      <pre>
        <code>{code}</code>
      </pre>
    );
  return (
    <div
      className="mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
/**
 * A fenced code block: a bar with its language and a Copy button, then the code with
 * syntax colours. highlight.js (its common languages) loads on first use, like Mermaid;
 * a block without a language, or one it does not know, stays plain. Its output is the
 * escaped code wrapped in <span class="hljs-…">, so the inner HTML holds no markup
 * from the note itself.
 */
function CodeBlock({ code, language }: { code: string; language: string }) {
  const [highlighted, setHighlighted] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let current = true;
    setHighlighted("");
    if (language)
      void import("highlight.js/lib/common").then(({ default: hljs }) => {
        if (current && hljs.getLanguage(language))
          setHighlighted(hljs.highlight(code, { language }).value);
      });
    return () => {
      current = false;
    };
  }, [code, language]);
  // The Clipboard API exists only in secure contexts (HTTPS, localhost).
  const copy = navigator.clipboard
    ? () =>
        void navigator.clipboard.writeText(code).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), COPIED_LABEL_MS);
        })
    : null;
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span>{language || "code"}</span>
        {copy && (
          <button className="quiet" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {highlighted ? (
        <pre>
          <code
            className="hljs"
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
/** How long a code block's Copy button says "Copied". */
const COPIED_LABEL_MS = 1500;
const components: Components = {
  pre: ({ children }) => {
    // react-markdown renders ```lang blocks as <pre><code class="language-lang">.
    const code: any = Array.isArray(children) ? children[0] : children;
    const language =
      /language-(\S+)/.exec(String(code?.props?.className ?? ""))?.[1] ?? "";
    const text = String(code?.props?.children ?? "").replace(/\n$/, "");
    if (language === "mermaid") return <MermaidDiagram code={text.trim()} />;
    return <CodeBlock code={text} language={language} />;
  },
  img: ({ alt }) => imagePlaceholder(alt),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="table-scroll">
      <table>{children}</table>
    </div>
  ),
};

/** decodeURI that keeps a malformed path ("a%E0.png") as written instead of throwing,
 * which would blank the whole page. */
function safeDecodeURI(src: string) {
  try {
    return decodeURI(src);
  } catch {
    return src;
  }
}

/** "a/b/../c/./d.png" -> "a/c/d.png" (paths inside the reading folder). */
function joinReadingPath(directory: string, src: string) {
  const parts: string[] = [];
  for (const part of `${directory}/${src}`.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** Shared safe renderer for materials, questions, solutions, notes, and chat.
 * Memoized: typing elsewhere in the app must not re-run Markdown and KaTeX parsing.
 * `readingDirectory` (a folder inside READING_ROOT) or `bankDirectory` (a folder inside
 * MATERIAL_ROOT) lets relative images load from that folder's read-only route; everywhere
 * else images stay as placeholders. */
export const Markdown = memo(function Markdown({
  text,
  readingDirectory,
  bankDirectory,
}: {
  text: string;
  readingDirectory?: string;
  bankDirectory?: string;
}) {
  const directory = readingDirectory ?? bankDirectory;
  const route =
    readingDirectory !== undefined ? "reading/file" : "material-root/file";
  const rendered = useMemo<Components>(
    () =>
      directory === undefined
        ? components
        : {
            ...components,
            img: ({ src, alt }) =>
              typeof src === "string" && !/^[a-z]+:/i.test(src) ? (
                <img
                  src={`/api/${route}?path=${encodeURIComponent(joinReadingPath(directory, safeDecodeURI(src)))}`}
                  alt={alt || ""}
                />
              ) : (
                imagePlaceholder(alt)
              ),
          },
    [directory, route],
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={rendered}
      >
        {prepareMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
});
