// Desktop wrapper with two modes, chosen in the File menu:
// - This computer (default): runs the study server inside Electron on a private loopback
//   port, with no password; data lives in the app's user-data folder, and the
//   question-bank and materials folders are chosen in Settings → Folders or the File menu.
// - Server: shows a hosted Question Bank Prep server (for example the Docker image), so
//   questions, notes and progress come from it; sign in with the server's password.
const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require("electron");
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { isPrivateHost } = require("./private-host.cjs");

const LOOPBACK = "127.0.0.1";
/** Highest TCP port; a hand-edited `localPort` above it would make listen() throw. */
const MAX_PORT = 65_535;
/** How long Connect waits for a server to answer before reporting it unreachable. */
const SERVER_CHECK_TIMEOUT_MS = 8_000;
/** Built by `npm run build:desktop`: bundled server, calculator worker and web build. */
const BUILD_DIRECTORY = join(__dirname, "build");
/** Link schemes handed to the operating system; others (file:, smb:, custom handlers) can start programs. */
const EXTERNAL_LINK_PROTOCOLS = ["https:", "http:", "mailto:"];
/** The only permission pages get: the Guide's Copy button writes to the clipboard. */
const ALLOWED_PERMISSION = "clipboard-sanitized-write";
const settingsPath = () => join(app.getPath("userData"), "desktop-settings.json");
/**
 * Folder kinds the page may pick -> desktop setting key and dialog title. The keys match
 * the server's settings: materialRoot is MATERIAL_ROOT (question banks, synced into the
 * library), readingRoot is READING_ROOT (materials, read-only), as in the Docker mounts.
 */
const FOLDERS = {
  questions: { key: "materialRoot", title: "Choose the question-bank folder (Markdown banks, synced on open)" },
  materials: { key: "readingRoot", title: "Choose the materials folder (Markdown study notes, read-only)" },
};
/** Origin of the local server's page, once it listens; folder calls are accepted only from it. */
let localOrigin = "";

/**
 * Desktop settings: `{ serverUrl?: string, materialRoot?: string, readingRoot?: string,
 * localPort?: number }`. serverUrl (http or https origin) selects server mode; the folders
 * are absolute paths used only in local mode; localPort is the local server's loopback port.
 */
function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}
function writeSettings(settings) {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

/** Ask the operating system for an unused loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, LOOPBACK, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Whether nothing holds `port` on loopback right now: bind it briefly, then release it. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, LOOPBACK, () => probe.close(() => resolve(true)));
  });
}

/**
 * The local server's port, the same on every launch. The page's origin includes the port,
 * and the browser keeps theme, selected library and Resume per origin, so a new port would
 * hide them. The first launch saves a free port; when another program holds the saved
 * port, a new one is saved instead, and those browser preferences start over once
 * (progress lives in the database and is kept).
 */
async function localPort() {
  const settings = readSettings();
  const saved = settings.localPort;
  if (Number.isInteger(saved) && saved > 0 && saved <= MAX_PORT && (await portIsFree(saved))) return saved;
  const port = await freePort();
  writeSettings({ ...settings, localPort: port });
  return port;
}

async function startServer() {
  const port = await localPort();
  const settings = readSettings();
  // The server reads its configuration from the environment; values set here win over any .env file.
  Object.assign(process.env, {
    STUDY_HOST: LOOPBACK,
    STUDY_PORT: String(port),
    STUDY_PASSWORD: "",
    STUDY_DATA_DIR: join(app.getPath("userData"), "data"),
    STUDY_WEB_DIR: join(BUILD_DIRECTORY, "web"),
    MATERIAL_ROOT: settings.materialRoot && existsSync(settings.materialRoot) ? settings.materialRoot : "",
    READING_ROOT: settings.readingRoot && existsSync(settings.readingRoot) ? settings.readingRoot : "",
  });
  // The bundle ends with a top-level `await app.listen(...)`, so this import settles only
  // once our server is listening on the port, and rejects (EADDRINUSE) when the bind fails,
  // for example if another program took the port after the check above. Only then is the
  // URL loaded: a health check alone could be answered by another program on that port.
  await import(pathToFileURL(join(BUILD_DIRECTORY, "server.mjs")).href);
  localOrigin = `http://${LOOPBACK}:${port}`;
  return localOrigin;
}

/** Pick a folder of one kind ("questions" or "materials"), save it and restart so the server reads it. */
async function chooseFolder(kind, parent) {
  const { key, title } = FOLDERS[kind];
  const options = { title, properties: ["openDirectory"] };
  const { canceled, filePaths } = await (parent
    ? dialog.showOpenDialog(parent, options)
    : dialog.showOpenDialog(options));
  if (canceled || !filePaths[0]) return;
  saveAndRestart({ [key]: filePaths[0] });
}

/** Whether an IPC call comes from the local app page, so a hosted server's page cannot pick folders. */
function fromLocalPage(event) {
  if (readSettings().serverUrl || !localOrigin) return false;
  try {
    return new URL(event.senderFrame?.url ?? "").origin === localOrigin;
  } catch {
    return false;
  }
}
/** The folder kind the page sent, or an error for anything else. */
function folderKind(kind) {
  if (!Object.hasOwn(FOLDERS, kind)) throw new Error("Unknown folder kind.");
  return kind;
}
ipcMain.handle("folders", (event) => {
  if (!fromLocalPage(event)) return null;
  const settings = readSettings();
  return { questions: settings.materialRoot ?? null, materials: settings.readingRoot ?? null };
});
ipcMain.handle("choose-folder", (event, kind) => {
  if (!fromLocalPage(event)) return;
  return chooseFolder(folderKind(kind), BrowserWindow.fromWebContents(event.sender) ?? undefined);
});
ipcMain.handle("forget-folder", (event, kind) => {
  if (fromLocalPage(event)) saveAndRestart({ [FOLDERS[folderKind(kind)].key]: undefined });
});

/** Save a change to the settings and restart the app so it takes effect. */
function saveAndRestart(change) {
  writeSettings({ ...readSettings(), ...change });
  app.relaunch();
  app.exit(0);
}

/** Small window asking for a server address; connect.html talks to main through preload.cjs. */
function openConnectWindow(parent) {
  const connect = new BrowserWindow({
    parent,
    modal: Boolean(parent),
    width: 520,
    height: 300,
    resizable: false,
    title: "Connect to a server",
    webPreferences: { preload: join(__dirname, "preload.cjs") },
  });
  connect.setMenu(null);
  void connect.loadFile(join(__dirname, "connect.html"), {
    query: { current: readSettings().serverUrl ?? "" },
  });
}
ipcMain.handle("cancel-connect", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
ipcMain.handle("connect-server", async (_event, address) => {
  let origin;
  try {
    const url = new URL(String(address));
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    origin = url.origin;
    // Plain http sends the password and session in clear text: private networks only.
    if (url.protocol === "http:" && !isPrivateHost(url.hostname))
      return "Use https:// for a server on the internet; http:// works only on this computer or a home network.";
  } catch {
    return "Enter a full address starting with http:// or https://.";
  }
  // The app's health route is public, so this works before signing in.
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(SERVER_CHECK_TIMEOUT_MS) });
    if (!response.ok) return `The server answered ${response.status}. Is this a Question Bank Prep server?`;
  } catch {
    return `Could not reach ${origin}. Check the address and that the server is running.`;
  }
  saveAndRestart({ serverUrl: origin });
  return "";
});

