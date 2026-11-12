/**
 * Just the shared vocabulary — split out from lib/errors.ts (which pulls in
 * the service-role Supabase client) so client components, like the admin
 * Error Log page's area filter, can import this without ever bundling that.
 */
export const ERROR_AREAS = ["upload", "payment", "print", "admin", "cron", "kiosk"] as const;
export type ErrorArea = (typeof ERROR_AREAS)[number];
