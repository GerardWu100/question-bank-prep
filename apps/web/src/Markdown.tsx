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
  const visit = (node: any, literal = LITERAL_INSIDE.has(node.type)) => {
    if (typeof node.value === "string")
      node.value = node.value.replaceAll(ESCAPED_DOLLAR, literal ? "\\$" : "$");
    // remark-math copies the formula into data.hChildren, which rehype-katex reads.
    node.data?.hChildren?.forEach((child: any) => visit(child, literal));
    node.children?.forEach((child: any) => visit(child));
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
const remarkPlugins = [
  remarkGfm,
  remarkMath,
  restoreEscapedDollars,
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
 */
function MermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    const root = document.documentElement;
    const dark =
      root.dataset.theme === "dark" ||
      (!root.dataset.theme &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
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
      .catch(() => current && setFailed(true));
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
const components: Components = {
  pre: ({ children, node, ...rest }) => {
    // react-markdown renders ```lang blocks as <pre><code class="language-lang">.
    const code: any = Array.isArray(children) ? children[0] : children;
    if (String(code?.props?.className ?? "").includes("language-mermaid"))
      return <MermaidDiagram code={String(code.props.children ?? "").trim()} />;
    return <pre {...rest}>{children}</pre>;
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
 * `readingDirectory` (a folder inside READING_ROOT) lets relative images load from the
 * read-only reading route; everywhere else images stay as placeholders. */
export const Markdown = memo(function Markdown({
  text,
  readingDirectory,
}: {
  text: string;
  readingDirectory?: string;
}) {
  const rendered = useMemo<Components>(
    () =>
      readingDirectory === undefined
        ? components
        : {
            ...components,
            img: ({ src, alt }) =>
              typeof src === "string" && !/^[a-z]+:/i.test(src) ? (
                <img
                  src={`/api/reading/file?path=${encodeURIComponent(joinReadingPath(readingDirectory, decodeURI(src)))}`}
                  alt={alt || ""}
                />
              ) : (
                imagePlaceholder(alt)
              ),
          },
    [readingDirectory],
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={rendered}
      >
        {text.replaceAll("\\$", ESCAPED_DOLLAR)}
      </ReactMarkdown>
    </div>
  );
});
