import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/** Create a separate library and select it through the same control users see. */
async function openLibrary(page: Page, request: APIRequestContext) {
  const response = await request.post("/api/libraries", {
    data: { name: `Navigation test ${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
  const library = await response.json();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Practice", exact: true })).toBeVisible();
  const picker = page.getByLabel("Library", { exact: true });
  if (await picker.count()) await picker.selectOption(library.id);
  return `/api/libraries/${library.id}`;
}

test("reading history reopens the matching material before a tutor reply", async ({ page, request }) => {
  const scope = await openLibrary(page, request);
  const response = await request.post(`${scope}/chats`, {
    data: {
      title: "Saved lesson discussion",
      readingPath: "topic/lesson.md",
      readingTitle: "1. Reader lesson",
    },
  });
  expect(response.ok()).toBeTruthy();
  const chat = await response.json();

  // Leave a different reading open before opening the saved lesson discussion.
  await page.getByRole("button", { name: "Materials", exact: true }).click();
  await page.getByRole("button", { name: "overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reader overview" })).toBeVisible();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Saved lesson discussion Read →" }).click();
  await expect(page.getByRole("heading", { name: "Reader lesson" })).toBeVisible();
  await expect(page).toHaveURL(/#\/materials\/topic%2Flesson\.md\/1$/);

  // Capture the payload without making a real provider request.
  await page.route(`**${scope}/chats/${chat.id}/messages`, (route) =>
    route.fulfill({ json: {} }),
  );
  await page.getByLabel("Message to the tutor").fill("Explain this reading.");
  const sent = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith(`/chats/${chat.id}/messages`),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const payload = (await sent).postDataJSON();
  expect(payload.material).toContain("This reading lives in a topic folder.");
  expect(payload.material).not.toContain("directly in the configured materials folder");

  // Return to the file read before, with the in-app button.
  await page.getByRole("button", { name: "↩ Back to overview" }).click();
  await expect(page.getByRole("heading", { name: "Reader overview" })).toBeVisible();
  await expect(page).toHaveURL(/#\/materials\/overview\.md\/1$/);
});

test("arrow keys outside Practice do not move the saved question", async ({ page, request }) => {
  const scope = await openLibrary(page, request);
  const content = [1, 2].map((number) =>
    `## Question ${number}\nNavigation question ${number}\n\n### Choices\nA. One\nB. Two\n\n### Answer\nA\n`,
  ).join("\n");
  const preview = await request.post(`${scope}/imports/preview`, {
    data: { files: [{ path: "navigation.md", content }] },
  });
  expect(preview.ok()).toBeTruthy();
  const imported = await request.post(`${scope}/imports/${(await preview.json()).id}/commit`, {
    data: { acceptWarnings: true },
  });
  expect(imported.ok()).toBeTruthy();
  // Refresh the overview after the API fixture import, then select this library again.
  await page.reload();
  const picker = page.getByLabel("Library", { exact: true });
  if (await picker.count()) await picker.selectOption(scope.split("/").at(-1)!);
  await page.getByRole("button", { name: "Start", exact: true }).first().click();
  await expect(page.getByText("Navigation question 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Notes", exact: true })).toBeVisible();
  await page.getByRole("heading", { name: "Notes", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect(page.getByText("Navigation question 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Question 1", exact: true })).toHaveAttribute("aria-current", "step");
});
