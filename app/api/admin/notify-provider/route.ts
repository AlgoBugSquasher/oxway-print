import { NextResponse } from "next/server";
import { getActiveNotifyProvider } from "@/lib/config";
import { logDuration, withTiming } from "@/lib/server-timing";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lets the admin panel show "messages are only logged, not sent" next to
 * the owner-only WhatsApp-availability toggle (app/admin/(dashboard)/kiosk-card.tsx).
 * NOTIFY_PROVIDER is a server-only env var (lib/config.ts also carries
 * payment-provider secrets) — client components in this codebase never
 * import that module directly, see kiosk-card.tsx's own note on
 * KIOSK_SILENT_THRESHOLD_MINUTES for why. Not sensitive info by itself, but
 * still gated to a signed-in admin (any role), same spirit as the rest of
 * /api/admin/*.
 *
 * getClaims() (not getUser()) — the Overview page polls this every 5s (see
 * app/admin/(dashboard)/page.tsx), and this is only a "is there a session
 * at all" presence check (no money/PII/audit data in the response), same
 * category as proxy.ts's own gate — see that file's comment for why this
 * is still real, verified-signature data, never a bare decode.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { result: { data, error }, tookMs } = await withTiming(() => supabase.auth.getClaims());
  logDuration("notify-provider.getClaims", tookMs);
  if (error || !data) return NextResponse.json({ error: "Not authorized." }, { status: 401 });

  return NextResponse.json({ provider: getActiveNotifyProvider() });
}
