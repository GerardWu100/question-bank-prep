import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const bankWith = (stem: string, choice: string) =>
  `## Question 1\n${stem}\n\n### Choices\nA. ${choice}\nB. Something else\n\n### Answer\nA\n`;

/** Import `content` as deck/bank.md, replacing the file's earlier contents without a mapping. */
async function importBank(request: APIRequestContext, scope: string, content: string) {
  const preview = await request.post(`${scope}/imports/preview`, {
    data: { files: [{ path: "deck/bank.md", content }] },
  });
  expect(preview.ok()).toBeTruthy();
  const commit = await request.post(
    `${scope}/imports/${(await preview.json()).id}/commit`,
    { data: { acceptWarnings: true } },
  );
  expect(commit.ok()).toBeTruthy();
}

/** Reload so the overview is fresh, select the library, and press the first Start. */
async function startFirstDeck(page: Page, libraryId: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Practice", exact: true })).toBeVisible();
  const picker = page.getByLabel("Library", { exact: true });
  if (await picker.count()) await picker.selectOption(libraryId);
  await page.getByRole("button", { name: "Start", exact: true }).first().click();
}

test("Start opens the current questions after a same-size bank replacement", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/libraries", {
    data: { name: `Deck reuse test ${Date.now()}` },
  });
  const library = await created.json();
  const scope = `/api/libraries/${library.id}`;
  await importBank(request, scope, bankWith("Original deck question", "Old choice"));
  await startFirstDeck(page, library.id);
  await expect(page.getByText("Original deck question")).toBeVisible();
  const originalSetURL = page.url();

  // Unchanged membership: Start reopens the same set.
  await startFirstDeck(page, library.id);
  await expect(page.getByText("Original deck question")).toBeVisible();
  expect(page.url()).toBe(originalSetURL);

  // A materially different question, same count, no identity mapping.
  await importBank(request, scope, bankWith("Replacement deck question", "New choice"));
  await startFirstDeck(page, library.id);
  await expect(page.getByText("Replacement deck question")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Source removed" })).toHaveCount(0);
  expect(page.url()).not.toBe(originalSetURL);

  // The earlier set stays as history, with its removed question.
  await page.goto(originalSetURL);
  await expect(page.getByRole("heading", { name: "Source removed" })).toBeVisible();
  const overview = await (await request.get(`${scope}/overview`)).json();
  expect(overview.sets).toHaveLength(2);
});
