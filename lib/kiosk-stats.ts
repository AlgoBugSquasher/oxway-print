import { supabaseAdmin } from "./supabase-admin";

export interface CompletedPrintStats {
  pagesPrinted: number;
  amount: number;
  colorMode: boolean;
}

export interface KioskCounters {
  trayPages: number;
  cartridgePages: number;
}

/**
 * Logs a finished kiosk print job to Supabase and bumps the paper-tray /
 * cartridge / revenue counters the admin dashboard (/admin) reads.
 *
 * Best-effort: Supabase syncing is a secondary concern to actually getting
 * the document printed, so failures here are logged and swallowed rather
 * than thrown. If Supabase isn't configured yet, this just no-ops.
 */
export async function recordCompletedPrint(stats: CompletedPrintStats): Promise<KioskCounters | null> {
  try {
    const supabase = supabaseAdmin();

    await supabase.from("print_orders").insert({
      pages_printed: stats.pagesPrinted,
      amount: stats.amount,
      color_mode: stats.colorMode,
      status: "completed",
    });

    const { data: kiosk, error } = await supabase
      .from("kiosk_status")
      .select("*")
      .eq("id", "oxway_01")
      .single();

    if (error || !kiosk) {
      console.warn("kiosk_status record 'oxway_01' not found — skipping counter update.");
      return null;
    }

    const trayPages = (kiosk.tray_pages || 0) + stats.pagesPrinted;
    const cartridgePages = (kiosk.cartridge_pages || 0) + stats.pagesPrinted;
    const totalRevenue = Number(kiosk.total_revenue || 0) + Number(stats.amount);
    const totalLifetimePrints = (kiosk.total_lifetime_prints || 0) + stats.pagesPrinted;

    await supabase
      .from("kiosk_status")
      .update({
        tray_pages: trayPages,
        cartridge_pages: cartridgePages,
        total_revenue: totalRevenue,
        total_lifetime_prints: totalLifetimePrints,
        updated_at: new Date().toISOString(),
      })
      .eq("id", "oxway_01");

    if (trayPages >= 180) console.warn(`[ALERT] Refill Paper Tray! Current count: ${trayPages}/200`);
    if (cartridgePages >= 1100) console.warn(`[ALERT] Refill Cartridge! Current count: ${cartridgePages}/1100`);

    return { trayPages, cartridgePages };
  } catch (error) {
    console.error("Failed to record completed print in Supabase:", error);
    return null;
  }
}
