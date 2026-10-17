import { test, expect } from "@playwright/test";

const material =
  "# Chapter 1\n\n## Question 1\nWhat is $2 + 2$?\n\n### Choices\nA. Three\nB. Four\nC. Five\n\n### Answer\nB\n\n### Solution\nTwo pairs make four.\n";

test("import, submit, correct, annotate, and resume a frozen practice set", async ({
  page,
  request,
}, testInfo) => {
  const name = `Browser test ${Date.now()}`;
  const response = await request.post("http://127.0.0.1:3000/api/libraries", {
    data: { name },
  });
  const library = await response.json();
  expect(response.ok()).toBeTruthy();
  await page.goto("/");
  // The library picker appears only when there is more than one library.
  const picker = page.getByLabel("Library", { exact: true });
  if (await picker.count()) await picker.selectOption(library.id);
  await page.getByRole("button", { name: "Materials", exact: true }).click();
  await page.getByLabel("Markdown source").fill(material);
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect(page.getByText("1 questions found")).toBeVisible();
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(
    page.getByRole("button", { name: "questions.md Edit →" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await page
    .getByRole("button", { name: "Start practice · 1 questions" })
    .click();
  await expect(page.getByText("Two pairs make four.")).toHaveCount(0);
  await page.getByRole("button", { name: "A Three", exact: true }).click();
  await page.getByRole("button", { name: "Submit answer" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Two pairs make four.")).toBeVisible();
  await page.getByRole("button", { name: "B Four", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Unsure", exact: true }).check();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByLabel("My note").fill("Check the arithmetic.");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await page.getByRole("button", { name: "☆ Flag", exact: true }).click();
  await expect(page.getByRole("button", { name: "★ Flagged" })).toBeVisible();
  await page.getByRole("button", { name: "← All practice sets" }).click();
  await page.getByRole("button", { name: /Practice set.*Continue/ }).click();
  await expect(
    page.getByRole("button", { name: "B Four", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("My note")).toHaveValue("Check the arithmetic.");
  await page.screenshot({
    path: testInfo.outputPath("question-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "← All practice sets" }).click();
  await page
    .getByRole("button", { name: "Start practice · 1 questions" })
    .click();
  await expect(
    page.getByRole("button", { name: "B Four", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Submit answer" }),
  ).toBeDisabled();
  await expect(page.getByText("Two pairs make four.")).toHaveCount(0);
  const state = await request.get(
    `http://127.0.0.1:3000/api/libraries/${library.id}/overview`,
  );
  expect((await state.json()).counts.unsure).toBe(1);
  const { questionIds } = await (
    await request.post(
      `http://127.0.0.1:3000/api/libraries/${library.id}/sets/preview`,
      { data: {} },
    )
  ).json();
  const question = await (
    await request.get(
      `http://127.0.0.1:3000/api/libraries/${library.id}/questions/${questionIds[0]}`,
    )
  ).json();
  await page.getByLabel("My note").fill("Keep this unsaved draft.");
  await request.patch(
    `http://127.0.0.1:3000/api/libraries/${library.id}/questions/${question.id}/annotation`,
    {
      data: {
        operationId: crypto.randomUUID(),
        expectedVersion: question.annotation.version,
        note: "Saved in another tab.",
      },
    },
  );
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("My note")).toHaveValue(
    "Keep this unsaved draft.",
  );
  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
});

test("small viewport keeps navigation and material rendering within the viewport", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("navigation")).toBeVisible();
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(fits).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("home-mobile.png"),
    fullPage: true,
  });
});
