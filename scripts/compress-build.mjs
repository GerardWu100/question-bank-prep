// Write Brotli (.br) and gzip (.gz) copies of the web build's text files, so the server
// sends compressed bytes without compressing on each request (@fastify/static preCompressed).
// Input: apps/web/dist after `vite build`. Output: <file>.br and <file>.gz next to each file.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const distDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/web/dist",
);
/** Text formats worth compressing; fonts (woff2) and images are already compressed. */
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".html",
  ".svg",
  ".json",
  ".txt",
]);
/** Files smaller than this many bytes are sent as they are. */
const MIN_COMPRESS_BYTES = 1024;

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}

let before = 0,
  after = 0;
for await (const path of files(distDirectory)) {
  if (!COMPRESSIBLE_EXTENSIONS.has(extname(path))) continue;
  const bytes = await readFile(path);
  if (bytes.length < MIN_COMPRESS_BYTES) continue;
  const brotli = brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
  await writeFile(`${path}.br`, brotli);
  await writeFile(`${path}.gz`, gzipSync(bytes, { level: 9 }));
  before += bytes.length;
  after += brotli.length;
}
console.log(
  `Compressed web build: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB (Brotli).`,
);
