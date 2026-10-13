import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { shortRequestId } from "../request-id";
import type { PrintJobRecord } from "../store";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

/** 1 mm in PDF points — pdf-lib (and PDF itself) only ever works in points. */
export const MM_TO_PT = 72 / 25.4;

/**
 * Everything about the Instagram QR footer lives here — resize it, move its
 * margins, or change the caption by editing exactly these values. Nothing
 * below in drawBannerQrBlock should ever need a number that isn't read from
 * here (or from the page's own actual dimensions).
 */
export const BANNER_QR_CONFIG = {
  /** Repo-relative path (joined onto process.cwd() — see loadInstaQrBytes) to the square source QR image. Never edited/recolored/cropped — only ever scaled uniformly. */
  imagePathSegments: ["public", "brand", "insta.png"],
  /** Target width AND height, in mm — the source image is square. */
  sizeMm: 35,
  /** Below this, a camera can no longer reliably decode the code, so the whole block is skipped instead of shrinking further. */
  minSizeMm: 25,
  /** Vertical gap between the QR's bottom edge and the caption's top. */
  gapMm: 3,
  /** Minimum clearance from every page edge for the QR+caption block as a whole — must survive a laser printer's unprintable margin, including under fit-to-page. */
  marginMm: 12,
  /** Minimum clearance this block keeps from any other content already on the banner (in practice, the OXWAY footer line — see prependBannerPage). */
  clearanceMm: 8,
  captionText: "Scan to follow us on Instagram",
  captionSizePt: 10.5,
  /** Floor the caption's font size can shrink to before giving up on fitting it (see the width-measuring loop below) — never shrunk silently past the point of being legible. */
  captionMinSizePt: 7,
  captionColor: rgb(0.2, 0.2, 0.2),
} as const;

function centeredX(font: PDFFont, text: string, size: number, pageWidth: number): number {
  return (pageWidth - font.widthOfTextAtSize(text, size)) / 2;
}

/**
 * Reads public/brand/insta.png once and caches the bytes for the life of
 * this process. Only ever called from prependBannerPage below, which in
 * turn is only ever called from print-agent/index.ts — the website/Vercel
 * never generates the banner at all, so this is a plain Node filesystem
 * read, not something that needs to work inside a Vercel/edge runtime.
 * process.cwd() is the repo root here (see pi/oxway-print-agent.service's
 * own WorkingDirectory), the same way the rest of the print agent already
 * resolves repo-relative paths.
 *
 * Never throws: returns null (and logs once) if the file is missing or
 * unreadable, so a broken/absent image degrades to "banner prints without
 * the QR," never "the print job fails."
 */
let cachedInstaQrBytes: Uint8Array | null | undefined;
async function loadInstaQrBytes(): Promise<Uint8Array | null> {
  if (cachedInstaQrBytes !== undefined) return cachedInstaQrBytes;
  try {
    const filePath = path.join(process.cwd(), ...BANNER_QR_CONFIG.imagePathSegments);
    cachedInstaQrBytes = await readFile(filePath);
  } catch (error) {
    console.warn("Could not read the Instagram QR image — printing the banner without it:", error);
    cachedInstaQrBytes = null;
  }
  return cachedInstaQrBytes;
}

/** Only used by tests, which need to force a fresh (or deliberately failing) read instead of whatever this process already cached. */
export function resetInstaQrCacheForTests(): void {
  cachedInstaQrBytes = undefined;
}

/**
 * Draws the centered Instagram QR + caption at the bottom of a banner page,
 * entirely from that page's own actual width/height — never a hardcoded
 * A4 number — so it keeps working if the banner's size or orientation ever
 * changes. Deliberately a separate, self-contained function (ROADMAP-style
 * requirement: removable/reworkable without touching anything else about
 * the banner) that only draws; it has no file I/O or PDF-embedding
 * responsibility of its own — see prependBannerPage for that half.
 *
 * Shrinks the QR proportionally if the page is tight on room, down to
 * BANNER_QR_CONFIG.minSizeMm; below that floor (or if the caption can't
 * fit even at its own minimum font size) it draws nothing at all, rather
 * than something overlapping or spilling off the page. Never throws —
 * any unexpected drawing error is logged and swallowed, since losing the
 * QR is never worth losing the actual print job over.
 *
 * Returns the finished block's own geometry (all in pt) so the caller can
 * keep its own nearby content at least BANNER_QR_CONFIG.clearanceMm above
 * `topY` — or null when nothing was drawn, meaning there's nothing to
 * avoid. Returning the actual computed numbers (not just "it fit") is also
 * what makes this function's placement independently verifiable in tests,
 * rather than re-deriving the same formula a second time there.
 */
export interface BannerQrBlockGeometry {
  topY: number;
  qr: { x: number; y: number; size: number };
  caption: { x: number; y: number; width: number; size: number };
}

