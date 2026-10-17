import Database from "better-sqlite3";
import { hash } from "../packages/domain/src/index.js";
import {
  readFile,
  writeFile,
  mkdir,
  access,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Validate a study database before a snapshot can be activated. */
export function validateDatabase(path: string): void {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (database.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error("Database integrity check failed.");
    if ((database.pragma("foreign_key_check") as unknown[]).length)
      throw new Error("Database contains broken references.");
    const version = database
      .prepare("SELECT MAX(version) AS version FROM schema_version")
      .get() as { version: number };
    if (version.version !== 1) throw new Error("Unsupported database version.");
  } finally {
    database.close();
  }
}

/** Capture a coherent online snapshot, including source revisions and study records. */
export async function backupDatabase(
  source: string,
  destination: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await access(destination);
    throw new Error("Backup destination already exists. Choose a new name.");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  const database = new Database(source, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await database.backup(destination);
  } finally {
    database.close();
  }
  validateDatabase(destination);
  await writeFile(
    `${destination}.manifest.json`,
    JSON.stringify(
      {
        format: 1,
        sha256: hash(await readFile(destination)),
        created: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
}

/** Restore only to a new path, so a running database or local work cannot be overwritten. */
export async function restoreDatabase(
  source: string,
  destination: string,
): Promise<void> {
  const manifest = JSON.parse(
    await readFile(`${source}.manifest.json`, "utf8"),
  );
  const bytes = await readFile(source);
  if (manifest.format !== 1 || manifest.sha256 !== hash(bytes))
    throw new Error("Backup checksum mismatch.");
  validateDatabase(source);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  try {
    validateDatabase(destination);
  } catch (error) {
    await rm(destination);
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, source, destination] = process.argv.slice(2);
  if (!source || !destination || !["backup", "restore"].includes(command))
    throw new Error(
      "Usage: npm run backup -- backup|restore <source.sqlite> <destination.sqlite> (paths relative to project root)",
    );
  await (command === "backup" ? backupDatabase : restoreDatabase)(
    resolve(projectRoot, source),
    resolve(projectRoot, destination),
  );
  console.log(`${command} verified.`);
}
