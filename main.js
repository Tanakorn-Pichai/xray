const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const { imageSize } = require("image-size");

let mainWindow = null;
let folderWatcher = null;
let isQuitting = false;
let processingQueue = Promise.resolve();
let isInitialScanRunning = false;
let currentHnConfig = null;

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".bmp",
  ".tif",
  ".tiff",
  ".webp",
]);

const GENERATED_PATH_TTL_MS = 10 * 60 * 1000; // 10 นาที
const generatedPaths = new Map(); // resolvedPath -> expiry timestamp
const processingFiles = new Set();

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

function isValidHNFormat(code) {
  return /^[A-Z]{2,3}\d+$/.test(String(code || "").toUpperCase());
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

function normalizeOcrText(rawText) {
  const upperText = String(rawText || "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/S/g, "5");

  const ocrFriendlyText = upperText.replace(
    /D\s*[AXK\/\\|]?\s*([0-9ZEGSBU][0-9\s\-_.:ZEGSBU]{3,})/g,
    (_match, digits) =>
      `DX${digits
        .replace(/[ZEGSBU]/g, (ch) => ({
          Z: "2",
          E: "6",
          G: "6",
          S: "5",
          B: "8",
          U: "0",
        })[ch] || ch)
        .replace(/\D/g, "")}`,
  );

  const repairedDxText = ocrFriendlyText.replace(
    /D\s*[XK\/\\|¥]\s*(\d[\d\s\-_.:]{3,})/g,
    (_match, digits) => `DX${digits.replace(/\D/g, "")}`,
  );

  return repairedDxText.replace(/[^A-Z0-9]/g, "");
}

function extractHN(rawText) {
  if (!rawText) return null;

  const text = normalizeOcrText(rawText);

  if (!text) return null;

  const dxMatch = text.match(/DX\d{4,}/);
  if (dxMatch) return dxMatch[0];

  const candidates = text.match(/[A-Z]{2,3}\d{4,}/g) || [];
  if (candidates.length === 0) return null;

  return candidates.sort((a, b) => b.length - a.length)[0];
}

function buildRegexFromRows(rows, capture) {
  const groups = (rows || []).map((r) => {
    if (r.type === "digit") return `\\d{${r.count}}`;
    if (r.type === "custom" && r.chars) {
      const escaped = r.chars.replace(/[^A-Z0-9]/g, "");
      if (!escaped) return `[A-Z]{${r.count}}`;
      return `[${escaped.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}]{${r.count}}`;
    }
    return `[A-Z]{${r.count}}`;
  });
  const inner = groups.join("");
  return capture ? `(${inner})` : inner;
}

function hasCustomRows(rows) {
  return (rows || []).some((r) => r.type === "custom" && r.chars);
}

function getCustomChars(rows) {
  return (rows || [])
    .filter((r) => r.type === "custom" && r.chars)
    .map((r) => r.chars)
    .join("");
}

function extractHNWithConfig(rawText, hnConfig) {
  if (!rawText) return { hn: null, customNotFound: false };

  const rows = hnConfig?.rows;
  if (!rows || rows.length === 0) return { hn: null, customNotFound: false };

  const text = normalizeOcrText(rawText);

  if (!text) return { hn: null, customNotFound: false };

  const patternStr = buildRegexFromRows(rows, false);
  const pattern = new RegExp(patternStr, "g");

  let candidates = text.match(pattern) || [];
  const dxMatch = text.match(/DX\d{4,}/);
  if (dxMatch && new RegExp(`^${patternStr}$`).test(dxMatch[0])) {
    candidates = [dxMatch[0], ...candidates];
  }
  if (candidates.length === 0) {
    return { hn: null, customNotFound: hasCustomRows(rows) };
  }

  const bestHN = candidates.sort((a, b) => b.length - a.length)[0];

  if (hasCustomRows(rows)) {
    const customChars = getCustomChars(rows);
    const upperHN = bestHN.toUpperCase();
    const allFound = customChars.split("").every((ch) => upperHN.includes(ch));
    if (!allFound) {
      return { hn: null, customNotFound: true };
    }
  }

  return { hn: bestHN, customNotFound: false };
}

function isValidHNFormatWithConfig(code, hnConfig) {
  const rows = hnConfig?.rows;
  if (!rows || rows.length === 0) return false;

  const upper = String(code || "").toUpperCase();
  const regexStr = buildRegexFromRows(rows, false);
  const regex = new RegExp(`^${regexStr}$`);

  return regex.test(upper);
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
  return /^[A-Z]{2,3}\d{4,}(?:_\d+)?$/.test(upper);
}

function calculateCropArea(width, height, hnConfig) {
  const cropPctW = hnConfig?.cropW ?? 0.15;
  const cropPctH = hnConfig?.cropH ?? 0.04;
  const cropW = Math.max(1, Math.floor(width * cropPctW));
  const cropH = Math.max(1, Math.floor(height * cropPctH));

  const cropX = hnConfig?.cropX ?? 0.075;
  const cropY = hnConfig?.cropY ?? 0.11;

  const left = Math.max(0, Math.min(width - cropW, Math.floor(cropX * width - cropW / 2)));
  const top = Math.max(0, Math.min(height - cropH, Math.floor(cropY * height - cropH / 2)));

  return { left, top, width: cropW, height: cropH };
}

function calculateTopLeftTextArea(width, height) {
  return {
    left: 0,
    top: 0,
    width: Math.max(1, Math.floor(width * 0.18)),
    height: Math.max(1, Math.floor(height * 0.2)),
  };
}

function calculateWideTopLeftTextArea(width, height) {
  return {
    left: 0,
    top: 0,
    width: Math.max(1, Math.floor(width * 0.38)),
    height: Math.max(1, Math.floor(height * 0.25)),
  };
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

  const worker = await Tesseract.createWorker("eng");
  try {
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
    });
    return await worker.recognize(imagePath);
  } finally {
    await worker.terminate();
  }
}

