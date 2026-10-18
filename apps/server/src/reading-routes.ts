import type { FastifyInstance } from "fastify";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { AppError } from "./store.js";

/** Image types served from the study folders, by extension. SVG can carry scripts, so
 * every file is sent with SANDBOX_POLICY: a script inside never runs, even when the image
 * is opened on its own (inside an <img> tag scripts never run anyway). */
export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
/** File types the reader serves: Markdown notes and their images. */
const READABLE_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ...IMAGE_TYPES,
};
const SANDBOX_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
/** Largest file the reader returns, in bytes (the biggest study file is about 4 MB). */
const MAX_READING_BYTES = 20_000_000;

/** Resolve a file of an allowed type under root; traversal and symlinks are refused. */
async function readingPath(
  root: string,
  path: string,
  types: Record<string, string> = READABLE_TYPES,
): Promise<string> {
  const base = await realpath(root);
  const target = resolve(base, path);
  const inside = relative(base, target);
  if (!inside || inside.startsWith("..") || resolve(base, inside) !== target)
    throw new AppError(400, "INVALID_PATH", "Path is outside the folder.");
  if (!types[extname(target).toLowerCase()])
    throw new AppError(
      400,
      "INVALID_PATH",
      types === READABLE_TYPES
        ? "Only Markdown files and images can be read."
        : "Only images can be read.",
    );
  let cursor = base;
  for (const part of inside.split("/")) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink())
      throw new AppError(400, "INVALID_PATH", "Symlinks are not followed.");
  }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.size > MAX_READING_BYTES)
    throw new AppError(400, "INVALID_FILE", "Not a readable file.");
  return target;
}

/** Every Markdown file under the reading root, as sorted relative paths. */
export async function listReadingFiles(root: string): Promise<string[]> {
  const base = await realpath(root);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".md"))
        files.push(relative(base, target));
    }
  };
  await visit(base);
  return files.sort((a, b) => a.localeCompare(b));
}

/** Most files one list_files call returns. */
const MAX_LISTED_FILES = 200;

/**
 * Files in the notes folder for the tutor, like ls/find: optional folder prefix and a
 * glob ("*" within a name, "**" across folders, "?" one character), with line counts.
 * Returns [{ path, lines }].
 */
export async function listReadingFilesWithSizes(
  root: string,
  folder = "",
  glob = "",
) {
  const pattern = glob
    ? new RegExp(
        "^" +
          glob
            .split("**")
            .map((part) =>
              part
                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, "[^/]*")
                .replace(/\?/g, "[^/]"),
            )
            .join(".*") +
          "$",
        "i",
      )
    : null;
  const prefix = folder.replace(/^\.?\/+|\/+$/g, "");
  const matches = (await listReadingFiles(root)).filter(
    (path) =>
      (!prefix || path.startsWith(`${prefix}/`)) &&
      (!pattern || pattern.test(path) || pattern.test(path.split("/").pop()!)),
  );
  return Promise.all(
    matches.slice(0, MAX_LISTED_FILES).map(async (path) => ({
      path,
      lines: (await readFile(await readingPath(root, path), "utf8")).split("\n")
        .length,
    })),
  );
}

/** Most search hits the tutor gets per query, and longest snippet per hit. */
const MAX_SEARCH_HITS = 20;
const SNIPPET_CHARACTERS = 240;
/** Most lines the tutor may read in one call. */
const MAX_READ_LINES = 200;

/**
 * Plain-text search of the study notes for the tutor (like grep, no index).
 * A line matches when it contains every word of the query, ignoring case.
 * Returns [{ path, line, section, text }]: line is 1-based, section is the nearest
 * heading above it, text is the trimmed line (cut to SNIPPET_CHARACTERS).
 */
export async function searchReading(root: string, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { path: string; line: number; section: string; text: string }[] =
    [];
  if (!words.length) return hits;
  for (const path of await listReadingFiles(root)) {
    const lines = (await readFile(await readingPath(root, path), "utf8")).split(
      "\n",
    );
    let section = "";
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (/^#{1,6}\s/.test(line)) section = line.replace(/^#+\s*/, "").trim();
      const lower = line.toLowerCase();
      if (words.every((word) => lower.includes(word))) {
        hits.push({
          path,
          line: index + 1,
          section,
          text: line.trim().slice(0, SNIPPET_CHARACTERS),
        });
        if (hits.length >= MAX_SEARCH_HITS) return hits;
      }
    }
  }
  return hits;
}

