import { randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  hash,
  MAX_MATERIAL_BYTES,
  validateMaterialFile,
} from "../../../packages/domain/src/index.js";
import { AppError } from "./store.js";

const locks = new Set<string>();

/** Resolve an existing Markdown file beneath an explicitly configured root; symlinks are rejected. */
export async function materialPath(
  root: string,
  path: string,
): Promise<string> {
  const invalid = validateMaterialFile(path, "");
  if (invalid) throw new AppError(400, "INVALID_PATH", invalid);
  const base = await realpath(root);
  const target = resolve(base, path);
  if (relative(base, target).startsWith(".."))
    throw new AppError(400, "INVALID_PATH", "Material path escapes root.");
  let cursor = base;
  for (const part of relative(base, target).split("/")) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink())
      throw new AppError(
        400,
        "INVALID_PATH",
        "Material symlinks are not supported.",
      );
  }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.size > MAX_MATERIAL_BYTES)
    throw new AppError(
      400,
      "INVALID_FILE",
      "Material must be a regular file under 5 MB.",
    );
  return target;
}

/** Read a deterministic snapshot without moving or changing the user's source files. */
export async function scanRoot(
  root: string,
): Promise<{ path: string; content: string; type: string; local: true }[]> {
  const files: { path: string; content: string; type: string; local: true }[] =
    [];
  async function visit(directory: string): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const path = relative(root, target);
        const safe = await materialPath(root, path);
        files.push({
          path,
          content: await readFile(safe, "utf8"),
          type: "questions",
          local: true,
        });
      }
    }
  }
  // A folder that cannot be read is an error, never an empty folder: an empty scan
  // removes every local file from the library.
  try {
    await visit(root);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      409,
      "ROOT_UNAVAILABLE",
      "The configured material folder could not be read.",
    );
  }
  return files;
}

/** Atomically replace source bytes after a hash check; retain a durable recovery journal.
 * The application lock serializes its writes. External editors can still race the final rename.
 * Call acknowledgeMaterialSave only after the database import commits.
 */
export async function safeSave(
  root: string,
  path: string,
  expectedHash: string,
  content: string,
  journalRoot: string,
): Promise<string> {
  if (Buffer.byteLength(content) > MAX_MATERIAL_BYTES)
    throw new AppError(400, "INVALID_FILE", "Material exceeds 5 MB.");
  const target = await materialPath(root, path);
  if (locks.has(target))
    throw new AppError(409, "SAVE_RUNNING", "Material save already running.");
  locks.add(target);
  const journalId = randomUUID(),
    journal = join(journalRoot, `${journalId}.json`),
    temporary = join(dirname(target), `.study-${journalId}.tmp`);
  try {
    const original = await readFile(target, "utf8");
    if (hash(original) !== expectedHash)
      throw new AppError(409, "HASH_CONFLICT", "External material changed.");
    await mkdir(journalRoot, { recursive: true });
    await writeFile(
      journal,
      JSON.stringify({
        path,
        expectedHash,
        newHash: hash(content),
        original,
        content,
        status: "prepared",
      }),
      { flag: "wx", mode: 0o600 },
    );
    const handle = await open(temporary, "wx", (await lstat(target)).mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (hash(await readFile(target, "utf8")) !== expectedHash)
      throw new AppError(
        409,
        "HASH_CONFLICT",
        "External material changed during save.",
      );
    await rename(temporary, target);
    return journalId;
  } finally {
    locks.delete(target);
    await unlink(temporary).catch(() => {});
  }
}
export async function acknowledgeMaterialSave(
  journalRoot: string,
  journalId: string,
): Promise<void> {
  await unlink(join(journalRoot, `${journalId}.json`));
}

/** Inspect interrupted writes so startup can reimport changed bytes or report an external conflict. */
export async function pendingMaterialSaves(root: string, journalRoot: string) {
  await mkdir(journalRoot, { recursive: true });
  const pending = [];
  for (const name of await readdir(journalRoot)) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(await readFile(join(journalRoot, name), "utf8"));
    const current = hash(
      await readFile(await materialPath(root, record.path), "utf8"),
    );
    pending.push({
      ...record,
      id: name.slice(0, -5),
      state:
        current === record.newHash
          ? "reimport"
          : current === record.expectedHash
            ? "unchanged"
            : "conflict",
    });
  }
  return pending;
}
