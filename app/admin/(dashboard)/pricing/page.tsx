"use client";

import { type FormEvent, useEffect, useState } from "react";
import { RefreshCw, Save, ShieldAlert } from "lucide-react";
import { updatePricing } from "@/lib/admin/actions";
import type { AdminRole, PricingConfigRow } from "@/lib/admin/types";
import { createSupabaseBrowserClient } from "@/lib/supabase";

export default function AdminPricingPage() {
  const [role, setRole] = useState<AdminRole | null>(null);
  const [priceBw, setPriceBw] = useState("");
  const [priceColor, setPriceColor] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setIsLoading(true);
    setError("");
    try {
      const supabase = createSupabaseBrowserClient();
      const { data: { user } } = await supabase.auth.getUser();
      setRole(((user?.app_metadata as { role?: AdminRole } | undefined)?.role) ?? "none");

      const { data, error: queryError } = await supabase.from("pricing_config").select("*").eq("id", "default").single();
      if (queryError) throw new Error(queryError.message);
      const row = data as PricingConfigRow;
      setPriceBw(String(row.price_bw));
      setPriceColor(String(row.price_color));
      setUpdatedAt(row.updated_at);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load pricing.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // Fetch-on-mount, reusing `load` so the post-save reload shares the same
    // fetch logic — not the derived-state anti-pattern this rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSaved(false);
    const bw = Number(priceBw);
    const color = Number(priceColor);
    if (!(bw > 0) || !(color > 0)) {
      setError("Both prices must be positive numbers.");
      return;
    }
    setIsSaving(true);
    try {
      await updatePricing(bw, color);
      setSaved(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save pricing.");
    } finally {
      setIsSaving(false);
    }
  };

  if (!isLoading && role !== "owner") {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-800">
        <ShieldAlert size={18} />
        <p className="text-sm font-semibold">Pricing is owner-only. Even if this page loaded, the server would refuse any change — see update_pricing in SUPABASE_SETUP.md.</p>
      </div>
    );
  }

  return (
    <div className="max-w-md space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-500">Pricing</p>
        <h1 className="mt-1 text-2xl font-black">Per-sheet pricing</h1>
        <p className="mt-1 text-sm text-slate-500">Applies to every new order immediately — see ROADMAP.md #13 for how create-order enforces this server-side.</p>
      </div>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-slate-500"><RefreshCw size={14} className="animate-spin" /> Loading...</p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
          <div>
            <label className="mb-1.5 block text-sm font-bold text-slate-700">Price per B&amp;W sheet (&#8377;)</label>
            <input type="number" step="0.01" min="0.01" value={priceBw} onChange={(event) => setPriceBw(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-bold text-slate-700">Price per color sheet (&#8377;)</label>
            <input type="number" step="0.01" min="0.01" value={priceColor} onChange={(event) => setPriceColor(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-blue-500" />
          </div>
          {updatedAt && <p className="text-xs text-slate-400">Last changed {new Date(updatedAt).toLocaleString("en-IN")}</p>}
          {error && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{error}</div>}
          {saved && <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-600">Saved.</div>}
          <button type="submit" disabled={isSaving} className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-black text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">
            {isSaving ? <RefreshCw className="animate-spin" size={15} /> : <Save size={15} />} Save pricing
          </button>
        </form>
      )}
    </div>
  );
}
