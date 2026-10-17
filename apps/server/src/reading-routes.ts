import type { FastifyInstance } from "fastify";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { AppError } from "./store.js";

/** File types the reader serves, by extension. SVG is left out: it can carry scripts. */
const READABLE_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** Largest file the reader returns, in bytes (the biggest study file is about 4 MB). */
const MAX_READING_BYTES = 20_000_000;

/** Resolve a readable file under the reading root; traversal and symlinks are refused. */
async function readingPath(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  const target = resolve(base, path);
  const inside = relative(base, target);
  if (!inside || inside.startsWith("..") || resolve(base, inside) !== target)
    throw new AppError(
      400,
      "INVALID_PATH",
      "Path is outside the reading folder.",
    );
  if (!READABLE_TYPES[extname(target).toLowerCase()])
    throw new AppError(
      400,
      "INVALID_PATH",
      "Only Markdown files and images can be read.",
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

/**
 * Read-only access to a reference folder (READING_ROOT), such as converted study notes.
 * Nothing here writes: the folder is browsed and rendered, never imported or edited.
 *
 * GET /api/reading       -> { configured, files: ["Kaplan/notes.md", ...] } (Markdown only)
 * GET /api/reading/file  -> raw bytes of one Markdown file or image (?path=relative/path)
 */
export function registerReadingRoutes(
  app: FastifyInstance,
  root: string | undefined,
) {
  app.get("/api/reading", async () => {
    if (!root) return { configured: false, files: [] };
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
    return {
      configured: true,
      files: files.sort((a, b) => a.localeCompare(b)),
    };
  });
  app.get("/api/reading/file", async (request: any, reply) => {
    if (!root)
      throw new AppError(
        409,
        "ROOT_NOT_CONFIGURED",
        "Set READING_ROOT in the local .env file first.",
      );
    const target = await readingPath(root, String(request.query.path ?? ""));
    reply.type(READABLE_TYPES[extname(target).toLowerCase()]);
    return readFile(target);
  });
}
