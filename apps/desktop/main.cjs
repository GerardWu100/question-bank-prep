// Desktop wrapper with two modes, chosen in the File menu:
// - This computer (default): runs the study server inside Electron on a private loopback
//   port, with no password; data lives in the app's user-data folder, and the
//   question-bank and study-notes folders are chosen from the File menu.
// - Server: shows a hosted Question Bank Prep server (for example the Docker image), so
//   questions, notes and progress come from it; sign in with the server's password.
const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require("electron");
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const LOOPBACK = "127.0.0.1";
const SERVER_START_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 200;
/** How long Connect waits for a server to answer before reporting it unreachable. */
const SERVER_CHECK_TIMEOUT_MS = 8_000;
/** Built by `npm run build:desktop`: bundled server, calculator worker and web build. */
const BUILD_DIRECTORY = join(__dirname, "build");
/** Link schemes handed to the operating system; others (file:, smb:, custom handlers) can start programs. */
const EXTERNAL_LINK_PROTOCOLS = ["https:", "http:", "mailto:"];
/** Hosts a plain-http server address may use: this computer, private networks, single-label and .local names. */
const PRIVATE_HOST_PATTERN =
  /^(localhost|127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|\[::1\]|[^.]+|.+\.local)$/;
/** The only permission pages get: the Guide's Copy button writes to the clipboard. */
const ALLOWED_PERMISSION = "clipboard-sanitized-write";
const settingsPath = () => join(app.getPath("userData"), "desktop-settings.json");

/**
 * Desktop settings: `{ serverUrl?: string, materialRoot?: string, readingRoot?: string }`.
 * serverUrl (http or https origin) selects server mode; the folders are absolute paths
 * used only in local mode.
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

async function startServer() {
  const port = await freePort();
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
  await import(pathToFileURL(join(BUILD_DIRECTORY, "server.mjs")).href);
  const url = `http://${LOOPBACK}:${port}`;
  // The server module starts listening on import; wait until it answers.
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return url;
    } catch {
      /* Not listening yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  throw new Error("The study server did not start.");
}

/** Pick a folder for one setting, save it and restart so the server reads it. */
async function chooseFolder(key, title) {
  const { canceled, filePaths } = await dialog.showOpenDialog({ title, properties: ["openDirectory"] });
  if (canceled || !filePaths[0]) return;
  saveAndRestart({ [key]: filePaths[0] });
}

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
    if (url.protocol === "http:" && !PRIVATE_HOST_PATTERN.test(url.hostname))
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
            click: () => chooseFolder("materialRoot", "Choose the question-bank folder (Markdown banks, synced on open)"),
          },
          {
            label: `Study-notes folder… ${settings.readingRoot ? `(${settings.readingRoot})` : "(none)"}`,
            enabled: local,
            click: () => chooseFolder("readingRoot", "Choose the study-notes folder (read-only Markdown)"),
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
    window = new BrowserWindow({ width: 1280, height: 900, title: "Question Bank Prep", show: false });
    buildMenu(window);
    const { serverUrl } = readSettings();
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
