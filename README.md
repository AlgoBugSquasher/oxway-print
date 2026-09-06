# OXWAY Smart Print Kiosk

A Next.js self-service printing kiosk for PDF, image, and Word document uploads.

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Supported Uploads

The kiosk accepts PDF, PNG, JPG/JPEG, and DOCX files up to 25 MB. Images are converted to centered A4 PDFs with 20px-equivalent safe margins. Existing PDFs keep their actual page count. DOCX files are converted with LibreOffice before thumbnails are rendered.

The Node dependency for image-to-PDF conversion is `pdf-lib`:

```bash
npm install pdf-lib
```

No Python package is required.

## DOCX Conversion Setup

DOCX conversion requires LibreOffice on the machine running Next.js:

- Windows: install LibreOffice and add `soffice.exe` to `PATH`, or set `LIBREOFFICE_PATH` in `.env.local`.
- Linux: install `libreoffice` with the system package manager.
- macOS: install LibreOffice with Homebrew and set `LIBREOFFICE_PATH` if needed.

Example Windows setting:

```env
LIBREOFFICE_PATH=C:\\Program Files\\LibreOffice\\program\\soffice.exe
```

The API route is `POST /api/convert-file` and accepts multipart form data with a `file` field. It returns a normalized PDF with an `X-Page-Count` response header.
