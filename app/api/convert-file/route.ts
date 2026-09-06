import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { NextResponse } from "next/server";

const execFileAsync = promisify(execFile);
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const SAFE_MARGIN = 20 * 72 / 96;
const SUPPORTED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export const runtime = "nodejs";

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function imageToPdf(bytes: Uint8Array, contentType: string) {
  const document = await PDFDocument.create();
  const image = contentType === "image/png" ? await document.embedPng(bytes) : await document.embedJpg(bytes);
  const availableWidth = A4_WIDTH - SAFE_MARGIN * 2;
  const availableHeight = A4_HEIGHT - SAFE_MARGIN * 2;
  const scale = Math.min(availableWidth / image.width, availableHeight / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const page = document.addPage([A4_WIDTH, A4_HEIGHT]);
  page.drawImage(image, {
    x: (A4_WIDTH - width) / 2,
    y: (A4_HEIGHT - height) / 2,
    width,
    height,
  });
  return document.save();
}

async function docxToPdf(bytes: Uint8Array, fileName: string) {
  const workDirectory = await mkdir(path.join(os.tmpdir(), "oxway-print"), { recursive: true }).then(() => os.tmpdir());
  const jobDirectory = path.join(workDirectory, `job-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(jobDirectory);
  const inputPath = path.join(jobDirectory, fileName);
  await writeFile(inputPath, bytes);

  try {
    const soffice = process.env.LIBREOFFICE_PATH || "soffice";
    await execFileAsync(soffice, ["--headless", "--convert-to", "pdf", "--outdir", jobDirectory, inputPath], { timeout: 60_000 });
    const outputPath = path.join(jobDirectory, `${path.basename(fileName, path.extname(fileName))}.pdf`);
    return new Uint8Array(await readFile(outputPath));
  } finally {
    await rm(jobDirectory, { recursive: true, force: true });
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return jsonError("No file was uploaded.");
    if (file.size > MAX_FILE_SIZE) return jsonError("Files must be 25 MB or smaller.");

    const extension = path.extname(file.name).toLowerCase();
    const contentType = file.type || (extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "");
    const isDocx = extension === ".docx" || contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const isPdf = extension === ".pdf" || contentType === "application/pdf";
    const isPng = extension === ".png" || contentType === "image/png";
    const isJpeg = [".jpg", ".jpeg"].includes(extension) || ["image/jpeg", "image/jpg"].includes(contentType);
    if (!SUPPORTED_TYPES.has(contentType) && !isDocx && !isPdf && !isPng && !isJpeg) {
      return jsonError("Unsupported file type. Upload a PDF, PNG, JPG, JPEG, or DOCX file.");
    }

    const inputBytes = new Uint8Array(await file.arrayBuffer());
    const pdfBytes = isPdf ? inputBytes : isPng || isJpeg ? await imageToPdf(inputBytes, isPng ? "image/png" : "image/jpeg") : await docxToPdf(inputBytes, file.name);
    const pdf = await PDFDocument.load(pdfBytes);
    const response = new NextResponse(Buffer.from(pdfBytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${path.basename(file.name, extension)}.pdf"`,
        "X-Page-Count": String(pdf.getPageCount()),
        "Cache-Control": "no-store",
      },
    });
    return response;
  } catch (error) {
    console.error("File conversion error:", error);
    const message = error instanceof Error && error.message.includes("ENOENT")
      ? "DOCX conversion requires LibreOffice. Install it or set LIBREOFFICE_PATH."
      : error instanceof Error ? error.message : "Unable to convert this file.";
    return jsonError(message, 500);
  }
}
