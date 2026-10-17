import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../apps/web/src/Markdown.js";

const render = (text: string) =>
  renderToStaticMarkup(createElement(Markdown, { text }));

test("an escaped dollar inside inline math does not end the formula", () => {
  const html = render(
    "Predicted sales $=\\$10+1.25=\\$11.25\\text{ million}$.",
  );
  expect(html).not.toContain("katex-error");
  expect(html.match(/class="katex"/g)).toHaveLength(1);
  expect(html).not.toContain("");
});

test("an escaped dollar in prose and code stays a literal dollar sign", () => {
  const html = render("Costs \\$100 and `a \\$ b`.");
  expect(html).toContain("Costs $100");
  expect(html).toContain("<code>a \\$ b</code>");
  expect(html).not.toContain("katex");
});

test("<br> becomes a line break and HTML comments disappear", () => {
  const html = render(
    "| a |\n|---|\n| one<br>two |\n\n<!-- page 33 -->\n\nText",
  );
  expect(html).toMatch(/one<br\/>\s*two/);
  expect(html).not.toContain("page 33");
  expect(html).not.toContain("&lt;br&gt;");
});

test("an escaped dollar inside display math renders without a KaTeX error", () => {
  const html = render("$$\nPVD=\\frac{\\$0.3}{1.04^{20/365}}=\\$0.795\n$$");
  expect(html).not.toContain("katex-error");
  expect(html).toContain("katex-display");
});

test("prose after a closing $$ on the same line stays outside the formula", () => {
  const html = render(
    "$$\nx=1\n$$ Actual P/E is higher.\n\nNext paragraph $y$.",
  );
  expect(html).not.toContain("katex-error");
  expect(html).toContain("Actual P/E is higher.");
  expect(html.match(/class="katex"/g)).toHaveLength(2);
});

test("display math with & alignment renders without an environment", () => {
  const html = render("$$\na&=b+c\\\\\nd&=e\n$$");
  expect(html).not.toContain("katex-error");
});

test("text glued to $$ fences and indented fences inside lists still render", () => {
  const glued = render(
    "$$\\begin{aligned}\na&=b\\\\\nc&=d\\end{aligned}$$\n\nAfter $x$.",
  );
  expect(glued).not.toContain("katex-error");
  expect(glued).toContain("After");
  const listed = render("1. Item\n   $$\nx=1\n$$\n\n2. Next $y$.");
  expect(listed).not.toContain("katex-error");
  expect(listed.match(/class="katex"/g)).toHaveLength(2);
});

test("a formula indented inside a list keeps the following bullets as a list", () => {
  const html = render(
    "- **Homoskedasticity:**\n\n  $$\n  E(e^2)=s^2\n  $$\n\n- **Independence:** uncorrelated.",
  );
  expect(html).not.toContain("<pre>");
  expect(html).toContain("<strong>Independence:</strong>");
});
