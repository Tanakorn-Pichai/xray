const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xrayApp", {
  selectReportFolder: () => ipcRenderer.invoke("select-report-folder"),
  renameXrayFiles: (payload) => ipcRenderer.invoke("rename-xray-files", payload),
  detectVendorType: (reportRootPath) =>
    ipcRenderer.invoke("detect-vendor-type", reportRootPath),
  startWatchingFolder: (reportRootPath) =>
    ipcRenderer.invoke("start-watching-folder", reportRootPath),
  stopWatchingFolder: () => ipcRenderer.invoke("stop-watching-folder"),
  runInitialAutoScan: (reportRootPath) =>
    ipcRenderer.invoke("run-initial-auto-scan", reportRootPath),
  onNewImageDetected: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("new-image-detected", listener);
    return () => ipcRenderer.removeListener("new-image-detected", listener);
  },
});