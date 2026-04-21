const fs = require("fs");
const path = require("path");
const Tesseract = require("tesseract.js");

async function main() {
  const dir = "C:\\valentine\\tester_folder_vendor2";
  const file = "vendor2_xray_01.jpg";
  const filePath = path.join(dir, file);

  const result = await Tesseract.recognize(filePath, "eng");
  const text = result.data.text || "";
  const matches = text.match(/\d{4,}/g) || [];
  const hn = matches.sort((a, b) => b.length - a.length)[0];

  console.log("OCR TEXT:");
  console.log(text);
  console.log("HN:", hn);

  const extension = path.extname(file);
  const targetPath = path.join(dir, `${hn}${extension}`);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }

  fs.renameSync(filePath, targetPath);
  console.log("RENAMED TO:", targetPath);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
