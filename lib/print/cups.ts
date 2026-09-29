import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PRINTER_NAME } from "../config";
import type { PrintSettingsSnapshot } from "../store";

const execFileAsync = promisify(execFile);

const MEDIA_BY_PAPER_SIZE: Record<PrintSettingsSnapshot["paperSize"], string> = {
  A4: "a4",
  Letter: "letter",
  Legal: "legal",
};

function buildLpArgs(filePath: string, settings: PrintSettingsSnapshot): string[] {
  const args: string[] = [];
  if (PRINTER_NAME) args.push("-d", PRINTER_NAME);
  args.push("-n", String(Math.max(1, settings.copies)));
  // Explicit, not left to CUPS's own default — a >1-copy job otherwise
  // prints uncollated (every copy of page 1, then every copy of page 2,
  // etc.) rather than each full copy in sequence. Confirmed via
  // `lpoptions -p <printer> -l` that this printer's PPD exposes no
  // Collate option of its own — it isn't a driver/hardware feature here,
  // it's CUPS's own generic job-level page ordering, so this is safe to
  // set unconditionally regardless of which printer/PPD is in use.
  args.push("-o", "collate=true");
  args.push("-o", `media=${MEDIA_BY_PAPER_SIZE[settings.paperSize]}`);
  // Deliberately NOT setting orientation-requested here (ROADMAP.md #15).
  // The generated PDF's own content geometry is already the source of
  // truth for orientation (see extractSelectedPages in lib/print/pdf.ts,
  // which also now accounts for a source page's own pre-existing rotation,
  // not just this app's Layout setting). Also setting orientation-requested
  // told the printer to physically rotate the paper feed AND told it the
  // content was already pre-rotated, at the same time — two independent
  // rotation instructions for the same job, which a driver honoring both
  // nets out to a double rotation (upside-down or sideways-wrong), not "no
  // rotation."
  args.push("-o", `number-up=${settings.pagesPerSheet}`);
  // The generated PDF's own page dimensions don't always exactly match the
  // customer's chosen paper size (an uploaded file's native page size, or a
  // client-side image/DOCX conversion, isn't reshaped to A4/Letter/Legal
  // before this point) — fit-to-page tells CUPS's filter chain to scale
  // content to the selected media regardless, rather than relying on
  // whatever a given driver's default behavior happens to be for a
  // mismatched page/media size.
  args.push("-o", "fit-to-page");
  // print-color-mode is the modern IPP-standard attribute most CUPS drivers respect.
  args.push("-o", `print-color-mode=${settings.isColor ? "color" : "monochrome"}`);
  args.push(filePath);
  return args;
}

/** Submits the PDF to CUPS via `lp` and returns the CUPS job id (e.g. "oxway-printer-42"). */
export async function submitPrintJob(filePath: string, settings: PrintSettingsSnapshot): Promise<string> {
  const { stdout } = await execFileAsync("lp", buildLpArgs(filePath, settings));
  // lp prints: "request id is <printer>-<number> (1 file(s))"
  const match = stdout.match(/request id is (\S+)/i);
  if (!match) throw new Error(`Could not parse CUPS job id from: ${stdout.trim()}`);
  return match[1];
}

/**
 * Cancels a submitted job in CUPS — called whenever a job transitions to
 * print_failed (see failJob in print-agent/index.ts), so a stuck or errored
 * job can never later get physically printed once whatever blocked it
 * clears (e.g. a disabled queue getting re-enabled), well after the
 * customer's already been auto-refunded for it. That exact gap — a refund
 * issued while the job sat live in CUPS's queue, then printed anyway once
 * the queue came back — is a confirmed real bug this closes.
 *
 * Best-effort: if the job already finished or was already removed by the
 * time this runs, `cancel` exits non-zero — fine, there's nothing left to
 * cancel, not a reason to leave the job print_failed/refunded without ever
 * marking that in the DB.
 */
export async function cancelPrintJob(cupsJobId: string): Promise<void> {
  try {
    await execFileAsync("cancel", [cupsJobId]);
  } catch (error) {
    console.error(`[cups] Could not cancel job ${cupsJobId} (may already be gone):`, error);
  }
}

export type CupsJobQueueState = "active" | "completed" | "error";

// Matched (case-insensitively) against a job's lpstat -l block — both while
// still queued (paper-out/offline/jammed usually shows here first) and in
// CUPS's completed-job history (a canceled or aborted job also leaves the
// active queue, and previously that alone was enough to be misread as a
// successful "completed" — see the bug this rewrite fixes below). Biased
// deliberately broad: a false "error" just costs an unnecessary refund +
// reprint (recoverable), while a false "completed" means a customer paid
// for nothing and printing silently never happens — those two mistakes are
// not equally bad, so every ambiguous case here resolves toward "error" or
// "active" (keep waiting), never toward an unearned "completed".
const FAILURE_KEYWORDS = /stopped|held|abort|cancel|error|fail|jam|offline|empty|media|no\s*paper|out\s*of\s*paper/i;

