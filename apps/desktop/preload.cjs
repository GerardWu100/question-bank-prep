// Bridge for connect.html only: send the chosen server address to the main process.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  /** Resolves to an error message, or never (the app restarts on success). */
  connect: (url) => ipcRenderer.invoke("connect-server", url),
  cancel: () => ipcRenderer.invoke("cancel-connect"),
});
