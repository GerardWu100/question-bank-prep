import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const playwrightCLI = createRequire(import.meta.url).resolve("@playwright/test/cli");
const requestedTests = process.argv.slice(2);
// Each file gets a new server and database, so accumulated browser traffic does
// not exhaust the production request limit. Explicit arguments run a focused selection.
const testGroups = requestedTests.length
  ? [requestedTests]
  : readdirSync(resolve(projectRoot, "tests/e2e"))
      .filter((name) => name.endsWith(".spec.ts"))
      .sort()
      .map((name) => [`tests/e2e/${name}`]);

for (const tests of testGroups) {
  const result = spawnSync(process.execPath, [playwrightCLI, "test", ...tests], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
