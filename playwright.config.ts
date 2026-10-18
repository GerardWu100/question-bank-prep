import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 3100;
const TEST_ORIGIN = `http://127.0.0.1:${TEST_PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: TEST_ORIGIN, trace: "retain-on-failure" },
  webServer: [
    {
      command: "npm run dev",
      url: `${TEST_ORIGIN}/api/session`,
      // A developer's running app must never receive fixture imports or answers.
      reuseExistingServer: false,
      env: {
        STUDY_HOST: "127.0.0.1",
        STUDY_PORT: String(TEST_PORT),
        STUDY_DATA_DIR: mkdtempSync(join(tmpdir(), "question-bank-prep-e2e-")),
        STUDY_PASSWORD: "",
        MATERIAL_ROOT: "",
        READING_ROOT: new URL("./tests/fixtures/reading", import.meta.url).pathname,
        TRUST_PROXY: "false",
      },
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
