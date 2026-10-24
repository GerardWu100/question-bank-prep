import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { AppError, Store } from "./store.js";
import { hash } from "../../../packages/domain/src/index.js";
import { IMAGE_TYPES, sendStudyFile } from "./reading-routes.js";
import {
  scanRoot,
  safeSave,
  acknowledgeMaterialSave,
  pendingMaterialSaves,
} from "./material-files.js";

/** Add configured-folder operations. Clients cannot choose arbitrary host roots. */
export function registerMaterialRoutes(
  app: FastifyInstance,
  store: Store,
  root: string | undefined,
  dataDirectory: string,
) {
  const journalRoot = join(dataDirectory, "material-journal");
  const requireRoot = () => {
    if (!root)
      throw new AppError(
        409,
        "ROOT_NOT_CONFIGURED",
        "Set MATERIAL_ROOT in the local .env file first.",
      );
    return root;
  };
  const base = "/api/libraries/:libraryId";
  /**
   * Deactivate local files no longer in the folder and mark folder files local. Uploaded
   * files elsewhere stay as they are. `folderHashes` maps each folder path to its hash.
   */
  const followFolderFiles = (lib: string, folderHashes: Map<string, string>) => {
    // Summaries decide; only a file that changes is read in full and written back.
    for (const file of store.list(lib, "file", ["content"]))
      if (file.local && file.active && !folderHashes.has(file.path))
        store.deactivateFile(lib, store.get(lib, file.id, "file"));
      else if (folderHashes.has(file.path) && !file.local)
        store.put(lib, "file", {
          ...store.get(lib, file.id, "file"),
          local: true,
        });
  };
  /** Commit a configured-folder preview and deactivate local files no longer in the folder. */
  const commitRootPreview = (
    lib: string,
    preview: any,
    previewHashes: Map<string, string>,
    acceptWarnings: boolean,
    identityMappings?: Record<string, string | null>,
  ) =>
    store.db.transaction(() => {
      const result = store.commit(
        lib,
        preview.id,
        acceptWarnings,
        identityMappings,
      );
      followFolderFiles(lib, previewHashes);
      return result;
    })();
  app.get("/api/material-root", async () => ({ configured: Boolean(root) }));
  // Images that bank files link to (for example assets/chart.svg), read-only.
  app.get("/api/material-root/file", async (request: any, reply) =>
    sendStudyFile(request, reply, requireRoot(), IMAGE_TYPES),
  );
  // Keep the library in step with the configured folder, so no manual import is needed.
  // Unmatched re-import identities become new questions, as in an unanswered preview.
  app.post(base + "/imports/root-sync", async (request: any) => {
    const lib = request.params.libraryId;
    store.syncPathLabels(lib);
    const files = await scanRoot(requireRoot());
    const fileHashes = new Map(files.map((f) => [f.path, hash(f.content)]));
    const activeLocal = store
      .list(lib, "file", ["content"])
      .filter((f: any) => f.local && f.active);
    if (
      activeLocal.length === files.length &&
      activeLocal.every((f: any) => fileHashes.get(f.path) === f.hash)
    )
      return { changed: false, issues: [] };
    // A folder scanned as empty is a removal, not an import: a preview needs at least
    // one file, so deactivate the local files here, as a commit generation of its own.
    if (!files.length)
      return store.db.transaction(() => {
        followFolderFiles(lib, fileHashes);
        store.bumpGeneration(lib);
        return {
          changed: true,
          issues: [],
          importRevision: store.library(lib).generation,
          questions: store.activeQuestionCount(lib),
        };
      })();
    const preview = store.preview(lib, files, { localRoot: true });
    if (!preview.canCommit) return { changed: false, issues: preview.issues };
    const result = commitRootPreview(lib, preview, fileHashes, true);
    return { changed: true, issues: preview.issues, ...result };
  });
  app.post(base + "/imports/root-preview", async (request: any) => {
    const files = await scanRoot(requireRoot());
    const preview = store.preview(request.params.libraryId, files, {
      localRoot: true,
    });
    return {
      ...preview,
      files: preview.files.map(({ content, questions, ...file }: any) => file),
    };
  });
  app.post(base + "/imports/:id/root-commit", async (request: any) => {
    const lib = request.params.libraryId,
      preview = store.get(lib, request.params.id, "import");
    if (preview.committed) return preview.committed;
    if (!preview.localRoot)
      throw new AppError(
        400,
        "INVALID_PREVIEW",
        "Expected a configured-folder preview.",
      );
    // One rescan covers both changed bytes and added or removed files.
    const previewHashes = new Map<string, string>(
      preview.files.map((p: any) => [p.path, p.hash]),
    );
    const current = await scanRoot(requireRoot());
    if (
      current.length !== previewHashes.size ||
      current.some((f) => previewHashes.get(f.path) !== hash(f.content))
    )
      throw new AppError(
        409,
        "STALE_PREVIEW",
        "Folder files changed after preview. Preview again.",
      );
    return commitRootPreview(
      lib,
      preview,
      previewHashes,
      request.body?.acceptWarnings === true,
      request.body?.identityMappings,
    );
  });
  app.put(base + "/files/:id/local-save", async (request: any) => {
    const lib = request.params.libraryId,
      file = store.get(lib, request.params.id, "file"),
      body = request.body;
    const operationRequest = { route: request.url, ...body };
    // The file write is async, so check the receipt before it and record it after the commit.
    const previous = store.receipt(body.operationId, operationRequest);
    if (previous) return previous.response;
    if (!file.local)
      throw new AppError(
        400,
        "NOT_LOCAL",
        "This source is stored inside the app.",
      );
    if (file.hash !== body.expectedHash)
      throw new AppError(
        409,
        "HASH_CONFLICT",
        "Material changed. Reload before saving.",
        file,
      );
    if (typeof body.content !== "string")
      throw new AppError(400, "INVALID_CONTENT", "Markdown text is required.");
    const preview = store.preview(lib, [{ ...file, content: body.content }]);
    if (!preview.canCommit || (preview.issues.length && !body.acceptWarnings))
      throw new AppError(
        400,
        "IMPORT_ISSUES",
        "Fix import issues before saving.",
        { issues: preview.issues },
      );
    const journalId = await safeSave(
      requireRoot(),
      file.path,
      file.hash,
      body.content,
      journalRoot,
    );
    const updated = store.operation(body.operationId, operationRequest, () => {
      store.commit(
        lib,
        preview.id,
        body.acceptWarnings === true,
        body.identityMappings,
      );
      return store.put(lib, "file", {
        ...store.get(lib, file.id, "file"),
        local: true,
      });
    });
    await acknowledgeMaterialSave(journalRoot, journalId);
    return updated;
  });
  app.get("/api/material-recovery", async () => ({
    pending: root
      ? (await pendingMaterialSaves(root, journalRoot)).map(
          ({ original, content, ...entry }) => entry,
        )
      : [],
  }));
  app.post(base + "/material-recovery/:id", async (request: any) => {
    const pending = await pendingMaterialSaves(requireRoot(), journalRoot),
      entry = pending.find((e) => e.id === request.params.id);
    if (!entry)
      throw new AppError(404, "NOT_FOUND", "Recovery entry not found.");
    const file = store
      .list(request.params.libraryId, "file", ["content"])
      .find((f) => f.local && f.path === entry.path);
    if (!file)
      throw new AppError(
        409,
        "WRONG_LIBRARY",
        "Select the library containing this local file.",
      );
    if (entry.state === "conflict")
      throw new AppError(
        409,
        "SOURCE_CONFLICT",
        "External edits require manual review. The journal retains both versions.",
      );
    if (entry.state === "reimport") {
      const preview = store.preview(request.params.libraryId, [
        { ...file, content: entry.content },
      ]);
      store.commit(
        request.params.libraryId,
        preview.id,
        request.body?.acceptWarnings === true,
      );
    }
    await acknowledgeMaterialSave(journalRoot, entry.id);
    return { recovered: true };
  });
}
