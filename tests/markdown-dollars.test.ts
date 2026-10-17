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
