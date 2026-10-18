import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/** Import a small bank into a dedicated library, then open that library. */
async function practiceLibrary(page: Page, request: APIRequestContext) {
  const created = await request.post("/api/libraries", {
    data: { name: `Resume test ${Date.now()}` },
  });
  expect(created.ok()).toBeTruthy();
  const library = await created.json();
  const scope = `/api/libraries/${library.id}`;
  const content = [1, 2, 3].map((number) =>
    `## Question ${number}\nResume fixture question ${number}\n\n### Choices\nA. One\nB. Two\n\n### Answer\nA\n`,
  ).join("\n");
  const preview = await request.post(`${scope}/imports/preview`, {
    data: { files: [{ path: "resume.md", content }] },
  });
  expect(preview.ok()).toBeTruthy();
  const imported = await request.post(`${scope}/imports/${(await preview.json()).id}/commit`, {
    data: { acceptWarnings: true },
  });
  expect(imported.ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Practice", exact: true })).toBeVisible();
  const picker = page.getByLabel("Library", { exact: true });
  if (await picker.count()) await picker.selectOption(library.id);
  await expect(page.getByRole("button", { name: "Start", exact: true }).first()).toBeEnabled();
  return { library, scope };
}

test("Resume keeps the last visited set and exact answered question after reload", async ({ page, request }) => {
  const { library, scope } = await practiceLibrary(page, request);
  const resume = page.getByRole("button", { name: "Resume last session", exact: true });
  await expect(resume).toBeDisabled();
  await page.getByRole("button", { name: "Start", exact: true }).first().click();
  await expect(page.getByText("Resume fixture question 1", { exact: true })).toBeVisible();
  const firstSetURL = page.url();
  await page.getByRole("button", { name: "← Practice" }).click();

  // Create a newer set, then revisit the earlier set: creation order is not recency.
  await page.getByText("Custom practice set", { exact: true }).click();
  await page.getByPlaceholder("Search your library").fill("Resume fixture question 3");
  await page.getByRole("button", { name: "Start practice · 1 questions", exact: true }).click();
  await expect(page.getByText("Resume fixture question 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← Practice" }).click();
  await page.getByRole("button", { name: "Start", exact: true }).first().click();
  await expect(page).toHaveURL(firstSetURL);
  await page.getByRole("button", { name: "Question 2", exact: true }).click();
  await page.getByRole("button", { name: "A One", exact: true }).click();
  await page.getByRole("button", { name: "Submit answer", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← Practice" }).click();
  await page.reload();
  const picker = page.getByLabel("Library", { exact: true });
  if (await picker.count()) await expect(picker).toHaveValue(library.id);
  await resume.click();
  await expect(page).toHaveURL(firstSetURL);
  await expect(page.getByText("Resume fixture question 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "A One", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByText("Resume fixture question 2", { exact: true })).toBeVisible();
  const overview = await request.get(`${scope}/overview`);
  expect((await overview.json()).sets).toHaveLength(2);
});

test("Resume is library-specific and ignores a missing saved set", async ({ page, request }) => {
  const { library } = await practiceLibrary(page, request);
  await page.getByRole("button", { name: "Start", exact: true }).first().click();
  await expect(page.getByText("Resume fixture question 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "← Practice" }).click();
  const response = await request.post("/api/libraries", {
    data: { name: "No session yet" },
  });
  expect(response.ok()).toBeTruthy();
  const otherLibrary = await response.json();
  await page.reload();
  const picker = page.getByLabel("Library", { exact: true });
  await picker.selectOption(otherLibrary.id);
  const resume = page.getByRole("button", { name: "Resume last session", exact: true });
  await expect(resume).toBeDisabled();
  await picker.selectOption(library.id);
  await expect(resume).toBeEnabled();

  await page.evaluate((id) => {
    localStorage.setItem(`lastPractice:${id}`, JSON.stringify("missing-set"));
  }, library.id);
  await page.reload();
  await expect(resume).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
