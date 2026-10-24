import { test, expect } from "@playwright/test";

/** Where the test server really listens (playwright.config.ts). */
const LOCAL_ORIGIN = "http://127.0.0.1:3100";
/**
 * A plain-HTTP, non-loopback origin, like a home server reached by name. Browsers do not
 * treat it as a secure context, so crypto.randomUUID is missing there.
 */
const REMOTE_ORIGIN = "http://qbp-audit.test:3100";
/** RFC 4122 version 4: version nibble 4, variant bits 10xx (8, 9, a or b). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const material =
  "# Chapter 1\n\n## Question 1\nRemote origin question\n\n### Choices\nA. Three\nB. Four\n\n### Answer\nB\n\n### Solution\nTwo pairs make four.\n";

test("practice, notes and AI connections work over plain HTTP at a remote host name", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/libraries", {
    data: { name: `Remote origin test ${Date.now()}` },
  });
  expect(created.ok()).toBeTruthy();
  const library = await created.json();
  const scope = `/api/libraries/${library.id}`;
  const preview = await request.post(`${scope}/imports/preview`, {
    data: { files: [{ path: "remote/drills.md", content: material }] },
  });
  const commit = await request.post(
    `${scope}/imports/${(await preview.json()).id}/commit`,
    { data: { acceptWarnings: true } },
  );
  expect(commit.ok()).toBeTruthy();

  // The browser stays on the remote origin; only the transport goes to the local server,
  // which (in password-free test mode) accepts loopback names only.
  await page.route(`${REMOTE_ORIGIN}/**`, async (route) => {
    const original = route.request();
    const headers = { ...original.headers() };
    delete headers.host;
    if (headers.origin) headers.origin = LOCAL_ORIGIN;
    if (headers.referer)
      headers.referer = headers.referer.replace(REMOTE_ORIGIN, LOCAL_ORIGIN);
    const response = await route.fetch({
      url: original.url().replace(REMOTE_ORIGIN, LOCAL_ORIGIN),
      headers,
    });
    await route.fulfill({ response });
  });
  // Every write's operationId and the new connection's ID, as the browser sent them.
  const sentIds: string[] = [];
  const failedWrites: string[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "GET" || !sent.url().startsWith(`${REMOTE_ORIGIN}/api/`))
      return;
    const body = sent.postDataJSON?.() ?? {};
    if (body.operationId) sentIds.push(body.operationId);
    // The added connection is last; the default ChatGPT entry keeps its saved ID.
    if (body.connections) sentIds.push(body.connections.at(-1).id);
  });
  page.on("response", (response) => {
    if (response.request().method() !== "GET" && !response.ok())
      failedWrites.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(`${REMOTE_ORIGIN}/`);
  expect(
    await page.evaluate(() => ({
      secure: window.isSecureContext,
      nativeUUID: typeof crypto.randomUUID,
    })),
  ).toEqual({ secure: false, nativeUUID: "undefined" });
  const picker = page.getByLabel("Library", { exact: true });
  if (await picker.count()) await picker.selectOption(library.id);

  // Start practice (creates a set and moves its cursor), answer and flag.
  await page.getByRole("button", { name: "Start", exact: true }).first().click();
  await expect(page.getByText("Remote origin question")).toBeVisible();
  await page.getByRole("button", { name: "B Four", exact: true }).click();
  await page.getByRole("button", { name: "Submit answer" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "☆ Flag", exact: true }).click();
  await expect(page.getByRole("button", { name: "★ Flagged" })).toBeVisible();

  // Save a note.
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByLabel("Title").fill("Remote note");
  await page.getByLabel("Note (Markdown)").fill("Written over plain HTTP.");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByText("Remote note")).toBeVisible();

  // Add an AI connection; a local endpoint keeps the check offline.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "+ API key" }).click();
  await page.getByLabel("Base URL").last().fill("http://localhost:11434/v1");
  await page
    .getByLabel("Models (one ID per line, first = backup model)")
    .last()
    .fill("local-test-model");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(failedWrites).toEqual([]);
  expect(sentIds.length).toBeGreaterThanOrEqual(5);
  for (const sentId of sentIds) expect(sentId).toMatch(UUID_V4);
  expect(new Set(sentIds).size).toBe(sentIds.length);
  const overview = await (await request.get(`${scope}/overview`)).json();
  expect(overview.sets).toHaveLength(1);
  expect(overview.counts.correct).toBe(1);
});
