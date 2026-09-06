# OXWAY Smart Print Kiosk

A Next.js self-service printing kiosk for PDF, image, and Word document uploads.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Supported Uploads

The kiosk accepts PDF, PNG, JPG/JPEG, WEBP, HEIC/HEIF, and DOCX files up to 25 MB. Images are converted in the browser to centered A4 PDFs with 20px-equivalent safe margins. Existing PDFs keep their actual page count. DOCX files are converted in the browser with Mammoth and jsPDF before thumbnails are rendered.

The Node dependency for image-to-PDF conversion is `pdf-lib`:

```bash
npm install pdf-lib heic2any mammoth jspdf
```

No Python package, LibreOffice installation, or server binary is required. DOCX conversion extracts document text in the browser and lays it out into an A4 PDF. HEIC/HEIF camera photos are converted to JPEG with `heic2any` before image fitting.
