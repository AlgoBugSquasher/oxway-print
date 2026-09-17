const STYLES: Record<string, string> = {
  pending_payment: "bg-slate-100 text-slate-600",
  paid: "bg-blue-100 text-blue-700",
  printing: "bg-blue-100 text-blue-700",
  printed: "bg-emerald-100 text-emerald-700",
  print_failed: "bg-red-100 text-red-700",
  payment_failed: "bg-red-100 text-red-700",
  expired: "bg-amber-100 text-amber-700",
  cancelled: "bg-slate-200 text-slate-600",
};

export default function StatusBadge({ status }: { status: string }) {
  return <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${STYLES[status] ?? "bg-slate-100 text-slate-600"}`}>{status.replace("_", " ")}</span>;
}
