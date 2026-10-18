// Prepare apps/desktop/build for Electron: the server bundled into one ES module, the
// calculator worker beside it (the server loads ./worker.mjs from its own folder), and the
// web build. Run `npm run build` first. better-sqlite3 (native) and pyodide (WebAssembly
// files) stay external: the desktop package installs them, rebuilt for Electron.
import { build } from "esbuild";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "apps/desktop/build");
const webBuild = join(root, "apps/web/dist");
if (!existsSync(join(webBuild, "index.html")))
  throw new Error("No web build: run `npm run build` first.");

rmSync(output, { recursive: true, force: true });
await build({
  entryPoints: [join(root, "apps/server/src/index.ts")],
  outfile: join(output, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3", "pyodide"],
  // CommonJS dependencies inside an ES module bundle still call require() and use __dirname.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __pathDirname } from "node:path";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  logLevel: "warning",
});
cpSync(join(root, "apps/calculator/worker.mjs"), join(output, "worker.mjs"));
cpSync(webBuild, join(output, "web"), { recursive: true });
console.log(`Desktop build ready in ${output}`);
