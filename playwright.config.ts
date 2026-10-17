import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  webServer: [
    {
      command: "npm run dev",
      url: "http://127.0.0.1:3000/api/session",
      reuseExistingServer: !process.env.CI,
      env: { STUDY_DATA_DIR: `/tmp/question-bank-prep-e2e-${Date.now()}` },
    },
    {
      command: "npm run dev:web",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
