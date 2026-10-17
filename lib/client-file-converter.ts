import { PDFDocument } from "pdf-lib";
import { reportClientError } from "./client-log";

// Not imported from lib/store.ts's PrintSettingsSnapshot on purpose — this
// file is bundled into the browser (see PdfPageSelector.tsx's import of it),
// and store.ts pulls in the service-role Supabase client. PdfPageSelector.tsx
// already keeps its own local `Layout` type for the same client/server
// boundary reason; this mirrors that.
type Layout = "portrait" | "landscape";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const SAFE_MARGIN = 15;
const DOCX_MARGIN = 24;
const DOCX_FONT_SIZE = 11;
const DOCX_LINE_HEIGHT = 16;
const DOCX_CHARS_PER_PAGE_ESTIMATE = 2800;
const DOCX_PAGE_COUNT_RATIO_WARNING = 2;

export interface ConvertedFile {
  bytes: Uint8Array;
  warnings: string[];
}

const isPdf = (file: File) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
export const isDocx = (file: File) => file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || file.name.toLowerCase().endsWith(".docx");
const isHeic = (file: File) => ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"].includes(file.type) || /\.(heic|heif)$/i.test(file.name);
export const isImageFile = (file: File) => file.type.startsWith("image/") || isHeic(file) || /\.(png|jpe?g|webp)$/i.test(file.name);

async function decodeImage(blob: Blob) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      // Fall through to the HTML image decoder for browsers with partial bitmap support.
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function imageToPdf(file: File, layout: Layout) {
  let imageBlob: Blob = file;
  if (isHeic(file)) {
    const { default: heic2any } = await import("heic2any");
    const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
    imageBlob = Array.isArray(converted) ? converted[0] : converted;
  }

  const image = await decodeImage(imageBlob);
  const imageWidth = image.width;
  const imageHeight = image.height;
  if (!imageWidth || !imageHeight) throw new Error("The camera image has no readable dimensions.");

  // The requested layout picks the canvas shape up front, rather than
  // always using a fixed portrait A4 canvas and leaving the server's later
  // whole-page rotation (extractSelectedPages) to fix it up. That older
  // two-step path scaled a wide photo down to fit the *narrower* portrait
  // dimension first — a correct later rotation could then only rotate an
  // already-shrunk, letterboxed image sideways, never actually fill a
  // proper landscape page with it. Deciding the shape here, before the
  // image gets scaled at all, is the only point in the pipeline that still
  // has the source image's real dimensions to make that call with.
  const pageWidth = layout === "landscape" ? A4_HEIGHT : A4_WIDTH;
  const pageHeight = layout === "landscape" ? A4_WIDTH : A4_HEIGHT;

  const scale = Math.min((pageWidth - SAFE_MARGIN * 2) / imageWidth, (pageHeight - SAFE_MARGIN * 2) / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * 2));
  canvas.height = Math.max(1, Math.round(height * 2));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Your browser could not create an image canvas.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const jpegBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    canvas.toBlob((blob: Blob | null) => blob ? blob.arrayBuffer().then(resolve).catch(reject) : reject(new Error("Could not encode the camera image.")), "image/jpeg", 0.92);
  });
  // pdf-lib's own calls (create/embedJpg/addPage/save), wrapped — a bundling
  // or library-internal failure here must never surface as a raw string
  // like "PDFHeader_1.default.forVersion is not a function" to the
  // customer; see lib/pdf-merge.ts's identical reasoning for its own
  // pdf-lib calls.
  try {
    const pdfDocument = await PDFDocument.create();
    const embeddedImage = await pdfDocument.embedJpg(jpegBytes);
    const page = pdfDocument.addPage([pageWidth, pageHeight]);
    page.drawImage(embeddedImage, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
    if ("close" in image && typeof image.close === "function") image.close();
    return { bytes: await pdfDocument.save(), warnings: [] };
  } catch (pdfLibError) {
    reportClientError("image-to-pdf-failed", pdfLibError, { fileType: file.type });
    throw new Error("We couldn't process this file, please try again.");
  }
}

function readFileAsArrayBuffer(file: File) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error("The document could not be read as binary data."));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("The document could not be read."));
    reader.onabort = () => reject(new Error("The document read was cancelled."));
    reader.readAsArrayBuffer(file);
  });
}

async function docxToPdf(file: File): Promise<ConvertedFile> {
  const [mammothModule, { jsPDF }] = await Promise.all([
    import("mammoth/mammoth.browser"),
    import("jspdf"),
  ]);
  const mammoth = mammothModule.default ?? mammothModule;
  const arrayBuffer = await readFileAsArrayBuffer(file);
  const { value: rawText, messages } = await mammoth.extractRawText({ arrayBuffer });
  const value = rawText
    .replace(/ /g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();

  if (!value || /(?:PK[\x03\x04]|<w:[^>]+>|word\/document\.xml)/i.test(value)) {
    throw new Error("The Word document could not be parsed into readable text.");
  }

  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(DOCX_FONT_SIZE);
  const lines = value.split("\n").flatMap((paragraph) => {
    const wrapped = pdf.splitTextToSize(paragraph || " ", A4_WIDTH - DOCX_MARGIN * 2);
    return wrapped.length > 0 ? wrapped : [" "];
  });
  let y = DOCX_MARGIN + DOCX_LINE_HEIGHT;
  let linesOnPage = 0;
  let pageCount = 1;
  for (const line of lines) {
    if (y > A4_HEIGHT - DOCX_MARGIN || linesOnPage >= 48) {
      pdf.addPage("a4", "p");
      y = DOCX_MARGIN + DOCX_LINE_HEIGHT;
      linesOnPage = 0;
      pageCount += 1;
    }
    pdf.text(line, DOCX_MARGIN, y);
    y += DOCX_LINE_HEIGHT;
    linesOnPage += 1;
  }

  const warnings = (messages as { message: string }[]).map((message) => message.message);
  const expectedPageCount = Math.max(1, Math.round(value.length / DOCX_CHARS_PER_PAGE_ESTIMATE));
  if (pageCount > expectedPageCount * DOCX_PAGE_COUNT_RATIO_WARNING || expectedPageCount > pageCount * DOCX_PAGE_COUNT_RATIO_WARNING) {
    warnings.push(`The converted page count (${pageCount}) looks very different from the original document's text length — tables, images, or formatting may not have converted cleanly.`);
  }

  return { bytes: new Uint8Array(pdf.output("arraybuffer")), warnings };
}

export async function convertFileInBrowser(file: File, layout: Layout): Promise<ConvertedFile> {
  if (isPdf(file)) return { bytes: new Uint8Array(await file.arrayBuffer()), warnings: [] };
  if (isDocx(file)) return docxToPdf(file);
  if (isImageFile(file)) return imageToPdf(file, layout);
  throw new Error("Unsupported file. Upload a PDF, PNG, JPG, JPEG, WEBP, HEIC, HEIF, or DOCX file.");
}

export function isSupportedClientFile(file: File) {
  return isPdf(file) || isDocx(file) || isImageFile(file);
}