/** lpstat -l exits 0 with nothing to print, or non-zero when a destination/job has no matching entries — both mean "no lines", not a real failure. */
async function lpstatLongLines(args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("lpstat", ["-l", ...args]);
    return stdout.split("\n");
  } catch {
    return [];
  }
}

/**
 * `lpstat -l` prints one job as a header line starting with the job id,
 * followed by indented detail lines (status-message, etc.) up to the next
 * job's own header line (or the end of output). Returns that whole block
 * for `cupsJobId`, or null if the id isn't in `lines` at all.
 */
function extractJobBlock(lines: string[], cupsJobId: string): string | null {
  const startIndex = lines.findIndex((line) => line.startsWith(cupsJobId));
  if (startIndex === -1) return null;
  const block = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length && !/^\S/.test(lines[i]); i += 1) {
    block.push(lines[i]);
  }
  return block.join("\n");
}

/**
 * Confirmed by tracing real `lpstat` output during a live multi-copy job
 * (Pi, 1 page × 3 copies): CUPS considers its own part of a job "done" as
 * soon as it finishes handing the fully-rendered data off to the printer's
 * own internal buffer — for a multi-copy job small enough to fit there
 * entirely, that can happen while the print head is still physically
 * working through the earlier copies. So `lpstat -o`/the job's own queue
 * state going empty is necessary but not sufficient for "printed"; this is
 * the second signal getCupsJobQueueState below cross-checks it against —
 * the PRINTER's own hardware state, not the job's. `lpstat -p <dest>`
 * reports exactly two things that matter here: "is idle" once it's
 * genuinely done with everything queued to it, or "now printing <job-id>" /
 * some other non-idle state while it's still physically busy — checked
 * with a plain substring match rather than trying to enumerate every
 * possible non-idle phrasing, since "idle" is the one CUPS-generated string
 * this doesn't need to guess at.
 */
async function isPrinterIdle(destination: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("lpstat", ["-p", destination]);
    return /\bis idle\b/i.test(stdout);
  } catch {
    // Can't tell what state the printer's in — never treat that as "idle"
    // and risk an early "printed"; same conservative default as everywhere
    // else in this function.
    return false;
  }
}

/**
 * Polls CUPS to see whether a submitted job has left the active queue, and
 * — the part the original version of this function got wrong — whether it
 * left because it genuinely finished versus because it errored, was
 * canceled, or was aborted (a printer going offline, jamming, or running out
 * of paper mid-job all end a job's time in the active queue without ever
 * printing it). CUPS doesn't push completion events over the CLI, so
 * polling `lpstat` is still the practical way to know what happened; the
 * fix is to keep looking once the job disappears from the active list
 * instead of treating "gone from active" as a synonym for "printed":
 *
 *   1. Still in the active/pending queue (`lpstat -l -o <destination>`,
 *      CUPS's default "not completed" view)? Check its detail lines for a
 *      failure keyword (paper-out etc. usually shows here first, well
 *      before the job would ever fall out of this list) — "error" if so,
 *      "active" (keep polling) otherwise.
 *   2. Not there anymore — check CUPS's completed-job history
 *      (`lpstat -l -W completed -o <destination>`), which includes
 *      canceled/aborted jobs, not just genuinely successful ones. Found
 *      with a failure keyword -> "error".
 *   3. Found clean in the completed history -> one more check before this
 *      can be called "completed": is the PRINTER itself actually idle right
 *      now (see isPrinterIdle above)? CUPS's job-level bookkeeping can lag
 *      behind physical reality for a multi-copy job buffered on the
 *      printer's own hardware — if the printer's still busy, this stays
 *      "active" and gets polled again, even though the job itself has
 *      already left CUPS's own queue.
 *   4. Not in *either* list (a brief gap while CUPS moves it between the
 *      two) -> "active", never a guessed "completed" — the caller's own
 *      timeout (print-agent/index.ts) is the backstop if it never shows up
 *      again, exactly like an unrecognized failure keyword would be.
 */
export async function getCupsJobQueueState(cupsJobId: string): Promise<CupsJobQueueState> {
  const destination = cupsJobId.slice(0, cupsJobId.lastIndexOf("-"));

  const activeBlock = extractJobBlock(await lpstatLongLines(["-o", destination]), cupsJobId);
  if (activeBlock) return FAILURE_KEYWORDS.test(activeBlock) ? "error" : "active";

  const completedBlock = extractJobBlock(await lpstatLongLines(["-W", "completed", "-o", destination]), cupsJobId);
  if (!completedBlock) return "active";
  if (FAILURE_KEYWORDS.test(completedBlock)) return "error";

  return (await isPrinterIdle(destination)) ? "completed" : "active";
}

export async function listPrinters(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("lpstat", ["-p"]);
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("printer "))
      .map((line) => line.split(" ")[1]);
  } catch {
    return [];
  }
}