export function drawBannerQrBlock(page: PDFPage, options: { qrImage: PDFImage; font: PDFFont; pageWidth: number; pageHeight: number }): BannerQrBlockGeometry | null {
  try {
    const { qrImage, font, pageWidth, pageHeight } = options;
    const marginPt = BANNER_QR_CONFIG.marginMm * MM_TO_PT;
    const gapPt = BANNER_QR_CONFIG.gapMm * MM_TO_PT;
    const minQrSizePt = BANNER_QR_CONFIG.minSizeMm * MM_TO_PT;
    const maxContentWidthPt = pageWidth - 2 * marginPt;

    // Shrink the caption's own font size, independent of the QR, if it
    // would otherwise overflow the page at its normal size — measured with
    // the actual embedded font, never assumed to fit (requirement: text
    // safety). The caption text is a fixed, known-ASCII English string, so
    // "only characters the standard font supports" is satisfied by
    // construction, not by any extra check here.
    let captionSize = BANNER_QR_CONFIG.captionSizePt;
    let captionWidth = font.widthOfTextAtSize(BANNER_QR_CONFIG.captionText, captionSize);
    while (captionWidth > maxContentWidthPt && captionSize > BANNER_QR_CONFIG.captionMinSizePt) {
      captionSize -= 0.5;
      captionWidth = font.widthOfTextAtSize(BANNER_QR_CONFIG.captionText, captionSize);
    }
    if (captionWidth > maxContentWidthPt) return null; // Doesn't fit even at the floor size.

    // heightAtSize's default (descender: true) is the glyphs' full vertical
    // span, baseline-independent; subtracting the ascent-only figure
    // isolates just the descender portion, which is what the caption's
    // baseline needs to sit above the bottom margin by (the caption text
    // itself has a descender — the "g" in "Instagram" — so this isn't a
    // hypothetical correction).
    const captionFullHeight = font.heightAtSize(captionSize);
    const captionAscent = font.heightAtSize(captionSize, { descender: false });
    const captionDescent = captionFullHeight - captionAscent;

    // Target QR size, shrunk to whatever actually fits vertically within
    // the margins (width is never the limiting dimension in practice — a
    // 35mm-wide code leaves far more horizontal room than this on any page
    // size this ever prints on, but the clamp is still here for the
    // genuinely-tiny-page fallback case).
    const availableHeightPt = pageHeight - 2 * marginPt - gapPt - captionFullHeight;
    const qrSizePt = Math.min(BANNER_QR_CONFIG.sizeMm * MM_TO_PT, availableHeightPt, maxContentWidthPt);
    if (qrSizePt < minQrSizePt) return null; // Doesn't fit even at the floor — skip the whole block.

    const captionBaselineY = marginPt + captionDescent;
    const qrY = marginPt + captionFullHeight + gapPt;
    const qrX = (pageWidth - qrSizePt) / 2;
    const captionX = centeredX(font, BANNER_QR_CONFIG.captionText, captionSize, pageWidth);

    page.drawImage(qrImage, { x: qrX, y: qrY, width: qrSizePt, height: qrSizePt });
    page.drawText(BANNER_QR_CONFIG.captionText, {
      x: captionX,
      y: captionBaselineY,
      size: captionSize,
      font,
      color: BANNER_QR_CONFIG.captionColor,
    });

    return {
      topY: qrY + qrSizePt,
      qr: { x: qrX, y: qrY, size: qrSizePt },
      caption: { x: captionX, y: captionBaselineY, width: captionWidth, size: captionSize },
    };
  } catch (error) {
    console.warn("Could not draw the Instagram QR block on the banner — continuing without it:", error);
    return null;
  }
}

/**
 * Builds a single pickup-ID cover page and prepends it to the print-ready
 * PDF — only called when the customer opted in (job.includeBannerPage, see
 * ROADMAP.md #5). Returns one PDF (banner as page 1, then the original
 * content), submitted to CUPS as a single job with the existing `-n copies`
 * flow in lib/print/cups.ts.
 *
 * CUPS duplicates the whole submitted PDF per copy, so the banner correctly
 * lands on every physical copy, not just the first — that's the intended
 * behavior (each copy is its own stack that needs its own identifier), not
 * a bug. print-agent/index.ts's sheet-count math accounts for this: the +1
 * is applied per copy, not once flat — see the comment there.
 */
