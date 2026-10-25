import { useState } from "react";
import { api } from "./api";

/** The two folders the app reads: question banks (MATERIAL_ROOT) and materials (READING_ROOT). */
export type FolderKind = "questions" | "materials";
/** Folder paths the desktop app uses, per kind; null means none chosen. */
export type DesktopFolders = Record<FolderKind, string | null>;
/** The desktop app's bridge (apps/desktop/preload.cjs); absent in a browser. */
interface DesktopBridge {
  folders?: () => Promise<DesktopFolders | null>;
  chooseFolder?: (kind: FolderKind) => Promise<void>;
  forgetFolder?: (kind: FolderKind) => Promise<void>;
}
const bridge = (window as { desktop?: DesktopBridge }).desktop;
const FOLDER_LABELS: Record<FolderKind, string> = {
  questions: "Question banks",
  materials: "Materials",
};
/** How many picked file paths the upload summary names before "…". */
const UPLOAD_SUMMARY_FILES = 8;
/** Folder names that never hold a bank: version control and tool state. */
const SKIPPED_IMPORT_FOLDERS = new Set([".git", "node_modules"]);

/**
 * The desktop app's folders in local mode; null in a browser or when the desktop app
 * shows a hosted server (that server's own folders apply).
 */
export async function loadDesktopFolders(): Promise<DesktopFolders | null> {
  return bridge?.folders ? bridge.folders() : null;
}
/** Open the system folder picker; the desktop app restarts when a folder is picked. */
export const chooseDesktopFolder = (kind: FolderKind) =>
  bridge?.chooseFolder?.(kind);

/**
 * Read a picked folder into import entries, keeping only Markdown (README.md describes a
 * bank, so it is skipped). `webkitRelativePath` is "picked-folder/01-quant/qbank.md"; the
 * picked folder's own name is dropped, so the first remaining folder becomes the topic and
 * the file name the source, as in a configured question-bank folder.
 */
