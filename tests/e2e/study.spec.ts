import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const material =
  "# Chapter 1\n\n## Question 1\nWhat is $2 + 2$?\n\n### Choices\nA. Three\nB. Four\nC. Five\n\n### Answer\nB\n\n### Solution\nTwo pairs make four.\n";

test("import, submit, correct, annotate, and resume a frozen practice set", async ({
  page,
  request,
}, testInfo) => {
  const name = `Browser test ${Date.now()}`;
  const response = await request.post("/api/libraries", {
    data: { name },
  });
  const library = await response.json();
  expect(response.ok()).toBeTruthy();
  await page.goto("/");
  // The library picker appears only when there is more than one library.
  const picker = page.getByLabel("Library", { exact: true });
  if (await picker.count()) await picker.selectOption(library.id);
  await page.getByRole("button", { name: "Materials", exact: true }).click();
  // A picked folder: the bank file in a topic subfolder, plus a README that is skipped.
  const folder = testInfo.outputPath("bank-folder");
  mkdirSync(join(folder, "01-arithmetic"), { recursive: true });
  writeFileSync(join(folder, "01-arithmetic", "drills.md"), material);
  writeFileSync(join(folder, "README.md"), "# About this bank\n");
  await page.getByLabel("Choose a folder").setInputFiles(folder);
  await expect(page.getByText("1 Markdown file: 01-arithmetic/drills.md")).toBeVisible();
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect(page.getByText("1 questions found")).toBeVisible();
  await page.getByRole("button", { name: "Confirm import" }).click();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  // Practice home lists each source and chapter with its own Start button.
  await page
    .getByRole("button", { name: "Start", exact: true })
    .first()
    .click();
  await expect(page.getByText("Two pairs make four.")).toHaveCount(0);
  await page.getByRole("button", { name: "A Three", exact: true }).click();
  await page.getByRole("button", { name: "Submit answer" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Two pairs make four.")).toBeVisible();
  // A wrong answer from a slip can be corrected in one click.
  await page.getByRole("button", { name: "Misclicked" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "B Four", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("radio", { name: "Unsure", exact: true }).check();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "☆ Flag", exact: true }).click();
  await expect(page.getByRole("button", { name: "★ Flagged" })).toBeVisible();
  await page.getByRole("button", { name: "← Practice" }).click();
  await page
    .getByRole("button", { name: "Review", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "B Four", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: testInfo.outputPath("question-desktop.png"),
    fullPage: true,
  });
  // A new custom set remembers the latest answer from any set.
  await page.getByRole("button", { name: "← Practice" }).click();
  await page.getByText("Custom practice set").click();
  await page
    .getByRole("button", { name: "Start practice · 1 questions" })
    .click();
  await expect(
    page.getByRole("button", { name: "B Four", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Two pairs make four.")).toBeVisible();
  const state = await request.get(
    `/api/libraries/${library.id}/overview`,
  );
  expect((await state.json()).counts.unsure).toBe(1);
  // Refresh keeps the open set; Back returns to it from another page.
  await page.reload();
  await expect(
    page.getByRole("button", { name: "B Four", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByLabel("Title").fill("Regression checklist");
  await page.getByLabel("Note (Markdown)").fill("Check the arithmetic.");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByText("Regression checklist")).toBeVisible();
  // Deleting asks first; accepting the confirmation removes the note.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByText("Regression checklist").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Regression checklist")).toHaveCount(0);
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "B Four", exact: true }),
  ).toBeVisible();
});

test("small viewport keeps navigation and material rendering within the viewport", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("navigation")).toBeVisible();
  // Name every element that sticks out, so a failure says what to fix. The
  // navigation bar scrolls sideways on purpose and is left out.
  const outside = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter(
        (element) =>
          !element.closest("nav") &&
          element.getBoundingClientRect().right > window.innerWidth + 1,
      )
      .map(
        (element) =>
          `${element.tagName}.${element.className}: ${element.textContent?.slice(0, 40)}`,
      ),
  );
  expect(outside).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("home-mobile.png"),
    fullPage: true,
  });
});
