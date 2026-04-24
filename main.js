const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const { imageSize } = require("image-size");

let mainWindow = null;
let tray = null;
let folderWatcher = null;
let isQuitting = false;
let processingQueue = Promise.resolve();
let isInitialScanRunning = false;

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

const GENERATED_PATH_TTL_MS = 10 * 60 * 1000; // 10 นาที
const generatedPaths = new Map(); // resolvedPath -> expiry timestamp
const processingFiles = new Set();

function createTray() {
  const iconPath = path.join(__dirname, "x-ray.png");
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Xray",
      click: () => {
        showMainWindow();
      },
    },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Xray OCR");
  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    showMainWindow();
  });
}

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

function walkImageFilesRecursive(targetPath, collected = []) {
  if (!isDirectory(targetPath)) {
    return collected;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(targetPath, { withFileTypes: true });
  } catch {
    return collected;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "Backup" || entry.name.includes("_ocr")) continue;
      walkImageFilesRecursive(fullPath, collected);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
        collected.push({
          name: entry.name,
          path: fullPath,
        });
      }
    }
  }

  return collected;
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

function extractNumericHN(rawText) {
  const normalizedText = String(rawText || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedText) return null;

  const matches = normalizedText.match(/\d{4,}/g);
  if (!matches || matches.length === 0) return null;

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

function isBackupPath(filePath) {
  return filePath.split(path.sep).includes("Backup");
}

function isOcrTempPath(filePath) {
  return String(filePath).toLowerCase().includes("_ocr");
}

function isGeneratedPath(filePath) {
  const resolved = path.resolve(filePath);
  const expiresAt = generatedPaths.get(resolved);

  if (!expiresAt) return false;

  if (Date.now() > expiresAt) {
    generatedPaths.delete(resolved);
    return false;
  }

  return true;
}

function markGeneratedPath(filePath, ttlMs = GENERATED_PATH_TTL_MS) {
  const resolved = path.resolve(filePath);
  generatedPaths.set(resolved, Date.now() + ttlMs);

  const timer = setTimeout(() => {
    generatedPaths.delete(resolved);
  }, ttlMs + 1000);

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

function normalizePathSafe(targetPath) {
  try {
    return path.resolve(targetPath);
  } catch {
    return targetPath;
  }
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

function getImageOrientation(width, height) {
  if (!width || !height) return "portrait";

  const ratio = width / height;

  // แนวนอนจริง ๆ เท่านั้น
  // ถ้าเป็นภาพที่เกือบตั้งหรือกึ่งตั้ง ให้ยังใช้ crop เดิม
  return ratio >= 1.15 ? "landscape" : "portrait";
}

function buildVendor2CropArea(width, height, orientation) {
  if (orientation === "landscape") {
    return {
      left: 0,
      top: Math.max(1, Math.floor(height * 0.04)),
      width: Math.max(1, Math.floor(width * 0.30)),
      height: Math.max(1, Math.floor(height * 0.16)),
    };
  }

  return {
    left: 0,
    top: Math.floor(height * 0.09),
    width: Math.max(1, Math.floor(width * 0.15)),
    height: Math.max(1, Math.floor(height * 0.04)),
  };
}

function buildFallbackCropArea(width, height, orientation) {
  if (orientation === "landscape") {
    return {
      left: 0,
      top: Math.max(1, Math.floor(height * 0.02)),
      width: Math.max(1, Math.floor(width * 0.45)),
      height: Math.max(1, Math.floor(height * 0.22)),
    };
  }

  return {
    left: 0,
    top: 0,
    width: Math.max(1, Math.floor(width * 0.45)),
    height: Math.max(1, Math.floor(height * 0.35)),
  };
}

async function extractHnFromCrop(imagePath, cropArea, tempSuffix) {
  let tempFile = null;

  try {
    tempFile = `${imagePath}${tempSuffix}`;

    await sharp(imagePath)
      .extract(cropArea)
      .resize(
        Math.max(1, cropArea.width * 10),
        Math.max(1, cropArea.height * 10),
      )
      .grayscale()
      .normalize()
      .sharpen({ sigma: 2.5 })
      .modulate({ contrast: 10, brightness: 0.2 })
      .negate()
      .toFile(tempFile);

    const ocr = await runOCR(tempFile);
    const text = ocr?.data?.text || "";

    return {
      hn: normalizeHN(extractHN(text) || extractNumericHN(text)),
      text,
    };
  } finally {
    if (tempFile) {
      // await safeUnlink(tempFile);
    }
  }
}

async function extractHnByOrientation(imagePath, width, height, mode = "vendor2") {
  const orientation = getImageOrientation(width, height);

  if (mode === "vendor2") {
    const cropArea = buildVendor2CropArea(width, height, orientation);

    if (orientation === "landscape") {
      return extractHnFromCrop(imagePath, cropArea, "_vendor2_ocr_landscape.jpg");
    }

    return extractHnFromCrop(imagePath, cropArea, "_vendor2_ocr.jpg");
  }

  const cropArea = buildFallbackCropArea(width, height, orientation);

  if (orientation === "landscape") {
    return extractHnFromCrop(imagePath, cropArea, "_fallback_ocr_landscape.jpg");
  }

  return extractHnFromCrop(imagePath, cropArea, "_fallback_ocr.jpg");
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

function hasVendor1Structure(reportRootPath) {
  if (!reportRootPath || !isDirectory(reportRootPath)) return false;

  const topLevelDirs = getDirectories(reportRootPath);
  for (const dir of topLevelDirs) {
    const subDirs = getDirectories(dir.path);
    if (subDirs.length > 0) {
      for (const subDir of subDirs) {
        const petFolders = getDirectories(subDir.path);
        if (petFolders.length > 0) {
          for (const petFolder of petFolders) {
            const images = getImageFiles(petFolder.path);
            if (images.length > 0) {
              return true;
            }
          }
        }
      }
    }
  }

  return false;
}

function hasRootImages(reportRootPath) {
  if (!reportRootPath || !isDirectory(reportRootPath)) return false;
  return getImageFiles(reportRootPath).some(
    (file) => !isBackupPath(file.path) && !isOcrTempPath(file.path),
  );
}

function detectVendorType(reportRootPath) {
  if (!reportRootPath || !isDirectory(reportRootPath)) {
    return null;
  }

  const rootImages = hasRootImages(reportRootPath);
  const vendor1Structure = hasVendor1Structure(reportRootPath);

  if (rootImages && vendor1Structure) return "mixed";
  if (rootImages) return "vendor2";
  if (vendor1Structure) return "vendor1";

  return null;
}

function renameUsingHN(directoryPath, imageFile, hn, metadata = {}) {
  const extension = path.extname(imageFile.name);
  const nameWithoutExt = path.parse(imageFile.name).name;

  if (isAlreadyTargetFile(nameWithoutExt, hn)) {
    return {
      type: "skipped",
      item: { reason: "ชื่อไฟล์ตรงกับรหัสแล้ว", path: imageFile.path },
    };
  }

  const uniqueTarget = buildUniqueFilePath(directoryPath, hn, extension);

  markGeneratedPath(imageFile.path);
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

async function processVendor1ImageFileFromContext(
  reportRootPath,
  imagePath,
  ctx,
) {
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

  const hn = normalizeHN(ctx.hnFolderName.trim()) || ctx.hnFolderName.trim();

  const imageFile = {
    name: path.basename(imagePath),
    path: imagePath,
  };

  if (isAlreadyTargetFile(path.parse(imageFile.name).name, hn)) {
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
      markGeneratedPath(backupFile);
    }

    const result = renameUsingHN(ctx.petFolderPath, imageFile, hn, {
      mode: "vendor1",
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

  try {
    await new Promise((r) => setTimeout(r, 800));

    const buffer = fs.readFileSync(imageFile.path);
    const { width, height } = imageSize(buffer);
    const orientation = getImageOrientation(width, height);

    const extracted = await extractHnByOrientation(
      imageFile.path,
      width,
      height,
      "vendor2",
    );

    const text = extracted.text;
    const hn = extracted.hn;

    if (!hn) {
      return {
        type: "skipped",
        item: {
          reason: "OCR หา HN ไม่พบ",
          path: imageFile.path,
          orientation,
          ocrPreview: text.slice(0, 100),
        },
      };
    }

    const backupFile = path.join(backupPath, imageFile.name);
    if (!fs.existsSync(backupFile)) {
      fs.copyFileSync(imageFile.path, backupFile);
      markGeneratedPath(backupFile);
    }

    const result = renameUsingHN(path.dirname(imageFile.path), imageFile, hn, {
      mode: "vendor2",
      orientation,
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
  }
}

async function processVendor1LikeImageByOCR(reportRootPath, imagePath) {
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

  const backupPath = path.join(reportRootPath, "Backup");
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath, { recursive: true });
  }

  try {
    const buffer = fs.readFileSync(imageFile.path);
    const { width, height } = imageSize(buffer);
    const orientation = getImageOrientation(width, height);

    const extracted = await extractHnByOrientation(
      imageFile.path,
      width,
      height,
      "fallback",
    );

    const text = extracted.text;
    const hn = extracted.hn;

    if (!hn) {
      return {
        type: "skipped",
        item: {
          reason: "OCR แบบค่าย 1 ไม่พบ HN",
          path: imageFile.path,
          orientation,
          ocrPreview: text.slice(0, 100),
        },
      };
    }

    const backupFile = path.join(backupPath, imageFile.name);
    if (!fs.existsSync(backupFile)) {
      fs.copyFileSync(imageFile.path, backupFile);
      markGeneratedPath(backupFile);
    }

    const result = renameUsingHN(path.dirname(imageFile.path), imageFile, hn, {
      mode: "vendor1",
      source: "ocr-fallback",
      orientation,
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
  }
}

async function processAutoImageFile(reportRootPath, imagePath) {
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
  if (ctx) {
    return processVendor1ImageFileFromContext(reportRootPath, imagePath, ctx);
  }

  const vendor2Result = await processVendor2ImageFile(reportRootPath, imagePath);
  if (vendor2Result.type === "renamed") {
    return vendor2Result;
  }

  return processVendor1LikeImageByOCR(reportRootPath, imagePath);
}

async function renameAutoXrayFiles(reportRootPath) {
  if (!reportRootPath || !isDirectory(reportRootPath)) {
    throw new Error("ไม่พบโฟลเดอร์ root");
  }

  const imageFiles = walkImageFilesRecursive(reportRootPath).filter(
    (file) =>
      !isBackupPath(file.path) &&
      !isOcrTempPath(file.path) &&
      !isGeneratedPath(file.path),
  );

  const renamedItems = [];
  const skippedItems = [];

  for (const imageFile of imageFiles) {
    const result = await processAutoImageFile(reportRootPath, imageFile.path);

    if (result.type === "renamed") {
      renamedItems.push(result.item);
    } else if (result.item) {
      skippedItems.push(result.item);
    }
  }

  return {
    mode: "auto",
    reportRootPath,
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
    const ctx = resolveVendor1ContextFromFilePath(reportRootPath, specificFile);
    if (!ctx) {
      return {
        mode: "vendor1",
        reportRootPath,
        renamedItems,
        skippedItems: [
          { reason: "ไฟล์นี้ไม่อยู่ในโครงสร้างค่าย 1", path: specificFile },
        ],
      };
    }

    const result = await processVendor1ImageFileFromContext(
      reportRootPath,
      specificFile,
      ctx,
    );

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

  const imageFiles = walkImageFilesRecursive(reportRootPath).filter((file) => {
    const ctx = resolveVendor1ContextFromFilePath(reportRootPath, file.path);
    return Boolean(ctx);
  });

  for (const imageFile of imageFiles) {
    const ctx = resolveVendor1ContextFromFilePath(reportRootPath, imageFile.path);
    if (!ctx) continue;

    const result = await processVendor1ImageFileFromContext(
      reportRootPath,
      imageFile.path,
      ctx,
    );

    if (result.type === "renamed") {
      renamedItems.push(result.item);
    } else if (result.item) {
      skippedItems.push(result.item);
    }
  }

  return {
    mode: "vendor1",
    reportRootPath,
    renamedItems,
    skippedItems,
  };
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
      (file) => !isBackupPath(file.path) && !isOcrTempPath(file.path),
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

async function renameXrayFilesByMode(mode, reportRootPath) {
  if (mode === "vendor1") {
    return renameVendor1XrayFiles(reportRootPath);
  }

  if (mode === "vendor2") {
    return renameVendor2XrayFiles(reportRootPath);
  }

  return renameAutoXrayFiles(reportRootPath);
}

async function enqueueTask(task) {
  processingQueue = processingQueue
    .then(task)
    .catch((err) => {
      console.warn("Processing error:", err.message);
    });

  return processingQueue;
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

async function processFileSafely(reportRootPath, filePath) {
  const resolved = normalizePathSafe(filePath);
  if (processingFiles.has(resolved)) {
    return null;
  }

  processingFiles.add(resolved);

  try {
    return await processAutoImageFile(reportRootPath, filePath);
  } finally {
    processingFiles.delete(resolved);
  }
}

async function handleIncomingFile(reportRootPath, filePath) {
  if (isInitialScanRunning) return;
  if (!filePath) return;

  if (isGeneratedPath(filePath)) return;
  if (isBackupPath(filePath)) return;
  if (isOcrTempPath(filePath)) return;

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
    return;
  }

  await enqueueTask(async () => {
    try {
      const result = await processFileSafely(reportRootPath, filePath);

      if (
        result &&
        result.type === "renamed" &&
        mainWindow &&
        !mainWindow.isDestroyed()
      ) {
        mainWindow.webContents.send("new-image-detected", {
          folderPath: reportRootPath,
          fileName: path.basename(filePath),
          filePath,
        });
      }
    } catch (err) {
      console.warn("Auto-rename error:", err.message);
    }
  });
}

async function startWatchingFolder(reportRootPath) {
  await closeFolderWatcher();

  if (!reportRootPath || !isDirectory(reportRootPath)) {
    return;
  }

  folderWatcher = chokidar.watch(reportRootPath, {
    ignored: /(^|[\/\\])\.|_ocr|Backup/,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1200,
      pollInterval: 100,
    },
  });

  const onFileEvent = (filePath) => {
    handleIncomingFile(reportRootPath, filePath);
  };

  folderWatcher.on("add", onFileEvent);
  folderWatcher.on("change", onFileEvent);
}

async function runInitialAutoScan(reportRootPath) {
  isInitialScanRunning = true;
  try {
    return await renameAutoXrayFiles(reportRootPath);
  } finally {
    isInitialScanRunning = false;
  }
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
    if (isQuitting) return;
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
  return result.filePaths[0];
});

ipcMain.handle("rename-xray-files", async (_event, payload) => {
  return renameXrayFilesByMode(payload?.mode || "auto", payload?.reportRootPath);
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

ipcMain.handle("run-initial-auto-scan", async (_event, reportRootPath) => {
  return runInitialAutoScan(reportRootPath);
});

app.whenReady().then(() => {
  // app.setLoginItemSettings({
  //   openAtLogin: true
  // });

  createWindow();
  createTray();
});

app.on("before-quit", async () => {
  isQuitting = true;
  await closeFolderWatcher();
});

app.on("window-all-closed", (e) => {
  if (!isQuitting) {
    e.preventDefault();
  }
});