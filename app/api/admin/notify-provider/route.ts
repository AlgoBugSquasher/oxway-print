import { NextResponse } from "next/server";
import { getActiveNotifyProvider } from "@/lib/config";
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
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authorized." }, { status: 401 });

  return NextResponse.json({ provider: getActiveNotifyProvider() });
}
