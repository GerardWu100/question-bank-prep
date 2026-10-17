import { memo } from "react";
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
const remarkPlugins = [remarkGfm, remarkMath, restoreEscapedDollars];
const rehypePlugins = [rehypeKatex];
const components: Components = {
  img: ({ alt }) => (
    <span className="muted">[Image: {alt || "external image not loaded"}]</span>
  ),
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

/** Shared safe renderer for materials, questions, solutions, notes, and chat.
 * Memoized: typing elsewhere in the app must not re-run Markdown and KaTeX parsing. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text.replaceAll("\\$", ESCAPED_DOLLAR)}
      </ReactMarkdown>
    </div>
  );
});
