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

/** Exported so tests can assert on the exact arguments built for a given settings combination, directly — no need to mock execFile/lp just to catch an accidental change to one of these -o options. */
export function buildLpArgs(filePath: string, settings: PrintSettingsSnapshot): string[] {
  const args: string[] = [];
  if (PRINTER_NAME) args.push("-d", PRINTER_NAME);
  // Always exactly one CUPS-level copy. Copies (and their collation) are
  // baked directly into the submitted PDF itself before it ever reaches
  // this function — see expandCopies in lib/print/pdf.ts, called from
  // print-agent/index.ts — specifically so the mandatory banner page
  // (lib/print/banner.ts's prependBannerPage) can be added once, in front of
  // every copy of the actual content, rather than printing once per copy
  // the way letting CUPS's own -n flag replicate the whole submitted file
  // would. This also sidesteps relying on this printer's own collate
  // behavior at all (its PPD exposes no Collate option of its own —
  // confirmed via `lpoptions -p <printer> -l` — so collation here was
  // always CUPS's own generic, somewhat driver-dependent page ordering,
  // not something baked into the page sequence itself).
  args.push("-n", "1");
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

/**
 * What getCupsJobQueueState below actually reports — "blocked" is new, and
 * deliberately distinct from "error": a RECOVERABLE printer problem (out
 * of paper, a door/cover open, low toner, offline) must never fail a job
 * the way a genuine error does — see print-agent/index.ts's own print loop
 * for why ("a job can be both failed and printed" was a real, confirmed
 * bug: cancelling a job the instant CUPS reports paper-out, when the
 * printer itself had already buffered the full job internally — common
 * for this printer's USB/SPL driver — meant the physical printer finished
 * the job anyway once paper was loaded, well after it had already been
 * marked print_failed and, previously, auto-refunded).
 */
export type CupsJobQueueState =
  | { kind: "active" }
  | { kind: "completed" }
  | { kind: "blocked"; reason: string }
  | { kind: "error"; reason: string };

/**
 * RECOVERABLE — a person can fix every one of these without anyone needing
 * to resubmit anything, and none of them mean the printer did anything
 * wrong with data it already has: out of paper, a door/cover open, low/out
 * of toner, offline/disconnected. Matched against whatever text CUPS (or
 * this printer's own driver, echoed back through CUPS) put in the job's
 * status-message while it's still sitting in the ACTIVE queue — see this
 * file's own reliability note further down for exactly how confident this
 * app is in that text for the Samsung ML-1866W specifically.
 */
const RECOVERABLE_PROBLEM_KEYWORDS = /media[-\s]*empty|media[-\s]*needed|no\s*paper|out\s*of\s*paper|paper[-\s]*out|door|cover|toner|offline|not\s*connected|disconnected|marker[-\s]*supply/i;

/**
 * UNRECOVERABLE — nothing about "wait for the printer to be ready" fixes
 * any of these. A jam specifically is deliberately kept here rather than
 * treated as recoverable: unlike paper-out (where nothing has fed yet) or
 * toner/door (no paper has moved), a jam means paper may already be
 * partway fed or damaged, so it's not safe to assume the SAME buffered job
 * can just resume cleanly once cleared — a human needs to look at it and,
 * if appropriate, use the admin panel's own reprint action deliberately,
 * not have this agent silently keep retrying against a physically
 * uncertain state. "abort"/"cancel" mean someone or something explicitly
 * gave up on the job, not a transient hardware condition.
 *
 * Deliberately NOT included here: "stopped"/"held". Those read as
 * unambiguous "someone/something gave up" words, but CUPS overloads them —
 * a queue often shows as "stopped" when its OWN backend auto-paused it
 * after repeated errors, which is exactly as likely to mean "out of
 * paper" as "genuinely broken." Treating either as unrecoverable on its
 * own would silently reintroduce the very bug this classification exists
 * to fix. Text containing one of these AND a recoverable keyword still
 * correctly classifies as "blocked" (see RECOVERABLE_PROBLEM_KEYWORDS);
 * text containing ONLY one of these and nothing more specific falls back
 * to "active" (matches neither list) — the ordinary stuck-job timeout is
 * still the backstop for that case, same as for any other unrecognized
 * status text.
 */
const UNRECOVERABLE_PROBLEM_KEYWORDS = /jam|abort|cancel/i;

/**
 * Checked in this order deliberately: a jam mentioned alongside anything
 * else (e.g. a backend reporting both "canceled" and "media jam" for the
 * same stuck job) should always resolve to the more certain, more serious
 * "error" classification, never "blocked" — see UNRECOVERABLE_PROBLEM_KEYWORDS's
 * own comment for why a jam specifically can't be waited out safely.
 * Returns null for text that matches neither list — the caller treats
 * that the same as no problem detected at all (falls back to "active"),
 * the same conservative default this file always used before "blocked"
 * existed as a concept.
 */
export function classifyPrinterProblemText(text: string): "blocked" | "error" | null {
  if (UNRECOVERABLE_PROBLEM_KEYWORDS.test(text)) return "error";
  if (RECOVERABLE_PROBLEM_KEYWORDS.test(text)) return "blocked";
  return null;
}

// Matched against a job's lpstat -l block in CUPS's COMPLETED-job history
// only (never the active queue, which uses the two lists above instead) —
// a canceled or aborted job also leaves the active queue and lands here,
// and previously that alone was enough to be misread as a successful
// "completed" (the bug the ORIGINAL version of this function fixed). A
// terminal history entry is never retried regardless of which keyword
// matched, so there's no "blocked" classification here at all — anything
// matching either list, once CUPS has already moved it to this list, is
// simply "error".
const COMPLETED_HISTORY_FAILURE_KEYWORDS = /stopped|held|abort|cancel|error|fail|jam|offline|empty|media|no\s*paper|out\s*of\s*paper/i;

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
 *
 * Matches the header line's job id as a whole token (word-boundary), not
 * merely a string prefix — `startsWith` alone would also match
 * "printer-10"'s header line when looking for "printer-1", silently
 * reading a LATER job's own status as this one's.
 */
function extractJobBlock(lines: string[], cupsJobId: string): string | null {
  const headerPattern = new RegExp(`^${escapeRegExp(cupsJobId)}(?!\\S)`);
  const startIndex = lines.findIndex((line) => headerPattern.test(line));
  if (startIndex === -1) return null;
  const block = [lines[startIndex]];
  for (let i = startIndex + 1; i < lines.length && !/^\S/.test(lines[i]); i += 1) {
    block.push(lines[i]);
  }
  return block.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
 *      CUPS's default "not completed" view)? Check its detail lines
 *      against the recoverable/unrecoverable keyword lists above
 *      (paper-out etc. usually shows here first, well before the job
 *      would ever fall out of this list) — "blocked" or "error"
 *      accordingly, "active" (keep polling) if neither matches.
 *   2. Not there anymore — check CUPS's completed-job history
 *      (`lpstat -l -W completed -o <destination>`), which includes
 *      canceled/aborted jobs, not just genuinely successful ones. This
 *      list is always terminal — found with ANY failure keyword -> "error",
 *      never "blocked" (nothing left here to retry).
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
 *
 * RELIABILITY NOTE (Samsung ML-1866W, read before trusting this blindly on
 * a different printer): the active-queue text match above is the ONLY
 * signal this file has ever had empirical confirmation for — the comment
 * on isPrinterIdle below documents tracing real `lpstat` output against
 * this exact printer during development, and that trace is what
 * originally confirmed CUPS/this printer's driver DOES echo a recognizable
 * word like "media-empty" into the job's own status-message while it's
 * stuck in the active queue with no paper. That is still ultimately
 * best-effort text matching against an unversioned, driver-dependent
 * vocabulary, not a stable IPP `printer-state-reasons` feed read through a
 * dedicated tool — CUPS doesn't guarantee this wording across driver or
 * firmware updates. If the real message ever uses different words than
 * either keyword list expects, this falls back to "active" (classified as
 * neither blocked nor error) and the job just keeps waiting under the
 * NORMAL (short) stuck-job timeout — never silently misreported as
 * "completed". See isPrinterAcceptingNewJobs below for the one other,
 * coarser signal this app checks (whether the printer itself is marked
 * "disabled"), which is a much more stable CUPS string but also much less
 * specific (it can't say paper vs. toner vs. door).
 */
export async function getCupsJobQueueState(cupsJobId: string): Promise<CupsJobQueueState> {
  const destination = cupsJobId.slice(0, cupsJobId.lastIndexOf("-"));

  const activeBlock = extractJobBlock(await lpstatLongLines(["-o", destination]), cupsJobId);
  if (activeBlock) {
    const severity = classifyPrinterProblemText(activeBlock);
    if (severity === "error") return { kind: "error", reason: matchedReason(activeBlock, UNRECOVERABLE_PROBLEM_KEYWORDS) };
    if (severity === "blocked") return { kind: "blocked", reason: matchedReason(activeBlock, RECOVERABLE_PROBLEM_KEYWORDS) };
    return { kind: "active" };
  }

  const completedBlock = extractJobBlock(await lpstatLongLines(["-W", "completed", "-o", destination]), cupsJobId);
  if (!completedBlock) return { kind: "active" };
  if (COMPLETED_HISTORY_FAILURE_KEYWORDS.test(completedBlock)) {
    return { kind: "error", reason: matchedReason(completedBlock, COMPLETED_HISTORY_FAILURE_KEYWORDS) };
  }

  return (await isPrinterIdle(destination)) ? { kind: "completed" } : { kind: "active" };
}

/** The exact substring that matched, lowercased, for a readable reason string (e.g. "media-empty") — falls back to the generic label if somehow nothing matches after classification already said it would (defensive only; should never actually happen). */
function matchedReason(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  return match ? match[0].toLowerCase() : "unknown printer problem";
}

/**
 * The coarse, "before printing" pre-flight check (as distinct from the
 * per-job, during-printing check above) — whether CUPS currently considers
 * the configured printer (PRINTER_NAME, same as buildLpArgs uses — CUPS's
 * own default destination when unset) disabled, via the one thing
 * `lpstat -p` reliably prints in that case ("<printer> disabled since
 * <date> -"). Run once before EVERY new job is submitted (see
 * print-agent/index.ts), so a kiosk already known broken from a PREVIOUS
 * job never has a fresh job spooled into it needlessly. Takes no
 * parameter — unlike getCupsJobQueueState above, there's no cupsJobId yet
 * to derive a destination name from at this point; this always checks
 * this kiosk's one configured printer directly.
 *
 * Deliberately coarse: this can say "not accepting jobs right now" but
 * can't say WHY (paper vs. toner vs. door) the way the per-job check can —
 * CUPS's short `lpstat -p` form doesn't carry that detail, only whether
 * the queue itself is enabled. A printer that's enabled but would
 * immediately fail on submission (e.g. already out of paper, backend just
 * hasn't disabled the queue over it) is NOT caught here — that's exactly
 * what the per-job watch loop is for, once a job actually exists to watch.
 */
export async function isPrinterAcceptingNewJobs(): Promise<boolean> {
  try {
    const args = PRINTER_NAME ? ["-p", PRINTER_NAME] : ["-p"];
    const { stdout } = await execFileAsync("lpstat", args);
    return !/\bdisabled\b/i.test(stdout);
  } catch {
    // Can't tell — fail OPEN here (assume accepting), unlike isPrinterIdle's
    // fail-closed default: this is only a pre-submission nicety to avoid a
    // wasted spool, never the only thing standing between a job and the
    // real, per-job blocked/error detection that runs once it's actually
    // submitted.
    return true;
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
