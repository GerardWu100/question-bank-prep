import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/libraries", {
    data: { name: `Reader test ${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
});

test("opens readings at the root and inside a topic folder", async ({ page }) => {
  await page.goto("/#/materials");
  await page.getByRole("button", { name: "overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Reader overview" }),
  ).toBeVisible();
  await page.getByText("topic", { exact: true }).click();
  await page.getByRole("button", { name: "lesson", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Reader lesson" })).toBeVisible();
});

for (const savedSection of [99, -1, "invalid"]) {
  test(`restores a readable section when the saved index is ${savedSection}`, async ({
    page,
  }) => {
    // A formerly valid bookmark can exceed the file length after the material is edited.
    await page.addInitScript((section) => {
      localStorage.setItem(
        "reading",
        JSON.stringify({ path: "topic/lesson.md", section }),
      );
    }, savedSection);
    await page.goto("/#/materials");
    await expect(
      page.getByRole("heading", { name: "Reader lesson" }),
    ).toBeVisible();
    await expect(page.getByLabel("Section", { exact: true })).toHaveValue("0");
    await expect(
      page.getByRole("button", { name: "← Previous", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Next section →", exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem("reading")!)),
    ).toEqual({
      path: "topic/lesson.md",
      section: 0,
    });
  });
}