function buildMenu(window) {
  const settings = readSettings();
  const isMac = process.platform === "darwin";
  const local = !settings.serverUrl;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" }] : []),
      {
        label: "File",
        submenu: [
          {
            label: settings.serverUrl ? `Connected to ${settings.serverUrl} · change server…` : "Connect to a server…",
            click: () => openConnectWindow(window),
          },
          {
            label: "Use this computer (local data)",
            enabled: !local,
            click: () => saveAndRestart({ serverUrl: undefined }),
          },
          { type: "separator" },
          {
            label: `Question-bank folder… ${settings.materialRoot ? `(${settings.materialRoot})` : "(none)"}`,
            enabled: local,
            click: () => chooseFolder("questions", window),
          },
          {
            label: `Materials folder… ${settings.readingRoot ? `(${settings.readingRoot})` : "(none)"}`,
            enabled: local,
            click: () => chooseFolder("materials", window),
          },
          {
            label: "Forget both folders",
            enabled: local && Boolean(settings.materialRoot || settings.readingRoot),
            click: () => saveAndRestart({ materialRoot: undefined, readingRoot: undefined }),
          },
          { type: "separator" },
          { label: "Open data folder", click: () => shell.openPath(join(app.getPath("userData"), "data")) },
          { type: "separator" },
          isMac ? { role: "close" } : { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

// One window, one server: a second launch focuses the running app.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window;
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(async () => {
    const { serverUrl } = readSettings();
    window = new BrowserWindow({
      width: 1280,
      height: 900,
      title: "Question Bank Prep",
      show: false,
      // Local mode only: the bridge lets Settings → Folders pick folders. A hosted
      // server's page never gets it (fromLocalPage also checks every call).
      webPreferences: serverUrl ? {} : { preload: join(__dirname, "preload.cjs") },
    });
    buildMenu(window);
    let url = serverUrl;
    if (!url) {
      try {
        url = await startServer();
      } catch (error) {
        dialog.showErrorBox("Study app could not start", String(error?.stack ?? error));
        app.exit(1);
        return;
      }
    }
    // Links to other sites open in the normal browser, not inside the app. Origins are
    // compared exactly: a prefix test would accept https://app.example.com.evil.net.
    const appOrigin = new URL(url).origin;
    const sameOrigin = (target) => {
      try {
        return new URL(target).origin === appOrigin;
      } catch {
        return false;
      }
    };
    const openOutside = (target) => {
      try {
        const link = new URL(target);
        if (EXTERNAL_LINK_PROTOCOLS.includes(link.protocol)) void shell.openExternal(link.href);
      } catch {
        // Not a URL: ignore it.
      }
    };
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      openOutside(target);
      return { action: "deny" };
    });
    const keepInApp = (event, target) => {
      if (sameOrigin(target)) return;
      event.preventDefault();
      openOutside(target);
    };
    window.webContents.on("will-navigate", keepInApp);
    window.webContents.on("will-redirect", keepInApp);
    // No camera, microphone, location or device access for any page.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === ALLOWED_PERMISSION),
    );
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === ALLOWED_PERMISSION);
    window.show();
    try {
      await window.loadURL(url);
    } catch {
      // Server mode only: the hosted server is down or the address changed.
      const { response } = await dialog.showMessageBox(window, {
        type: "warning",
        message: `Could not reach ${url}.`,
        detail: "Check the server, or use the data on this computer.",
        buttons: ["Retry", "Change server…", "Use this computer"],
      });
      if (response === 0) {
        app.relaunch();
        app.exit(0);
      } else if (response === 1) openConnectWindow(window);
      else saveAndRestart({ serverUrl: undefined });
    }
  });
  // The server runs in this process, so closing the last window ends both.
  app.on("window-all-closed", () => app.quit());
}
