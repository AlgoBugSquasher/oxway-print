import { PDFDocument } from "pdf-lib";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const SAFE_MARGIN = 15;

const isPdf = (file: File) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
const isDocx = (file: File) => file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || file.name.toLowerCase().endsWith(".docx");
const isHeic = (file: File) => ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"].includes(file.type) || /\.(heic|heif)$/i.test(file.name);

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

async function imageToPdf(file: File) {
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

  const scale = Math.min((A4_WIDTH - SAFE_MARGIN * 2) / imageWidth, (A4_HEIGHT - SAFE_MARGIN * 2) / imageHeight);
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
  const pdfDocument = await PDFDocument.create();
  const embeddedImage = await pdfDocument.embedJpg(jpegBytes);
  const page = pdfDocument.addPage([A4_WIDTH, A4_HEIGHT]);
  page.drawImage(embeddedImage, { x: (A4_WIDTH - width) / 2, y: (A4_HEIGHT - height) / 2, width, height });
  if ("close" in image && typeof image.close === "function") image.close();
  return pdfDocument.save();
}

async function docxToPdf(file: File) {
  const [{ default: mammoth }, { jsPDF }] = await Promise.all([
    import("mammoth/mammoth.browser"),
    import("jspdf"),
  ]);
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  const lines = pdf.splitTextToSize(value.trim() || "Empty Word document", A4_WIDTH - SAFE_MARGIN * 2);
  let y = SAFE_MARGIN + 14;
  for (const line of lines) {
    if (y > A4_HEIGHT - SAFE_MARGIN) {
      pdf.addPage("a4", "p");
      y = SAFE_MARGIN + 14;
    }
    pdf.text(line, SAFE_MARGIN, y);
    y += 14;
  }
  return new Uint8Array(pdf.output("arraybuffer"));
}

export async function convertFileInBrowser(file: File) {
  if (isPdf(file)) return new Uint8Array(await file.arrayBuffer());
  if (isDocx(file)) return docxToPdf(file);
  if (file.type.startsWith("image/") || isHeic(file) || /\.(png|jpe?g|webp)$/i.test(file.name)) return imageToPdf(file);
  throw new Error("Unsupported file. Upload a PDF, PNG, JPG, JPEG, WEBP, HEIC, HEIF, or DOCX file.");
}

export function isSupportedClientFile(file: File) {
  return isPdf(file) || isDocx(file) || file.type.startsWith("image/") || isHeic(file) || /\.(png|jpe?g|webp)$/i.test(file.name);
}
