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
  args.push("-o", `media=${MEDIA_BY_PAPER_SIZE[settings.paperSize]}`);
  // Deliberately NOT setting orientation-requested here (ROADMAP.md #15).
  // The generated PDF's own /Rotate is already the source of truth for
  // orientation — verified directly against pdf-lib's actual behavior, not
  // assumed. Also setting orientation-requested told the printer to
  // physically rotate the paper feed AND told it the content was already
  // pre-rotated, at the same time — two independent rotation instructions
  // for the same job, which a driver honoring both nets out to a double
  // rotation (upside-down or sideways-wrong), not "no rotation." If content
  // still doesn't come out oriented correctly after this change, the next
  // thing to check is which physical direction /Rotate 90 vs 270 actually
  // needs to be for this printer/driver — see extractSelectedPages's own
  // "UNVERIFIED" note in lib/print/pdf.ts.
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
 * Polls `lpstat` to see whether a submitted job has left the queue.
 * CUPS doesn't push completion events over the CLI, so this is the practical
 * way to know whether the printer actually finished (or the job vanished
 * because it errored out — check `lpstat -W not-completed` output/logs on the
 * kiosk if a job disappears without printing).
 */
export async function isJobStillQueued(cupsJobId: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("lpstat", ["-W", "not-completed", "-o"]);
    return stdout.includes(cupsJobId);
  } catch {
    // lpstat exits non-zero when the queue is empty — treat that as "not queued".
    return false;
  }
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