/** Lines fromLine.. (1-based, at most MAX_READ_LINES) of one study-notes file, numbered. */
export async function readReadingLines(
  root: string,
  path: string,
  fromLine: number,
  count: number,
) {
  const lines = (await readFile(await readingPath(root, path), "utf8")).split(
    "\n",
  );
  const start = Math.max(1, Math.floor(fromLine));
  const end = Math.min(
    lines.length,
    start + Math.min(MAX_READ_LINES, Math.max(1, Math.floor(count))) - 1,
  );
  return {
    path,
    fromLine: start,
    toLine: end,
    totalLines: lines.length,
    text: lines
      .slice(start - 1, end)
      .map((line, i) => `${start + i}: ${line}`)
      .join("\n"),
  };
}

/** Ripgrep output and run-time limits for one tutor call. */
const MAX_RG_OUTPUT = 20_000;
const RG_TIMEOUT_MS = 10_000;

/**
 * Run ripgrep in the notes folder for the tutor (Codex models know rg well).
 * No shell: arguments go straight to rg with the notes folder as the working directory.
 * Refused: options that run other programs (--pre*, -z/--search-zip decompressors),
 * config files, absolute paths and
 * "..", so rg only reads inside the folder. Output is cut to MAX_RG_OUTPUT characters.
 * Returns { output, truncated } or throws when rg is missing or an argument is refused.
 */
export async function runRipgrep(root: string, args: string[]) {
  for (const arg of args)
    if (
      typeof arg !== "string" ||
      /^--(pre|config|ignore-file|search-zip)/.test(arg) ||
      /^-[a-zA-Z]*z/.test(arg) ||
      arg.startsWith("/") ||
      arg.split(/[\\/=]/).includes("..")
    )
      throw new AppError(
        400,
        "INVALID_ARGUMENT",
        `Argument not allowed: ${arg}`,
      );
  const base = await realpath(root);
  return new Promise<{ output: string; truncated: boolean }>(
    (resolvePromise, reject) => {
      execFile(
        "rg",
        ["--no-config", "--no-follow", ...args],
        {
          cwd: base,
          timeout: RG_TIMEOUT_MS,
          maxBuffer: 10_000_000,
          env: { PATH: process.env.PATH ?? "" },
        },
        (error: any, stdout) => {
          // Exit code 1 means "no matches", which is a normal answer.
          if (error && error.code !== 1)
            return reject(
              new Error(
                error.code === "ENOENT"
                  ? "rg is not installed"
                  : String(error.message).slice(0, 300),
              ),
            );
          resolvePromise({
            output: stdout.slice(0, MAX_RG_OUTPUT),
            truncated: stdout.length > MAX_RG_OUTPUT,
          });
        },
      );
    },
  );
}

/**
 * Read-only access to a reference folder (READING_ROOT), such as converted study notes.
 * Nothing here writes: the folder is browsed and rendered, never imported or edited.
 *
 * GET /api/reading       -> { configured, files: ["Kaplan/notes.md", ...] } (Markdown only)
 * GET /api/reading/file  -> raw bytes of one Markdown file or image (?path=relative/path)
 * GET /api/material-root/file -> one image from the question-bank folder (material-routes)
 */
export function registerReadingRoutes(
  app: FastifyInstance,
  root: string | undefined,
) {
  app.get("/api/reading", async () => {
    if (!root) return { configured: false, files: [] };
    return { configured: true, files: await listReadingFiles(root) };
  });
  app.get("/api/reading/file", async (request: any, reply) => {
    if (!root)
      throw new AppError(
        409,
        "ROOT_NOT_CONFIGURED",
        "Set READING_ROOT in the local .env file first.",
      );
    return sendStudyFile(request, reply, root, READABLE_TYPES);
  });
}

/**
 * Send one file of an allowed type from root (?path=relative/path). Size and modification
 * time identify a version: an unchanged file is answered with 304 Not Modified, so
 * reopening a 4 MB note does not resend it.
 */
export async function sendStudyFile(
  request: any,
  reply: any,
  root: string,
  types: Record<string, string>,
) {
  const target = await readingPath(
    root,
    String(request.query.path ?? ""),
    types,
  );
  const { size, mtimeMs } = await lstat(target);
  const etag = `W/"${size}-${Math.floor(mtimeMs)}"`;
  reply
    .header("etag", etag)
    .header("cache-control", "no-cache")
    .header("content-security-policy", SANDBOX_POLICY);
  if (request.headers["if-none-match"] === etag) return reply.code(304).send();
  reply.type(types[extname(target).toLowerCase()]);
  return readFile(target);
}