export async function prependBannerPage(contentPdfBytes: Uint8Array, job: PrintJobRecord): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  const bold = await output.embedFont(StandardFonts.HelveticaBold);
  const regular = await output.embedFont(StandardFonts.Helvetica);

  // Loaded (and copied) before the banner page itself so the banner can
  // match the content's actual orientation — copyPages doesn't insert
  // these into output's page tree yet, that only happens at the
  // output.addPage() calls below, so doing this first doesn't change the
  // final page order (banner still ends up as page 1).
  const content = await PDFDocument.load(contentPdfBytes);
  const contentPages = await output.copyPages(content, content.getPageIndices());

  // A landscape print job with the banner enabled would otherwise mix a
  // portrait cover sheet in with landscape content pages inside the same
  // CUPS job — a mixed-page-size job that can confuse a printer's
  // fit-to-page handling, and at best just looks wrong: a portrait sheet
  // sitting sideways-relative-to-everything-else in an otherwise-landscape
  // stack. Match extractSelectedPages' own notion of orientation (width vs
  // height of the already-processed content) rather than re-deriving it.
  const [firstContentPage] = contentPages;
  const isContentLandscape = firstContentPage.getWidth() > firstContentPage.getHeight();
  const bannerWidth = isContentLandscape ? A4_HEIGHT : A4_WIDTH;
  const bannerHeight = isContentLandscape ? A4_WIDTH : A4_HEIGHT;

  const banner = output.addPage([bannerWidth, bannerHeight]);
  // ROADMAP.md §21's ticket code is the number shown to the customer on
  // their phone and on the kiosk screen — the banner has to print the SAME
  // code, big, or the whole point of a pickup-ID page (matching what's on
  // paper to what the customer is looking at) breaks. Falls back to the
  // Request ID only in the defensive case a job somehow reached printing
  // without one assigned, which shouldn't happen since §21 assigns it at
  // creation — never expected in practice, just not a hard crash if it did.
  const pickupCode = job.ticketNumber != null ? `#${String(job.ticketNumber).padStart(3, "0")}` : shortRequestId(job.id);
  const requestId = shortRequestId(job.id);
  const timestamp = new Date(job.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  // Phone number collection (ROADMAP.md §1) is disabled in this build, so
  // job.phoneNumber is always "" — skip the phone segment instead of
  // printing a blank "Phone ***" on every banner. Picks the phone back up
  // automatically, with no change needed here, if §1 is ever re-enabled.
  const last4 = job.phoneNumber.slice(-4);

  // Centered vertically on the page — moving this text up or down can't
  // actually change which physical edge faces the printer's mechanism
  // (that's fixed by the paper path, not by where content sits on the
  // page), so there's no positioning that fixes accessibility on a given
  // printer; middle is the neutral default that isn't wrong for any of them.
  const label = "PICKUP ID";
  banner.drawText(label, {
    x: centeredX(bold, label, 24, bannerWidth),
    y: bannerHeight - 220,
    size: 24,
    font: bold,
    color: rgb(0.29, 0.33, 0.41),
  });
  banner.drawText(pickupCode, {
    x: centeredX(bold, pickupCode, 90, bannerWidth),
    y: bannerHeight - 340,
    size: 90,
    font: bold,
    color: rgb(0.15, 0.39, 0.92),
  });
  const detailLine = last4 ? `Phone ***${last4}  ·  ${timestamp}` : timestamp;
  banner.drawText(detailLine, {
    x: centeredX(regular, detailLine, 13, bannerWidth),
    y: bannerHeight - 400,
    size: 13,
    font: regular,
    color: rgb(0.45, 0.5, 0.57),
  });
  // Kept small — useful for staff tracing a specific printout back to its
  // exact job (e.g. in Supabase or a support conversation) without being
  // confused for the pickup code itself.
  const requestIdLine = `Request ID: ${requestId}`;
  banner.drawText(requestIdLine, {
    x: centeredX(regular, requestIdLine, 11, bannerWidth),
    y: bannerHeight - 420,
    size: 11,
    font: regular,
    color: rgb(0.65, 0.68, 0.72),
  });

  // Instagram QR footer — drawn before the OXWAY line below so its actual
  // drawn height (it can shrink, or be skipped entirely on a tiny page or
  // a missing image) decides where OXWAY needs to sit, not the other way
  // around. Wrapped in its own try/catch, separate from drawBannerQrBlock's
  // own internal one: loading the file and embedding it into `output` are
  // I/O/PDF-API calls that function never touches, so a failure here needs
  // its own guard to satisfy "never break the print" end to end.
  const defaultOxwayY = 60;
  let oxwayY = defaultOxwayY;
  try {
    const instaQrBytes = await loadInstaQrBytes();
    if (instaQrBytes) {
      const qrImage = await output.embedPng(instaQrBytes);
      const qrBlock = drawBannerQrBlock(banner, { qrImage, font: regular, pageWidth: bannerWidth, pageHeight: bannerHeight });
      if (qrBlock !== null) {
        oxwayY = qrBlock.topY + BANNER_QR_CONFIG.clearanceMm * MM_TO_PT;
      }
    }
  } catch (error) {
    console.warn("Could not add the Instagram QR to the banner — printing without it:", error);
  }

  const brand = "OXWAY";
  banner.drawText(brand, {
    x: centeredX(bold, brand, 16, bannerWidth),
    y: oxwayY,
    size: 16,
    font: bold,
    color: rgb(0.15, 0.39, 0.92),
  });

  contentPages.forEach((page) => output.addPage(page));

  return output.save();
}
