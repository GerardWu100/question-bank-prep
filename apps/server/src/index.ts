import { registerMaterialRoutes } from "./material-routes.js";
import { registerReadingRoutes } from "./reading-routes.js";
import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import staticFiles from "@fastify/static";
import { buildApp, LOOPBACK_HOSTS } from "./app.js";
import { ensureWritableDataDirectory } from "./data-directory.js";
import { AppError } from "./store.js";
import { defaultCodexAuthFile } from "../../ai-runtime/index.js";
import { AISettingsFile, ConfigurableProvider } from "../../ai-runtime/api-key.js";
import { ModelUsageLimit } from "../../ai-runtime/usage-limit.js";
import { calculate } from "../../calculator/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: resolve(root, ".env"), quiet: true });
const dataDirectory = resolve(root, process.env.STUDY_DATA_DIR || "app-data");
// Fail at startup with the folder and the fix named, not later inside SQLite.
ensureWritableDataDirectory(dataDirectory);
/** A folder setting, resolved from the project root; unset or missing means "not configured". */
const optionalFolder = (name: "MATERIAL_ROOT" | "READING_ROOT") => {
  const value = process.env[name];
  if (!value) return undefined;
  const folder = resolve(root, value);
  if (existsSync(folder)) return folder;
  console.warn(`${name} folder ${folder} does not exist; that feature is off.`);
  return undefined;
};
const materialRoot = optionalFolder("MATERIAL_ROOT");
const readingRoot = optionalFolder("READING_ROOT");
/** A whole-number cap from the environment; 0 turns that cap off. */
const usageCap = (name: "AI_MAX_REQUESTS_PER_HOUR" | "AI_MAX_REQUESTS_PER_DAY", fallback: number) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid ${name}: use a whole number, 0 for no cap.`);
  return value;
};
const usageLimit = new ModelUsageLimit(
  { perHour: usageCap("AI_MAX_REQUESTS_PER_HOUR", 30), perDay: usageCap("AI_MAX_REQUESTS_PER_DAY", 150) },
  resolve(dataDirectory, "ai-usage.json"),
);
const host = process.env.STUDY_HOST || "127.0.0.1";
const port = Number(process.env.STUDY_PORT || "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid STUDY_PORT.");
if (!LOOPBACK_HOSTS.includes(host) && !process.env.STUDY_PASSWORD)
  throw new Error("Set STUDY_PASSWORD before binding beyond loopback.");
const { app, store } = await buildApp({
  databasePath: resolve(dataDirectory, "study.sqlite"),
  password: process.env.STUDY_PASSWORD,
  logger: true,
  // Settings → AI provider lists the connections (ChatGPT sign-in, API keys) in fallback
  // order; the list lives in the data folder. CODEX_AUTH_FILE names the ChatGPT sign-in.
  provider: new ConfigurableProvider(
    new AISettingsFile(resolve(dataDirectory, "ai-settings.json")),
    defaultCodexAuthFile(),
    usageLimit,
  ),
  calculator: calculate,
  readingRoot,
  trustProxy: process.env.TRUST_PROXY === "true",
});
registerMaterialRoutes(app, store, materialRoot, dataDirectory);
registerReadingRoutes(app, readingRoot);
// STUDY_WEB_DIR lets a packaged build (the desktop app) serve the web build from elsewhere.
const webDirectory = resolve(root, process.env.STUDY_WEB_DIR || "apps/web/dist");
if (existsSync(webDirectory)) {
  await app.register(staticFiles, {
    root: webDirectory,
    // Serve the .br/.gz copies written by scripts/compress-build.mjs when the browser accepts them.
    preCompressed: true,
    // Build files under /assets/ have content hashes in their names, so they never change:
    // the browser keeps them for a year. Everything else (index.html) is revalidated.
    setHeaders: (response, path) =>
      response.header(
        "cache-control",
        path.includes("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      ),
  });
  // A missing build file is a 404, not the page: an old tab then fails clearly.
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/") || request.url.startsWith("/assets/")
      ? reply.send(new AppError(404, "NOT_FOUND", "Route not found."))
      : reply.sendFile("index.html"),
  );
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void app.close());
// Keep this the module's last top-level await: the desktop wrapper (apps/desktop/main.cjs)
// imports this module and treats a settled import as "listening", a rejection as a failed bind.
await app.listen({ host, port });
