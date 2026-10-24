import { expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../apps/web/src/Markdown.js";

const render = (text: string) =>
  renderToStaticMarkup(createElement(Markdown, { text }));

test("<details>/<summary> written on one line becomes a toggle with Markdown inside", () => {
  const html = render(
    "<details><summary>Why **duration**?</summary>\n\nBecause $D=\\frac{1}{y}$.\n\n</details>\n\nAfter",
  );
  expect(html).toMatch(
    /<details class="toggle"><summary>Why <strong>duration<\/strong>\?<\/summary><p>Because <span class="katex">/,
  );
  expect(html).toMatch(/<\/details>\s*<p>After<\/p>/);
  expect(html).not.toContain("&lt;");
});

test("a heading in the summary makes a toggle heading; open and nesting work", () => {
  const html = render(
    "<details open>\n<summary>## Bonds</summary>\n\n<details><summary>Inner</summary>\n\n- a\n\n</details>\n\n</details>",
  );
  expect(html).toContain(
    '<details class="toggle" open=""><summary><h2>Bonds</h2></summary><details class="toggle"><summary>Inner</summary><ul>',
  );
});

test("a missing </details> closes at the end, and backticked tags stay text", () => {
  const html = render("Use `<details>` for toggles.\n\n<details>\n\nBody");
  expect(html).toContain("<code>&lt;details&gt;</code>");
  expect(html).toContain('<details class="toggle"><summary>Details</summary><p>Body</p></details>');
});

test("toggle tags inside fenced code stay code", () => {
  const html = render("```html\n<details><summary>x</summary></details>\n```");
  expect(html).not.toContain('class="toggle"');
  expect(html).toContain("&lt;details&gt;&lt;summary&gt;x");
});

test("a fenced code block shows its language bar and the code", () => {
  const html = render("```python\nprint(1)\n```");
  expect(html).toContain('<div class="code-block-bar"><span>python</span>');
  expect(html).toContain("<code>print(1)</code>");
});
