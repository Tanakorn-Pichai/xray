const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("xrayApp", {
  selectReportFolder: () => ipcRenderer.invoke("select-report-folder"),
  renameXrayFiles: (reportRootPath) =>
    ipcRenderer.invoke("rename-xray-files", reportRootPath)
});