function getOcrFilters(hnConfig) {
  return {
    threshold: hnConfig?.threshold ?? 255,
    brightness: hnConfig?.brightness ?? 0,
    contrast: hnConfig?.contrast ?? 1,
    sharpen: hnConfig?.sharpen ?? 0.8,
    normalize: hnConfig?.normalize ?? true,
  };
}

function withLabelOcrFilters(hnConfig) {
  const threshold = hnConfig?.threshold;
  return {
    ...(hnConfig || {}),
    threshold: typeof threshold === "number" && threshold < 255 ? threshold : 140,
    normalize: hnConfig?.normalize ?? true,
  };
}

function withContrastLabelOcrFilters(hnConfig) {
  return {
    ...(hnConfig || {}),
    threshold: 255,
    brightness: -80,
    contrast: 2,
    sharpen: 1,
    normalize: true,
  };
}

async function extractHnFromCrop(imagePath, cropArea, tempSuffix, hnConfig = null) {
  let tempFile = null;

  try {
    tempFile = `${imagePath}${tempSuffix}`;
    const filters = getOcrFilters(hnConfig);

    let pipeline = sharp(imagePath)
      .extract(cropArea)
      .resize(
        Math.max(1, cropArea.width * 10),
        Math.max(1, cropArea.height * 10),
        { fit: "fill" },
      )
      .grayscale();

    if (filters.normalize) {
      pipeline = pipeline.normalize();
    }

    if (filters.brightness !== 0 || filters.contrast !== 1) {
      pipeline = pipeline.linear(filters.contrast, filters.brightness);
    }

    if (filters.sharpen > 0) {
      pipeline = pipeline.sharpen({ sigma: filters.sharpen });
    }

    if (filters.threshold < 255) {
      pipeline = pipeline.threshold(filters.threshold);
    }

    await pipeline.toFile(tempFile);

    const ocr = await runOCR(tempFile);
    const text = ocr?.data?.text || "";
    console.log("[OCR DEBUG] tempFile:", tempFile, "→ text:", JSON.stringify(text));

    let normalizedHn;
    if (hnConfig) {
      const extractResult = extractHNWithConfig(text, hnConfig);
      normalizedHn = normalizeHN(extractResult.hn);
      const valid = isValidHNFormatWithConfig(normalizedHn, hnConfig);
      return {
        hn: valid ? normalizedHn : null,
        customNotFound: !valid && extractResult.customNotFound,
        customChars: !valid && extractResult.customNotFound ? getCustomChars(hnConfig.rows) : null,
        text,
      };
    } else {
      normalizedHn = normalizeHN(extractHN(text));
      return {
        hn: isValidHNFormat(normalizedHn) ? normalizedHn : null,
        text,
      };
    }
  } finally {
    if (tempFile) {
      // await safeUnlink(tempFile);
    }
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

async function processVendor2ImageFile(reportRootPath, imagePath, hnConfig = null) {
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

    const cropArea = calculateCropArea(width, height, hnConfig);

    let extracted = await extractHnFromCrop(
      imageFile.path,
      cropArea,
      "_vendor2_ocr.jpg",
      hnConfig,
    );

    if (!extracted.hn) {
      const labelArea = calculateTopLeftTextArea(width, height);
      const fallbackExtracted = await extractHnFromCrop(
        imageFile.path,
        labelArea,
        "_vendor2_label_ocr.jpg",
        withLabelOcrFilters(hnConfig),
      );

      if (fallbackExtracted.hn || !extracted.text) {
        extracted = fallbackExtracted;
      } else {
        extracted = {
          ...extracted,
          customNotFound: extracted.customNotFound || fallbackExtracted.customNotFound,
          customChars: extracted.customChars || fallbackExtracted.customChars,
          text: `${extracted.text}\n${fallbackExtracted.text || ""}`,
        };
      }
    }

    if (!extracted.hn) {
      const wideLabelArea = calculateWideTopLeftTextArea(width, height);
      const contrastExtracted = await extractHnFromCrop(
        imageFile.path,
        wideLabelArea,
        "_vendor2_label_contrast_ocr.jpg",
        withContrastLabelOcrFilters(hnConfig),
      );

      if (contrastExtracted.hn || !extracted.text) {
        extracted = contrastExtracted;
      } else {
        extracted = {
          ...extracted,
          customNotFound: extracted.customNotFound || contrastExtracted.customNotFound,
          customChars: extracted.customChars || contrastExtracted.customChars,
          text: `${extracted.text}\n${contrastExtracted.text || ""}`,
        };
      }
    }

    const text = extracted.text;
    const hn = extracted.hn;

    if (!hn && extracted.customNotFound && extracted.customChars) {
      const backupFile = path.join(backupPath, imageFile.name);
      if (!fs.existsSync(backupFile)) {
        fs.copyFileSync(imageFile.path, backupFile);
        markGeneratedPath(backupFile);
      }

      const incompleteName = `${extracted.customChars}ไม่สมบูรณ์`;
      const incompleteResult = renameUsingHN(path.dirname(imageFile.path), imageFile, incompleteName, {
        mode: "vendor2",
        ocrPreview: text.slice(0, 100),
        isIncomplete: true,
      });

      return {
        type: "renamed",
        item: {
          original: imageFile.name,
          newName: incompleteResult.item?.newName || `${incompleteName}${path.extname(imageFile.name)}`,
          path: incompleteResult.item?.path || imageFile.path,
          ocrPreview: text.slice(0, 100),
          isIncomplete: true,
        },
      };
    }

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
      markGeneratedPath(backupFile);
    }

    const result = renameUsingHN(path.dirname(imageFile.path), imageFile, hn, {
      mode: "vendor2",
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

    const cropArea = {
      left: 0,
      top: 0,
      width: Math.max(1, Math.floor(width * 0.45)),
      height: Math.max(1, Math.floor(height * 0.35)),
    };

    const extracted = await extractHnFromCrop(
      imageFile.path,
      cropArea,
      "_fallback_ocr.jpg",
    );

    const text = extracted.text;
    const hn = extracted.hn;

    if (!hn) {
      return {
        type: "skipped",
        item: {
          reason: "OCR แบบค่าย 1 ไม่พบ HN",
          path: imageFile.path,
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

async function processAutoImageFile(reportRootPath, imagePath, hnConfig = null) {
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
    return await processVendor1ImageFileFromContext(reportRootPath, imagePath, ctx);
  }

  const vendor2Result = await processVendor2ImageFile(reportRootPath, imagePath, hnConfig);
  if (vendor2Result.type === "renamed") {
    return vendor2Result;
  }

  return processVendor1LikeImageByOCR(reportRootPath, imagePath);
}

async function renameAutoXrayFiles(reportRootPath, hnConfig = null) {
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
    const result = await processAutoImageFile(reportRootPath, imageFile.path, hnConfig);

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

async function renameVendor2XrayFiles(reportRootPath, specificFile = null, hnConfig = null) {
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
    const result = await processVendor2ImageFile(reportRootPath, imageFile.path, hnConfig);

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

async function renameXrayFilesByMode(mode, reportRootPath, hnConfig = null) {
  currentHnConfig = hnConfig;

  if (mode === "vendor1") {
    return renameVendor1XrayFiles(reportRootPath);
  }

  if (mode === "vendor2") {
    return renameVendor2XrayFiles(reportRootPath, null, hnConfig);
  }

  return renameAutoXrayFiles(reportRootPath, hnConfig);
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
    return await processAutoImageFile(reportRootPath, filePath, currentHnConfig);
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

async function runInitialAutoScan(reportRootPath, hnConfig = null) {
  isInitialScanRunning = true;
  currentHnConfig = hnConfig;
  try {
    return await renameAutoXrayFiles(reportRootPath, hnConfig);
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
  return renameXrayFilesByMode(payload?.mode || "auto", payload?.reportRootPath, payload?.hnConfig || null);
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

ipcMain.handle("run-initial-auto-scan", async (_event, reportRootPath, hnConfig) => {
  return runInitialAutoScan(reportRootPath, hnConfig);
});

app.whenReady().then(() => {
  createWindow();
});

app.on("before-quit", async () => {
  isQuitting = true;
  await closeFolderWatcher();
});

app.on("window-all-closed", () => {
  app.quit();
});
