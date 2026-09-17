"use client";

import { type FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, KeyRound, LogIn, RefreshCw } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { createSupabaseBrowserClient } from "@/lib/supabase";

// ROADMAP.md §26 — prototype/testing-phase only. Deleting this whole flag
// check (and the passcode block it gates further down) is the entire
// removal step later; nothing else in this file depends on it.
const PROTOTYPE_MODE = process.env.NEXT_PUBLIC_PROTOTYPE_MODE === "true";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const goToAdmin = () => {
    router.push("/admin");
    router.refresh();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) throw new Error(signInError.message);
      goToAdmin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setIsLoading(false);
    }
  };

  // §26 — the passcode never touches Supabase Auth directly from the
  // browser. It's looked up server-side against a real pre-created
  // account's real email/password (server-only env vars), which then signs
  // in for real via /api/admin/prototype-login — so RLS/roles apply exactly
  // as if the real form above had been used. This is a UI convenience, not
  // a second, weaker auth path.
  const handlePasscodeSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setIsLoading(true);
    try {
      await fetchJson("/api/admin/prototype-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      goToAdmin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f4f6f8] px-5">
      <div className="w-full max-w-sm rounded-[2rem] border border-slate-200 bg-white p-8 shadow-xl shadow-slate-900/5">
        <Link href="/" className="mb-5 flex items-center gap-1.5 text-xs font-bold text-slate-400 transition-colors hover:text-blue-600">
          <ArrowLeft size={14} /> Back to printing
        </Link>
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-600/20">
            <LogIn size={19} />
          </div>
          <div>
            <p className="text-sm font-black tracking-[0.16em] text-blue-600">OXWAY</p>
            <p className="text-xs text-slate-500">Admin sign in</p>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-bold text-slate-700">Email</label>
            <input
              id="email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-bold text-slate-700">Password</label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
            />
          </div>
          {error && <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-500">{error}</div>}
          <button
            type="submit"
            disabled={isLoading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-sm font-black text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? <RefreshCw className="animate-spin" size={16} /> : "Sign in"}
          </button>
        </form>
        {PROTOTYPE_MODE && (
          <>
            <div className="my-5 flex items-center gap-3 text-xs font-bold uppercase tracking-[0.15em] text-slate-400">
              <span className="h-px flex-1 bg-slate-200" />
              Prototype quick access
              <span className="h-px flex-1 bg-slate-200" />
            </div>
            <form onSubmit={handlePasscodeSubmit} className="space-y-3">
              <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700">
                <KeyRound size={14} className="shrink-0" />
                Testing-phase shortcut only — signs in with a real owner/staff account.
              </div>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                placeholder="Passcode"
                value={passcode}
                onChange={(event) => setPasscode(event.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                disabled={isLoading || !passcode}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 py-3 text-sm font-black text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoading ? <RefreshCw className="animate-spin" size={16} /> : "Quick sign in"}
              </button>
            </form>
          </>
        )}
        <p className="mt-5 text-center text-xs text-slate-400">Accounts are created by the owner in Supabase — no self-signup.</p>
      </div>
    </div>
  );
}
