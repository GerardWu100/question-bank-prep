// Bridge between pages and the main process. connect.html uses connect/cancel; the app
// page (local mode only) uses the folder calls behind Settings → Folders.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  /** Resolves to an error message, or never (the app restarts on success). */
  connect: (url) => ipcRenderer.invoke("connect-server", url),
  cancel: () => ipcRenderer.invoke("cancel-connect"),
  /** `{ questions: path | null, materials: path | null }`, or null outside local mode. */
  folders: () => ipcRenderer.invoke("folders"),
  /** Pick the "questions" or "materials" folder; the app restarts on a pick. */
  chooseFolder: (kind) => ipcRenderer.invoke("choose-folder", kind),
  /** Stop using the "questions" or "materials" folder; the app restarts. */
  forgetFolder: (kind) => ipcRenderer.invoke("forget-folder", kind),
});
