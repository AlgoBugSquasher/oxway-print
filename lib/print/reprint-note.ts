/**
 * Formats a selected-pages array as a short range label — e.g. [2,3,4] ->
 * "2 to 4", [2,3,4,7] -> "2 to 4, 7", [5] -> "5". Pure and directly
 * testable (see reprint-note.test.ts), separated out from
 * formatReprintNote below so "how a page list reads" can be verified
 * without also pinning down a specific clock/timezone.
 */
export function formatPageRangeLabel(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";

  const parts: string[] = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];

  for (let index = 1; index <= sorted.length; index += 1) {
    const current = sorted[index];
    if (current === rangeEnd + 1) {
      rangeEnd = current;
      continue;
    }
    parts.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart} to ${rangeEnd}`);
    rangeStart = current;
    rangeEnd = current;
  }

  return parts.join(", ");
}

/**
 * The note written onto the ORIGINAL job the moment someone reprints pages
 * from it (requirement: "Add a note on the original job ('reprinted pages
 * X to Y')") — computed here in the application layer (not inside the
 * create_reprint_job Postgres function) specifically so the "X to Y" range
 * formatting above can be unit-tested directly, and so the displayed time
 * always reads in Asia/Kolkata regardless of which timezone the database
 * session happens to be configured with.
 */
export function formatReprintNote(pages: number[], now: Date): string {
  const label = formatPageRangeLabel(pages);
  const whenLabel = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
  return `Reprinted page${pages.length > 1 ? "s" : ""} ${label} on ${whenLabel}.`;
}
