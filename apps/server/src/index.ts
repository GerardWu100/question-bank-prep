import { registerMaterialRoutes } from "./material-routes.js";
import { registerReadingRoutes } from "./reading-routes.js";
import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import staticFiles from "@fastify/static";
import { buildApp, LOOPBACK_HOSTS } from "./app.js";
import { AppError } from "./store.js";
import { SubscriptionProvider } from "../../ai-runtime/index.js";
import { calculate } from "../../calculator/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: resolve(root, ".env"), quiet: true });
const dataDirectory = resolve(root, process.env.STUDY_DATA_DIR || "app-data");
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
  provider: new SubscriptionProvider(),
  calculator: calculate,
});
registerMaterialRoutes(
  app,
  store,
  process.env.MATERIAL_ROOT
    ? resolve(root, process.env.MATERIAL_ROOT)
    : undefined,
  dataDirectory,
);
registerReadingRoutes(
  app,
  process.env.READING_ROOT
    ? resolve(root, process.env.READING_ROOT)
    : undefined,
);
const webDirectory = resolve(root, "apps/web/dist");
if (existsSync(webDirectory)) {
  await app.register(staticFiles, { root: webDirectory });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/")
      ? reply.send(new AppError(404, "NOT_FOUND", "Route not found."))
      : reply.sendFile("index.html"),
  );
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void app.close());
await app.listen({ host, port });
