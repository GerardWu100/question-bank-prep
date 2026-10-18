// Desktop wrapper: runs the study server inside Electron on a private loopback port and
// shows it in a window. No password (loopback only); data lives in the app's user-data
// folder. The question-bank and study-notes folders are chosen from the File menu.
const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const LOOPBACK = "127.0.0.1";
const SERVER_START_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 200;
/** Built by `npm run build:desktop`: bundled server, calculator worker and web build. */
const BUILD_DIRECTORY = join(__dirname, "build");
const settingsPath = () => join(app.getPath("userData"), "desktop-settings.json");

/** Desktop settings: `{ materialRoot?: string, readingRoot?: string }` (absolute folders). */
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
  writeSettings({ ...readSettings(), [key]: filePaths[0] });
  app.relaunch();
  app.exit(0);
}

function buildMenu() {
  const settings = readSettings();
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" }] : []),
      {
        label: "File",
        submenu: [
          {
            label: `Question-bank folder… ${settings.materialRoot ? `(${settings.materialRoot})` : "(none)"}`,
            click: () => chooseFolder("materialRoot", "Choose the question-bank folder (Markdown banks, synced on open)"),
          },
          {
            label: `Study-notes folder… ${settings.readingRoot ? `(${settings.readingRoot})` : "(none)"}`,
            click: () => chooseFolder("readingRoot", "Choose the study-notes folder (read-only Markdown)"),
          },
          {
            label: "Forget both folders",
            enabled: Boolean(settings.materialRoot || settings.readingRoot),
            click: () => {
              writeSettings({});
              app.relaunch();
              app.exit(0);
            },
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
    buildMenu();
    let url;
    try {
      url = await startServer();
    } catch (error) {
      dialog.showErrorBox("Study app could not start", String(error?.stack ?? error));
      app.exit(1);
      return;
    }
    window = new BrowserWindow({ width: 1280, height: 900, title: "Question Bank Prep", autoHideMenuBar: false });
    // Links to other sites open in the normal browser, not inside the app.
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (!target.startsWith(url)) void shell.openExternal(target);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, target) => {
      if (!target.startsWith(url)) {
        event.preventDefault();
        void shell.openExternal(target);
      }
    });
    await window.loadURL(url);
  });
  // The server runs in this process, so closing the last window ends both.
  app.on("window-all-closed", () => app.quit());
}
