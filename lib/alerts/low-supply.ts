import { computePaperEstimate, computeTonerEstimate } from "../admin/supply-estimate";
import type { SupplyStatusRow } from "../admin/types";
import { supabaseAdmin } from "../supabase-admin";
import { evaluateAlert } from "./index";

export async function checkLowSupplyAlerts(kioskId: string): Promise<void> {
  const supabase = supabaseAdmin();
  const [{ data: supplyRows, error: supplyError }, { data: kiosk, error: kioskError }] = await Promise.all([
    supabase.rpc("get_kiosk_supply_status", { p_kiosk_id: kioskId }),
    supabase.from("kiosk_status").select("low_supply_threshold_percent").eq("id", kioskId).maybeSingle(),
  ]);
  if (supplyError || kioskError || !supplyRows?.[0] || !kiosk) return;

  const row = supplyRows[0] as SupplyStatusRow;
  const thresholdPercent = kiosk.low_supply_threshold_percent as number;

  const needsAlert = (status: string) => status === "low" || status === "needs_refill_update";

  const paper = computePaperEstimate(row, thresholdPercent);
  await evaluateAlert(kioskId, "paper_low", needsAlert(paper.status), {
    title: `OXWAY — ${kioskId} is low on paper`,
    body: paper.status === "needs_refill_update"
      ? "Paper estimate is out of range — please update the paper refill mark."
      : `${paper.remaining} sheets left (${Math.round(paper.percent ?? 0)}%). Estimated from the last paper refill mark.`,
  });

  const toner = computeTonerEstimate(row, thresholdPercent);
  await evaluateAlert(kioskId, "toner_low", needsAlert(toner.status), {
    title: `OXWAY — ${kioskId} is low on toner`,
    body: toner.status === "needs_refill_update"
      ? "Toner estimate is out of range — please update the toner change mark."
      : `${toner.remaining} pages left (${Math.round(toner.percent ?? 0)}%). Estimated from the last toner change mark.`,
  });
}
