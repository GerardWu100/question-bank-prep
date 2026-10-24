import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/** Create a separate library and select it through the same control users see. */
async function openLibrary(page: Page, request: APIRequestContext) {
  const response = await request.post("/api/libraries", {
    data: { name: `Note continuation test ${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
  const library = await response.json();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Practice", exact: true })).toBeVisible();
  const picker = page.getByLabel("Library", { exact: true });
  if (await picker.count()) await picker.selectOption(library.id);
  return `/api/libraries/${library.id}`;
}

/**
 * A real reading chat plus one saved AI note pointing at it. Only the Notes list is
 * served by the test: saving a real AI note needs a completed model reply, and no
 * model is called here.
 */
async function savedReadingNote(
  page: Page,
  request: APIRequestContext,
  scope: string,
  reading: { readingPath: string; readingTitle: string },
) {
  const response = await request.post(`${scope}/chats`, {
    data: { title: "Lesson discussion", ...reading },
  });
  expect(response.ok()).toBeTruthy();
  const chat = await response.json();
  await page.route(
    (url) => url.pathname === `${scope}/notes`,
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: {
              notes: [
                {
                  id: "saved-ai-note",
                  title: "Lesson AI note",
                  content: "A saved tutor reply.",
                  provenance: "ai",
                  chatId: chat.id,
                  version: 1,
                },
              ],
            },
          })
        : route.continue(),
  );
  return chat;
}

/** Browse overview.md, then continue the saved AI note from Notes. */
async function continueFromNotes(page: Page) {
  await page.getByRole("button", { name: "Materials", exact: true }).click();
  await page.getByRole("button", { name: "overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reader overview" })).toBeVisible();
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: "AI notes · 1" }).click();
  await page.getByText("Lesson AI note").click();
  await page.getByRole("button", { name: "Continue this chat" }).click();
}

test("continuing a saved AI note sends its own reading, not the open one", async ({
  page,
  request,
}) => {
  const scope = await openLibrary(page, request);
  const chat = await savedReadingNote(page, request, scope, {
    readingPath: "topic/lesson.md",
    readingTitle: "1. Reader lesson",
  });
  await continueFromNotes(page);
  await expect(page.getByRole("heading", { name: "Reader lesson" })).toBeVisible();
  await expect(page).toHaveURL(/#\/materials\/topic%2Flesson\.md\/1$/);

  // Capture the payload without making a real provider request.
  await page.route(`**${scope}/chats/${chat.id}/messages`, (route) =>
    route.fulfill({ json: {} }),
  );
  await page.getByLabel("Message to the tutor").fill("Go on.");
  const sent = page.waitForRequest(
    (sentRequest) =>
      sentRequest.method() === "POST" && sentRequest.url().endsWith("/messages"),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const message = await sent;
  expect(message.url()).toContain(`/chats/${chat.id}/messages`);
  const payload = message.postDataJSON();
  expect(payload.material).toContain("This reading lives in a topic folder.");
  expect(payload.material).not.toContain("directly in the configured materials folder");
});

test("a saved AI note whose reading is gone shows that and sends nothing", async ({
  page,
  request,
}) => {
  const scope = await openLibrary(page, request);
  await savedReadingNote(page, request, scope, {
    readingPath: "topic/removed.md",
    readingTitle: "1. Removed lesson",
  });
  const sentMessages: string[] = [];
  page.on("request", (sentRequest) => {
    if (sentRequest.method() === "POST" && sentRequest.url().endsWith("/messages"))
      sentMessages.push(sentRequest.url());
  });
  await continueFromNotes(page);
  await expect(page.getByRole("heading", { name: "Notes", exact: true })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("topic/removed.md");
  await page.getByLabel("Message to the tutor").fill("Go on.");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await page.getByLabel("Message to the tutor").press("Enter");
  await expect(page.getByRole("alert")).toContainText("Open \"1. Removed lesson\"");
  expect(sentMessages).toEqual([]);
});
