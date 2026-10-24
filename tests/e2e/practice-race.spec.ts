import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/** Time for the app to handle a released response before checking nothing changed. */
const SETTLE_MS = 300;

/** A library with a bank of `count` questions "<label> question N", imported through the API. */
async function libraryWithBank(
  request: APIRequestContext,
  label: string,
  count: number,
) {
  const created = await request.post("/api/libraries", {
    data: { name: `${label} ${Date.now()}` },
  });
  expect(created.ok()).toBeTruthy();
  const library = await created.json();
  const scope = `/api/libraries/${library.id}`;
  const content = Array.from({ length: count }, (_, k) =>
    `## Question ${k + 1}\n${label} question ${k + 1}\n\n### Choices\nA. One\nB. Two\n\n### Answer\nA\n`,
  ).join("\n");
  const preview = await request.post(`${scope}/imports/preview`, {
    data: { files: [{ path: `${label.toLowerCase()}.md`, content }] },
  });
  const commit = await request.post(
    `${scope}/imports/${(await preview.json()).id}/commit`,
    { data: { acceptWarnings: true } },
  );
  expect(commit.ok()).toBeTruthy();
  return { id: library.id as string, scope };
}

/** Open `libraryId` and Start its first deck; returns the set's question IDs. */
async function startDeck(page: Page, request: APIRequestContext, libraryId: string) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Practice", exact: true })).toBeVisible();
  const picker = page.getByLabel("Library", { exact: true });
  if (await picker.count()) await picker.selectOption(libraryId);
  await page.getByRole("button", { name: "Start", exact: true }).first().click();
  await expect(page.getByText("Race question 1", { exact: true })).toBeVisible();
  const setId = decodeURIComponent(page.url().split("#/practice/")[1]);
  const set = await (
    await request.get(`/api/libraries/${libraryId}/sets/${setId}`)
  ).json();
  return { setId, questionIds: set.questionIds as string[] };
}

/**
 * Hold the browser's GET for one question until `release()`: the response is fetched at
 * once (so it reflects the server at that moment) and delivered late.
 */
async function holdQuestion(page: Page, questionId: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let delivered!: () => void;
  const deliveredLate = new Promise<void>((resolve) => (delivered = resolve));
  await page.route(
    (url) => url.pathname.endsWith(`/questions/${questionId}`),
    async (route) => {
      const response = await route.fetch();
      await released;
      await route.fulfill({ response });
      delivered();
    },
  );
  const started = page.waitForRequest((sent) =>
    new URL(sent.url()).pathname.endsWith(`/questions/${questionId}`),
  );
  return { release, started, deliveredLate };
}

test("a late question response cannot replace a newer navigation", async ({ page, request }) => {
  const library = await libraryWithBank(request, "Race", 3);
  const { setId, questionIds } = await startDeck(page, request, library.id);
  const held = await holdQuestion(page, questionIds[1]);

  await page.getByRole("button", { name: "Question 2", exact: true }).click();
  await held.started;
  await page.getByRole("button", { name: "Question 3", exact: true }).click();
  await expect(page.getByText("Race question 3", { exact: true })).toBeVisible();
  held.release();
  await held.deliveredLate;
  await page.waitForTimeout(SETTLE_MS);

  // Text, strip, position, draft and the saved cursor all stay on question 3.
  await expect(page.getByText("Race question 3", { exact: true })).toBeVisible();
  await expect(page.getByText("Race question 2", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Question 3", exact: true }),
  ).toHaveAttribute("aria-current", "step");
  await expect(page.getByText("3 / 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "A One", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const set = await (await request.get(`${library.scope}/sets/${setId}`)).json();
  expect(set.cursor).toBe(2);
  // The controls are usable again.
  await expect(page.getByRole("button", { name: "← Previous", exact: true })).toBeEnabled();
});

test("a question still loading is dropped when another library opens", async ({ page, request }) => {
  const library = await libraryWithBank(request, "Race", 3);
  const other = await libraryWithBank(request, "Other", 1);
  const { questionIds } = await startDeck(page, request, library.id);
  const held = await holdQuestion(page, questionIds[1]);

  await page.getByRole("button", { name: "Question 2", exact: true }).click();
  await held.started;
  await page.getByLabel("Library", { exact: true }).selectOption(other.id);
  await expect(page.getByRole("heading", { name: "Practice", exact: true })).toBeVisible();
  held.release();
  await held.deliveredLate;
  await page.waitForTimeout(SETTLE_MS);

  await expect(page.getByText("Race question 2", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Practice", exact: true })).toBeVisible();
  await expect(page.getByLabel("Library", { exact: true })).toHaveValue(other.id);
  await expect(page.getByRole("button", { name: "Start", exact: true }).first()).toBeEnabled();
});

test("a failed question load leaves the controls usable", async ({ page, request }) => {
  const library = await libraryWithBank(request, "Race", 3);
  const { questionIds } = await startDeck(page, request, library.id);
  await page.route(
    (url) => url.pathname.endsWith(`/questions/${questionIds[1]}`),
    (route) => route.abort(),
  );
  await page.getByRole("button", { name: "Question 2", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  // Nothing half-applied: the shown question and its strip still agree.
  await expect(page.getByText("Race question 1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Question 1", exact: true }),
  ).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("button", { name: "Next →", exact: true })).toBeEnabled();
});
