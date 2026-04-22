const { app, BrowserWindow, ipcMain, dialog, Tray, Menu } = require("electron");const fs = require("fs");
const path = require("path");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const { imageSize } = require("image-size");
const chokidar = require("chokidar");
app.disableHardwareAcceleration();

let tray = null;
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".pdf", ".webp",
]);

let mainWindow = null;
let folderWatcher = null;

function isDirectory(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function getFiles(targetPath) {
  try {
    return fs.readdirSync(targetPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        name: entry.name,
        path: path.join(targetPath, entry.name),
      }));
  } catch {
    return [];
  }
}

function getImageFiles(targetPath) {
  return getFiles(targetPath).filter((file) =>
    SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(file.name).toLowerCase()),
  );
}

function getDirectories(targetPath) {
  try {
    return fs.readdirSync(targetPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(targetPath, entry.name),
      }));
  } catch {
    return [];
  }
}

function buildUniqueFilePath(directoryPath, desiredName, extension) {
  let candidateName = `${desiredName}${extension}`;
  let candidatePath = path.join(directoryPath, candidateName);
  let counter = 1;

  while (fs.existsSync(candidatePath)) {
    candidateName = `${desiredName}_${counter}${extension}`;
    candidatePath = path.join(directoryPath, candidateName);
    counter++;
  }

  return { fileName: candidateName, fullPath: candidatePath };
}

function normalizeHN(code) {
  if (!code) return null;

  return code
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/S/g, "5");
}

async function safeUnlink(filePath, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return true;
    } catch (err) {
      if (i < maxRetries - 1) {
        // รอ 100ms แล้วลองใหม่
        await new Promise(resolve => setTimeout(resolve, 100));
      } else {
        console.warn(`Failed to delete ${filePath} after ${maxRetries} retries:`, err.message);
      }
    }
  }
  return false;
}

function extractNumericHN(rawText) {
  const normalizedText = String(rawText || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedText) {
    return null;
  }

  const matches = normalizedText.match(/\d{4,}/g);

  if (!matches || matches.length === 0) {
    return null;
  }

  return matches.sort((a, b) => b.length - a.length)[0];
}

function extractHN(rawText) {
  if (!rawText) return null;

  const lines = rawText
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0);
  if (lines.length < 1) return null;

  let line = lines[0];

  line = line
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/S/g, "5")
    .replace(/[^A-Z0-9]/g, "");

  return line || null;
}


async function runOCR(imagePath) {
  return Tesseract.recognize(imagePath, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    tessedit_pageseg_mode: 6,
    tessedit_ocr_engine_mode: 1,
  });
}

function renameUsingHN(directoryPath, imageFile, hn, metadata = {}) {
  const extension = path.extname(imageFile.name);
  const nameWithoutExt = path.parse(imageFile.name).name;
  
  if (nameWithoutExt === hn) {
    return {
      type: "skipped",
      item: { reason: "ชื่อไฟล์ตรงกับรหัส DX แล้ว", path: imageFile.path },
    };
  }

  const uniqueTarget = buildUniqueFilePath(directoryPath, hn, extension);

  fs.renameSync(imageFile.path, uniqueTarget.fullPath);

  return {
    type: "renamed",
    item: {
      oldName: imageFile.name,
      newName: uniqueTarget.fileName,
      hn,
      ...metadata,
    },
  };
}

async function renameVendor2XrayFiles(reportRootPath) {
  if (!reportRootPath || !isDirectory(reportRootPath)) {
    throw new Error("ไม่พบโฟลเดอร์ root");
  }
  const backupPath = path.join(reportRootPath, "Backup");
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath, { recursive: true });
  }

  const imageFiles = getImageFiles(reportRootPath);
  const renamedItems = [];
  const skippedItems = [];

  for (const imageFile of imageFiles) {
    let tempOcrFile = null;
    try {
      const buffer = fs.readFileSync(imageFile.path);
      const { width, height } = imageSize(buffer);
      const cropArea = {
        left: 0,
        top: Math.floor(height * 0.09),
        width: Math.floor(width * 0.15),
        height: Math.floor(height * 0.04),
      };

      const temp = imageFile.path + "_ocr.jpg";
      tempOcrFile = temp;

      await sharp(imageFile.path)
        .extract(cropArea)
        .resize(cropArea.width * 10, cropArea.height * 10)
        .grayscale()
        .normalize()
        .sharpen({ sigma: 2.5 })
        .modulate({ contrast: 10, brightness: 0.2 })
        .negate()
        .toFile(temp);

      const ocr = await runOCR(temp);
      const text = ocr?.data?.text || "";

      let hn = extractHN(text);
      hn = normalizeHN(hn);

      if (!hn) {
        skippedItems.push({
          reason: "OCR หา HN ไม่พบ",
          path: imageFile.path,
          ocrPreview: text.slice(0, 100),
        });
        continue;
      }

      const backupFile = path.join(backupPath, imageFile.name);
      fs.copyFileSync(imageFile.path, backupFile);

      const result = renameUsingHN(reportRootPath, imageFile, hn, {
        ocrPreview: text.slice(0, 100),
      });

      if (result.type === "renamed") {
        renamedItems.push(result.item);
      } else {
        skippedItems.push(result.item);
      }
    } catch (err) {
      skippedItems.push({
        reason: err.message,
        path: imageFile.path,
      });
    } finally {
      if (tempOcrFile) {
        await safeUnlink(tempOcrFile);
      }
    }
  }

  return {
    mode: "vendor2",
    reportRootPath,
    backupPath,
    imageFileCount: imageFiles.length,
    renamedItems,
    skippedItems,
  };
}

