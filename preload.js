const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xrayApp", {
  selectReportFolder: () => ipcRenderer.invoke("select-report-folder"),
  renameXrayFiles: (reportRootPath) =>
    ipcRenderer.invoke("rename-xray-files", reportRootPath),
  detectVendorType: (reportRootPath) =>
    ipcRenderer.invoke("detect-vendor-type", reportRootPath),
  startWatchingFolder: (reportRootPath) =>
    ipcRenderer.invoke("start-watching-folder", reportRootPath),
  stopWatchingFolder: () =>
    ipcRenderer.invoke("stop-watching-folder"),
  onNewImageDetected: (callback) =>
    ipcRenderer.on("new-image-detected", (_event, data) => callback(data))
});
