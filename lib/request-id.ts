/** Customer-facing short Request ID, derived from the job's uuid. Used by lib/notify/ (SMS text) and lib/print/banner.ts (printed page) — kept in one place so both always show the same code for the same job. */
export function shortRequestId(jobId: string): string {
  return jobId.slice(0, 8).toUpperCase();
}
