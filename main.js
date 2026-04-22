const { app, BrowserWindow, ipcMain, dialog, Tray, Menu } = require("electron");
const fs = require("fs");
const path = require("path");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const { imageSize } = require("image-size");
const chokidar = require("chokidar");

app.disableHardwareAcceleration();

let tray = null;
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".bmp",
  ".tif",
  ".tiff",
  ".pdf",
  ".webp",
]);

let mainWindow = null;
let folderWatcher = null;
let isQuitting = false;
let processingQueue = Promise.resolve();
const generatedPaths = new Set();

function isDirectory(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function getFiles(targetPath) {
  try {
    return fs
      .readdirSync(targetPath, { withFileTypes: true })
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
    return fs
      .readdirSync(targetPath, { withFileTypes: true })
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

  return String(code)
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/S/g, "5");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBackupPath(filePath) {
  return filePath.split(path.sep).includes("Backup");
}

function isOcrTempPath(filePath) {
  return String(filePath).toLowerCase().includes("_ocr");
}

function isGeneratedPath(filePath) {
  return generatedPaths.has(path.resolve(filePath));
}

function markGeneratedPath(filePath) {
  const resolved = path.resolve(filePath);
  generatedPaths.add(resolved);

  const timer = setTimeout(() => {
    generatedPaths.delete(resolved);
  }, 15000);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

function isAlreadyTargetFile(nameWithoutExt, hn) {
  const normalizedName = normalizeHN(nameWithoutExt);
  const normalizedHN = normalizeHN(hn);

  if (!normalizedName || !normalizedHN) return false;

  return (
    normalizedName === normalizedHN ||
    normalizedName.startsWith(`${normalizedHN}_`)
  );
}

function isLikelyVendor2ProcessedFile(nameWithoutExt) {
  const upper = String(nameWithoutExt).toUpperCase();

  return /^[A-Z0-9]{4,}(?:_\d+)?$/.test(upper);
}

async function closeFolderWatcher() {
  if (!folderWatcher) return;

  const watcher = folderWatcher;
  folderWatcher = null;

  try {
    await watcher.close();
  } catch (err) {
    console.warn("Failed to close watcher:", err.message);
  }
}

async function enqueueTask(task) {
  processingQueue = processingQueue
    .then(task)
    .catch((err) => {
      console.warn("Processing error:", err.message);
    });

  return processingQueue;
}

function normalizePathSafe(targetPath) {
  try {
    return path.resolve(targetPath);
  } catch {
    return targetPath;
  }
}

function resolveVendor1ContextFromFilePath(reportRootPath, imagePath) {
  const root = normalizePathSafe(reportRootPath);
  const file = normalizePathSafe(imagePath);

  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  const parts = relative.split(path.sep);
  if (parts.length < 4) {
    return null;
  }

  const [dateFolderName, hnFolderName, petFolderName] = parts;
  const dateFolderPath = path.join(root, dateFolderName);
  const hnFolderPath = path.join(dateFolderPath, hnFolderName);
  const petFolderPath = path.join(hnFolderPath, petFolderName);

  if (
    !isDirectory(dateFolderPath) ||
    !isDirectory(hnFolderPath) ||
    !isDirectory(petFolderPath)
  ) {
    return null;
  }

  return {
    dateFolderName,
    hnFolderName,
    petFolderName,
    dateFolderPath,
    hnFolderPath,
    petFolderPath,
  };
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
        await new Promise((resolve) => setTimeout(resolve, 100));
      } else {
        console.warn(
          `Failed to delete ${filePath} after ${maxRetries} retries:`,
          err.message,
        );
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
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

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
  if (!fs.existsSync(imagePath)) {
    throw new Error(`ไฟล์ไม่พบ: ${imagePath}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  return Tesseract.recognize(imagePath, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    tessedit_pageseg_mode: 6,
    tessedit_ocr_engine_mode: 1,
  });
}

function renameUsingHN(directoryPath, imageFile, hn, metadata = {}) {
  const extension = path.extname(imageFile.name);
  const nameWithoutExt = path.parse(imageFile.name).name;

  if (isAlreadyTargetFile(nameWithoutExt, hn)) {
    return {
      type: "skipped",
      item: { reason: "ชื่อไฟล์ตรงกับรหัส DX แล้ว", path: imageFile.path },
    };
  }

  const uniqueTarget = buildUniqueFilePath(directoryPath, hn, extension);

  fs.renameSync(imageFile.path, uniqueTarget.fullPath);
  markGeneratedPath(uniqueTarget.fullPath);

  return {
    type: "renamed",
    item: {
      oldName: imageFile.name,
      newName: uniqueTarget.fileName,
      targetPath: uniqueTarget.fullPath,
      hn,
      ...metadata,
    },
  };
}

async function processVendor2ImageFile(reportRootPath, imagePath) {
  if (!reportRootPath || !isDirectory(reportRootPath)) {
    throw new Error("ไม่พบโฟลเดอร์ root");
  }

  if (!imagePath || isBackupPath(imagePath) || isOcrTempPath(imagePath)) {
    return {
      type: "skipped",
      item: { reason: "ไฟล์ที่ไม่ต้องประมวลผล", path: imagePath },
    };
  }

  if (isGeneratedPath(imagePath)) {
    return {
      type: "skipped",
      item: { reason: "ไฟล์ที่โปรแกรมสร้างขึ้นเอง", path: imagePath },
    };
  }

  const ext = path.extname(imagePath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
    return {
      type: "skipped",
      item: { reason: "นามสกุลไฟล์ไม่รองรับ", path: imagePath },
    };
  }

  const imageFile = {
    name: path.basename(imagePath),
    path: imagePath,
  };

  const nameWithoutExt = path.parse(imageFile.name).name;

  if (isLikelyVendor2ProcessedFile(nameWithoutExt)) {
    return {
      type: "skipped",
      item: { reason: "ไฟล์น่าจะถูก rename แล้ว", path: imagePath },
    };
  }

  const backupPath = path.join(reportRootPath, "Backup");
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath, { recursive: true });
  }

  let tempOcrFile = null;

  try {
    await new Promise((r) => setTimeout(r, 800));

    const buffer = fs.readFileSync(imageFile.path);
    const { width, height } = imageSize(buffer);

    const cropArea = {
      left: 0,
      top: Math.floor(height * 0.09),
      width: Math.floor(width * 0.15),
      height: Math.floor(height * 0.04),
    };

    tempOcrFile = imageFile.path + "_ocr.jpg";

    await sharp(imageFile.path)
      .extract(cropArea)
      .resize(Math.max(1, cropArea.width * 10), Math.max(1, cropArea.height * 10))
      .grayscale()
      .normalize()
      .sharpen({ sigma: 2.5 })
      .modulate({ contrast: 10, brightness: 0.2 })
      .negate()
      .toFile(tempOcrFile);

    const ocr = await runOCR(tempOcrFile);
    const text = ocr?.data?.text || "";

    let hn = extractHN(text);
    hn = normalizeHN(hn);

    if (!hn) {
      return {
        type: "skipped",
        item: {
          reason: "OCR หา HN ไม่พบ",
          path: imageFile.path,
          ocrPreview: text.slice(0, 100),
        },
      };
    }

    const backupFile = path.join(backupPath, imageFile.name);
    if (!fs.existsSync(backupFile)) {
      fs.copyFileSync(imageFile.path, backupFile);
    }

    const result = renameUsingHN(reportRootPath, imageFile, hn, {
      ocrPreview: text.slice(0, 100),
    });

    if (result.type === "renamed") {
      return result;
    }

    return {
      type: "skipped",
      item: result.item,
    };
  } catch (err) {
    return {
      type: "skipped",
      item: {
        reason: err.message,
        path: imageFile.path,
      },
    };
  } finally {
    if (tempOcrFile) {
      await safeUnlink(tempOcrFile);
    }
  }
}

async function processVendor1ImageFile(reportRootPath, imagePath) {
  if (!reportRootPath || !isDirectory(reportRootPath)) {
    throw new Error("ไม่พบโฟลเดอร์ root");
  }

  if (!imagePath || isBackupPath(imagePath) || isOcrTempPath(imagePath)) {
    return {
      type: "skipped",
      item: { reason: "ไฟล์ที่ไม่ต้องประมวลผล", path: imagePath },
    };
  }

  if (isGeneratedPath(imagePath)) {
    return {
      type: "skipped",
      item: { reason: "ไฟล์ที่โปรแกรมสร้างขึ้นเอง", path: imagePath },
    };
  }

  const ext = path.extname(imagePath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
    return {
      type: "skipped",
      item: { reason: "นามสกุลไฟล์ไม่รองรับ", path: imagePath },
    };
  }

  const ctx = resolveVendor1ContextFromFilePath(reportRootPath, imagePath);
  if (!ctx) {
    return {
      type: "skipped",
      item: { reason: "โครงสร้างโฟลเดอร์ไม่ถูกต้อง", path: imagePath },
    };
  }

  const hn = normalizeHN(ctx.hnFolderName.trim()) || ctx.hnFolderName.trim();

  const imageFile = {
    name: path.basename(imagePath),
    path: imagePath,
  };

  const nameWithoutExt = path.parse(imageFile.name).name;
  if (isAlreadyTargetFile(nameWithoutExt, hn)) {
    return {
      type: "skipped",
      item: { reason: "ชื่อไฟล์ตรงกับ HN แล้ว", path: imageFile.path },
    };
  }

  const backupPath = path.join(ctx.petFolderPath, "Backup");
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath, { recursive: true });
  }

  try {
    const backupFile = path.join(backupPath, imageFile.name);
    if (!fs.existsSync(backupFile)) {
      fs.copyFileSync(imageFile.path, backupFile);
    }

    const result = renameUsingHN(ctx.petFolderPath, imageFile, hn, {
      dateFolder: ctx.dateFolderName,
      petFolder: ctx.petFolderName,
    });

    if (result.type === "renamed") {
      return result;
    }

    return {
      type: "skipped",
      item: result.item,
    };
  } catch (err) {
    return {
      type: "skipped",
      item: {
        reason: err.message,
        path: imageFile.path,
      },
    };
  }
}

async function renameVendor2XrayFiles(reportRootPath, specificFile = null) {
  if (!reportRootPath || !isDirectory(reportRootPath)) {
    throw new Error("ไม่พบโฟลเดอร์ root");
  }

  const backupPath = path.join(reportRootPath, "Backup");
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath, { recursive: true });
  }

  let imageFiles = [];
  if (specificFile) {
    imageFiles.push({
      name: path.basename(specificFile),
      path: specificFile,
    });
  } else {
    imageFiles = getImageFiles(reportRootPath).filter(
      (file) =>
        !isBackupPath(file.path) &&
        !isOcrTempPath(file.path) &&
        !isGeneratedPath(file.path),
    );
  }

  const renamedItems = [];
  const skippedItems = [];

  for (const imageFile of imageFiles) {
    const result = await processVendor2ImageFile(reportRootPath, imageFile.path);

    if (result.type === "renamed") {
      renamedItems.push(result.item);
    } else if (result.item) {
      skippedItems.push(result.item);
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

async function renameVendor1XrayFiles(reportRootPath, specificFile = null) {
  if (!reportRootPath || !isDirectory(reportRootPath)) {
    throw new Error("ไม่พบโฟลเดอร์ root");
  }

  const renamedItems = [];
  const skippedItems = [];

  if (specificFile) {
    const result = await processVendor1ImageFile(reportRootPath, specificFile);

    if (result.type === "renamed") {
      renamedItems.push(result.item);
    } else if (result.item) {
      skippedItems.push(result.item);
    }

    return {
      mode: "vendor1",
      reportRootPath,
      renamedItems,
      skippedItems,
    };
  }

  const dateFolders = getDirectories(reportRootPath);

  for (const dateFolder of dateFolders) {
    const hnFolders = getDirectories(dateFolder.path).filter(
      (folder) => folder.name !== "Backup",
    );

    for (const hnFolder of hnFolders) {
      const petFolders = getDirectories(hnFolder.path).filter(
        (folder) => folder.name !== "Backup",
      );

      if (petFolders.length === 0) {
        skippedItems.push({
          reason: "ไม่มีโฟลเดอร์ชื่อสัตว์ภายใต้ HN นี้",
          path: hnFolder.path,
        });
        continue;
      }

      for (const petFolder of petFolders) {
        const imageFiles = getImageFiles(petFolder.path).filter(
          (file) => !isBackupPath(file.path) && !isOcrTempPath(file.path),
        );

        if (imageFiles.length === 0) {
          skippedItems.push({
            reason: "ไม่มีไฟล์ภาพในโฟลเดอร์ชื่อสัตว์",
            path: petFolder.path,
          });
          continue;
        }

        for (const imageFile of imageFiles) {
          const result = await processVendor1ImageFile(
            reportRootPath,
            imageFile.path,
          );

          if (result.type === "renamed") {
            renamedItems.push(result.item);
          } else if (result.item) {
            skippedItems.push(result.item);
          }
        }
      }
    }
  }

  return {
    mode: "vendor1",
    reportRootPath,
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

  const rootImages = getImageFiles(reportRootPath).filter(
    (file) => !isBackupPath(file.path) && !isOcrTempPath(file.path),
  );
  if (rootImages.length > 0) {
    return "vendor2";
  }

  const topLevelDirs = getDirectories(reportRootPath);

  for (const dir of topLevelDirs) {
    const subDirs = getDirectories(dir.path).filter(
      (folder) => folder.name !== "Backup",
    );

    if (subDirs.length > 0) {
      for (const subDir of subDirs) {
        const petFolders = getDirectories(subDir.path).filter(
          (folder) => folder.name !== "Backup",
        );

        if (petFolders.length > 0) {
          for (const petFolder of petFolders) {
            const images = getImageFiles(petFolder.path).filter(
              (file) => !isBackupPath(file.path) && !isOcrTempPath(file.path),
            );
            if (images.length > 0) {
              return "vendor1";
            }
          }
        }
      }
    }
  }

  return null;
}

async function startWatchingFolder(reportRootPath) {
  await closeFolderWatcher();

  if (!reportRootPath || !isDirectory(reportRootPath)) {
    return;
  }

  let vendorType = detectVendorType(reportRootPath);

  folderWatcher = chokidar.watch(reportRootPath, {
    ignored: /(^|[\/\\])\.|_ocr|Backup/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100,
    },
  });

  folderWatcher.on("add", (filePath) => {
    enqueueTask(async () => {
      if (isGeneratedPath(filePath)) return;
      if (isBackupPath(filePath)) return;
      if (isOcrTempPath(filePath)) return;

      const ext = path.extname(filePath).toLowerCase();
      if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
        return;
      }

      vendorType = detectVendorType(reportRootPath);

      try {
        if (vendorType === "vendor2") {
          await renameVendor2XrayFiles(reportRootPath, filePath);
        } else if (vendorType === "vendor1") {
          await renameVendor1XrayFiles(reportRootPath, filePath);
        }
      } catch (err) {
        console.warn("Auto-rename error:", err.message);
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("new-image-detected", {
          folderPath: reportRootPath,
          fileName: path.basename(filePath),
          filePath,
        });
      }
    });
  });
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  return createWindow();
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

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
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

ipcMain.handle("select-report-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });

  if (result.canceled) return null;

  const folderPath = result.filePaths[0];
  const vendorType = detectVendorType(folderPath);

  try {
    if (vendorType === "vendor2") {
      await renameVendor2XrayFiles(folderPath);
    } else if (vendorType === "vendor1") {
      await renameVendor1XrayFiles(folderPath);
    }
  } catch (err) {
    console.warn("Auto-rename on select error:", err.message);
  }

  return folderPath;
});

ipcMain.handle("rename-xray-files", async (_event, payload) => {
  return renameXrayFilesByMode(payload?.mode, payload?.reportRootPath);
});

ipcMain.handle("detect-vendor-type", async (_event, reportRootPath) => {
  return detectVendorType(reportRootPath);
});

ipcMain.handle("start-watching-folder", async (_event, reportRootPath) => {
  await startWatchingFolder(reportRootPath);
  return true;
});

ipcMain.handle("stop-watching-folder", async () => {
  await closeFolderWatcher();
  return true;
});

app.whenReady().then(() => {
  createWindow();

  try {
    tray = new Tray(path.join(__dirname, "x-ray.png"));

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "เปิดโปรแกรม",
        click: () => {
          showMainWindow();
        },
      },
      {
        label: "ออกจากโปรแกรม",
        click: async () => {
          isQuitting = true;
          await closeFolderWatcher();
          app.quit();
        },
      },
    ]);

    tray.setToolTip("Xray Renamer");
    tray.setContextMenu(contextMenu);
    tray.on("click", () => {
      showMainWindow();
    });
  } catch (err) {
    console.warn("Tray initialization failed:", err.message);
  }
});

app.on("before-quit", async () => {
  isQuitting = true;
  await closeFolderWatcher();
});

app.on("window-all-closed", (e) => {
  if (!isQuitting) {
    e.preventDefault();
    return;
  }
});