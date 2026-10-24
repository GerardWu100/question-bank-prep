import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWritableDataDirectory } from "../apps/server/src/data-directory.js";

/** Owner may read and enter, nobody may write: like a root-owned folder seen by the app's user. */
const READ_ONLY_FOLDER_MODE = 0o555;
const OWNER_FULL_ACCESS_MODE = 0o755;
// Root ignores permission bits, and Windows does not map them to folder access.
const permissionBitsApply = process.platform !== "win32" && process.getuid?.() !== 0;

let scratch = "";
afterEach(() => {
  if (!scratch) return;
  chmodSync(scratch, OWNER_FULL_ACCESS_MODE);
  rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

describe("data folder check at startup", () => {
  it("creates a missing folder and accepts it", () => {
    scratch = mkdtempSync(join(tmpdir(), "qbp-data-"));
    const directory = join(scratch, "nested", "data");
    ensureWritableDataDirectory(directory);
    expect(existsSync(directory)).toBe(true);
  });

  it.runIf(permissionBitsApply)("names the folder and the fix when it is not writable", () => {
    scratch = mkdtempSync(join(tmpdir(), "qbp-data-"));
    chmodSync(scratch, READ_ONLY_FOLDER_MODE);
    expect(() => ensureWritableDataDirectory(scratch)).toThrow(
      new RegExp(`data folder ${scratch} is not writable by user \\d+:\\d+ \\(EACCES\\).*chown`),
    );
  });

  it("fails clearly when the path is a file", () => {
    scratch = mkdtempSync(join(tmpdir(), "qbp-data-"));
    const file = join(scratch, "data");
    writeFileSync(file, "");
    expect(() => ensureWritableDataDirectory(file)).toThrow(/data folder .* is not writable/);
  });
});