async function readMarkdownFolder(list: FileList | null) {
  const files = [...(list ?? [])].filter((file) => {
    const parts = file.webkitRelativePath.split("/");
    return (
      /\.(md|markdown)$/i.test(file.name) &&
      file.name.toLowerCase() !== "readme.md" &&
      !parts.some((part) => SKIPPED_IMPORT_FOLDERS.has(part))
    );
  });
  const entries = await Promise.all(
    files.map(async (file) => ({
      path: file.webkitRelativePath.split("/").slice(1).join("/"),
      content: await file.text(),
    })),
  );
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Empty-state action for a page with no folder: the desktop app opens the folder picker,
 * a browser goes to Settings → Folders.
 */
export function FolderHint({
  kind,
  desktopFolders,
  onOpenSettings,
}: {
  kind: FolderKind;
  desktopFolders: DesktopFolders | null;
  onOpenSettings: () => void;
}) {
  return desktopFolders ? (
    <button onClick={() => void chooseDesktopFolder(kind)}>
      Choose {kind === "questions" ? "question-bank" : "materials"} folder…
    </button>
  ) : (
    <button className="secondary" onClick={onOpenSettings}>
      Settings → Folders
    </button>
  );
}

/**
 * Settings → Folders: where question banks and materials come from, one row each.
 * - Desktop app: each folder is picked with the system dialog and read in place, like the
 *   Docker mounts; picking restarts the app so the server reads it.
 * - Server with the folder set (Docker /question_bank and /materials): shown, not changed.
 * - Server without a question-bank folder: a bank folder is uploaded into the library.
 */
export function FolderSettings({
  scope,
  busy,
  run,
  refresh,
  syncQuestions,
  desktopFolders,
  questionsConfigured,
  materialsConfigured,
}: {
  scope: string;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
  syncQuestions: () => Promise<void>;
  desktopFolders: DesktopFolders | null;
  questionsConfigured: boolean;
  materialsConfigured: boolean;
}) {
  // Bank files from an uploaded folder, then the server's preview of their import.
  const [uploadFiles, setUploadFiles] = useState<
    { path: string; content: string }[]
  >([]);
  const [preview, setPreview] = useState<any>(null);
  // Re-import identity choices: proposal key -> existing question ID, or null for new.
  const [identityMappings, setIdentityMappings] = useState<
    Record<string, string | null>
  >({});
  const [status, setStatus] = useState("");
  const configured: Record<FolderKind, boolean> = {
    questions: questionsConfigured,
    materials: materialsConfigured,
  };
  const statusOf = (kind: FolderKind) => {
    const path = desktopFolders?.[kind];
    if (path) return configured[kind] ? path : `${path} (not found)`;
    if (desktopFolders) return "No folder";
    if (configured[kind]) return "Set on the server";
    return kind === "questions"
      ? "No folder: upload one"
      : "No folder: set READING_ROOT on the server";
  };
  const showPreview = (next: any) => {
    setPreview(next);
    setIdentityMappings({});
  };
  return (
    <section className="panel folders">
      <h2>Folders</h2>
      {(["questions", "materials"] as const).map((kind) => (
        <div className="folder-row" key={kind}>
          <div className="folder-name">
            <strong>{FOLDER_LABELS[kind]}</strong>
            <span className="muted">{statusOf(kind)}</span>
          </div>
          <div className="folder-actions">
            {desktopFolders && (
              <button
                className="secondary"
                onClick={() => void chooseDesktopFolder(kind)}
              >
                Choose folder…
              </button>
            )}
            {desktopFolders?.[kind] && (
              <button
                className="secondary"
                onClick={() => void bridge?.forgetFolder?.(kind)}
              >
                Forget
              </button>
            )}
            {kind === "questions" && questionsConfigured && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setStatus("");
                    await syncQuestions();
                    await refresh();
                    setStatus("Question-bank folder synced");
                  })
                }
              >
                Sync now
              </button>
            )}
            {kind === "questions" && !desktopFolders && !questionsConfigured && (
              <label className="secondary file-button">
                Upload a folder…
                <input
                  type="file"
                  multiple
                  // Non-standard but supported by Chrome, Edge, Firefox and Safari.
                  {...({ webkitdirectory: "" } as any)}
                  onChange={(e) => {
                    const input = e.target;
                    void run(async () => {
                      setUploadFiles(await readMarkdownFolder(input.files));
                      input.value = "";
                      showPreview(null);
                    });
                  }}
                />
              </label>
            )}
          </div>
        </div>
      ))}
      {desktopFolders && (
        <p className="muted">
          Folders are read in place. Picking one restarts the app.
        </p>
      )}
      {status && <p className="muted">{status}</p>}
      {uploadFiles.length > 0 && (
        <div className="import-result">
          <p className="muted">
            {uploadFiles.length} Markdown file
            {uploadFiles.length === 1 ? "" : "s"}:{" "}
            {uploadFiles
              .slice(0, UPLOAD_SUMMARY_FILES)
              .map((file) => file.path)
              .join(", ")}
            {uploadFiles.length > UPLOAD_SUMMARY_FILES ? " …" : ""}
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () =>
                showPreview(
                  await api(`${scope}/imports/preview`, {
                    files: uploadFiles.map((file) => ({
                      ...file,
                      type: "questions",
                    })),
                  }),
                ),
              )
            }
          >
            Preview import
          </button>
          {preview && (
            <>
              <h3>{preview.counts?.questions || 0} questions found</h3>
              {preview.issues?.map((issue: any, index: number) => (
                <p
                  key={index}
                  className={issue.severity === "error" ? "error" : "muted"}
                >
                  {issue.path}:{issue.line} · {issue.message}
                </p>
              ))}
              {preview.identityProposals
                ?.filter(
                  (proposal: any) =>
                    !proposal.automatic && proposal.candidates.length > 0,
                )
                .map((proposal: any) => (
                  <label key={proposal.key}>
                    {proposal.title}: keep progress from an existing question?
                    <select
                      value={
                        identityMappings[proposal.key] === null
                          ? "new"
                          : identityMappings[proposal.key] || ""
                      }
                      onChange={(event) => {
                        const { [proposal.key]: _previous, ...rest } =
                          identityMappings;
                        setIdentityMappings(
                          event.target.value === ""
                            ? rest
                            : {
                                ...rest,
                                [proposal.key]:
                                  event.target.value === "new"
                                    ? null
                                    : event.target.value,
                              },
                        );
                      }}
                    >
                      <option value="">Automatic: new question</option>
                      <option value="new">Create a new question</option>
                      {proposal.candidates.map((candidate: any) => (
                        <option
                          key={candidate.id}
                          value={candidate.id}
                          disabled={!candidate.choicesCompatible}
                        >
                          {candidate.title}
                          {!candidate.choicesCompatible
                            ? " · choices changed"
                            : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              <button
                disabled={busy || !preview.canCommit}
                onClick={() =>
                  void run(async () => {
                    await api(`${scope}/imports/${preview.id}/commit`, {
                      acceptWarnings: true,
                      identityMappings,
                    });
                    showPreview(null);
                    setUploadFiles([]);
                    await refresh();
                    setStatus("Question banks imported");
                  })
                }
              >
                Confirm import
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