async function renameVendor1XrayFiles(reportRootPath) {
  if (!reportRootPath || !isDirectory(reportRootPath)) {
    throw new Error("ไม่พบโฟลเดอร์ root");
  }

  const dateFolders = getDirectories(reportRootPath);
  const renamedItems = [];
  const skippedItems = [];

  for (const dateFolder of dateFolders) {
    const hnFolders = getDirectories(dateFolder.path);

    for (const hnFolder of hnFolders) {
      const hn = hnFolder.name.trim();

      if (!hn) {
        skippedItems.push({
          reason: "ชื่อโฟลเดอร์ HN ว่างเปล่า",
          path: hnFolder.path,
        });
        continue;
      }

      const petFolders = getDirectories(hnFolder.path);

      if (petFolders.length === 0) {
        skippedItems.push({
          reason: "ไม่มีโฟลเดอร์ชื่อสัตว์ภายใต้ HN นี้",
          path: hnFolder.path,
        });
        continue;
      }

      for (const petFolder of petFolders) {
        const imageFiles = getImageFiles(petFolder.path);

        if (imageFiles.length === 0) {
          skippedItems.push({
            reason: "ไม่มีไฟล์ภาพในโฟลเดอร์ชื่อสัตว์",
            path: petFolder.path,
          });
          continue;
        }

        for (const imageFile of imageFiles) {
          const result = renameUsingHN(petFolder.path, imageFile, hn, {
            dateFolder: dateFolder.name,
            petFolder: petFolder.name,
          });

          if (result.type === "renamed") {
            renamedItems.push(result.item);
          } else {
            skippedItems.push(result.item);
          }
        }
      }
    }
  }

  return {
    mode: "vendor1",
    reportRootPath,
    dateFolderCount: dateFolders.length,
    renamedItems,
    skippedItems,
  };
}

async function renameXrayFilesByMode(mode, reportRootPath) {
  if (mode === "vendor1") {
    return renameVendor1XrayFiles(reportRootPath);
  }

  if (mode === "vendor2") {
    return renameVendor2XrayFiles(reportRootPath);
  }

  throw new Error("โหมดที่เลือกไม่ถูกต้อง");
}

function detectVendorType(reportRootPath) {
  if (!reportRootPath || !isDirectory(reportRootPath)) {
    return null;
  }

  // ตรวจสอบ vendor2: ไฟล์ภาพในระดับ root โดยตรง
  const rootImages = getImageFiles(reportRootPath);
  if (rootImages.length > 0) {
    return "vendor2";
  }

  // ตรวจสอบ vendor1: โครงสร้าง date folders → HN folders → image files
  const topLevelDirs = getDirectories(reportRootPath);
  
  // ถ้ามี folder ที่ดูเหมือน date format
  for (const dir of topLevelDirs) {
    const subDirs = getDirectories(dir.path);
    
    // vendor1 ต้องมี HN folders อย่างน้อย 1 folder
    if (subDirs.length > 0) {
      for (const subDir of subDirs) {
        const petFolders = getDirectories(subDir.path);
        // ถ้า HN folder มี pet folders
        if (petFolders.length > 0) {
          for (const petFolder of petFolders) {
            const images = getImageFiles(petFolder.path);
            if (images.length > 0) {
              return "vendor1";
            }
          }
        }
      }
    }
  }

  // ไม่สามารถตรวจสอบได้
  return null;
}

function startWatchingFolder(reportRootPath) {
  // ปิด watcher เก่าก่อน
  if (folderWatcher) {
    folderWatcher.close();
  }

  if (!reportRootPath || !isDirectory(reportRootPath)) {
    return;
  }

  folderWatcher = chokidar.watch(reportRootPath, {
    ignored: /(^|[\/\\])\.|_ocr/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100
    }
  });

  folderWatcher.on("add", async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
      return;
    }

    // ส่ง event ไปยัง renderer process
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("new-image-detected", {
        folderPath: reportRootPath,
        fileName: path.basename(filePath),
        filePath
      });
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.on("close", (event) => {
    event.preventDefault();
    mainWindow.hide();
  });
}

ipcMain.handle("select-report-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });

  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle("rename-xray-files", async (_event, payload) => {
  return renameXrayFilesByMode(payload?.mode, payload?.reportRootPath);
});

ipcMain.handle("detect-vendor-type", async (_event, reportRootPath) => {
  return detectVendorType(reportRootPath);
});

ipcMain.handle("start-watching-folder", async (_event, reportRootPath) => {
  startWatchingFolder(reportRootPath);
  return true;
});

ipcMain.handle("stop-watching-folder", async () => {
  if (folderWatcher) {
    folderWatcher.close();
    folderWatcher = null;
  }
  return true;
});

app.whenReady().then(() => {
  createWindow();

  tray = new Tray(path.join(__dirname, "x-ray.png"));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "เปิดโปรแกรม",
      click: () => {
        createWindow();
      }
    },
    {
      label: "ออกจากโปรแกรม",
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setToolTip("Xray Renamer");
  tray.setContextMenu(contextMenu);
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
  
  // ปิด watcher
  if (folderWatcher) {
    folderWatcher.close();
    folderWatcher = null;
  }
});