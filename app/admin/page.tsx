'use client';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import { supabase } from '@/lib/supabase';

// APNA SECRET PIN YAHAN SET KARO
const OWNER_PIN = '7890'; 

interface KioskData {
  id: string;
  total_revenue: number;
  total_lifetime_prints: number;
  tray_pages: number;
  cartridge_pages: number;
  tray_max: number;
  cartridge_max: number;
}

export default function AdminDashboard() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState(false);

  const [data, setData] = useState<KioskData | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  // Check saved session on load
  useEffect(() => {
    const savedAuth = sessionStorage.getItem('oxway_admin_auth');
    if (savedAuth === 'true') {
      setIsAuthenticated(true);
    }
  }, []);

  const handlePinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pinInput === OWNER_PIN) {
      sessionStorage.setItem('oxway_admin_auth', 'true');
      setIsAuthenticated(true);
      setPinError(false);
    } else {
      setPinError(true);
      setPinInput('');
    }
  };

  const fetchStatus = async () => {
    try {
      const { data: status, error } = await supabase
        .from('kiosk_status')
        .select('*')
        .eq('id', 'oxway_01')
        .maybeSingle();

      if (error) throw error;
      if (status) setData(status);
    } catch (err) {
      console.error('Error fetching kiosk status:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isAuthenticated) return;

    fetchStatus();

    const channel = supabase
      .channel('kiosk_updates')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'kiosk_status' },
        (payload) => {
          setData(payload.new as KioskData);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [isAuthenticated]);

  const handleResetTray = async () => {
    if (!confirm('Tray refill ho gayi? Counter 0 karein?')) return;
    setUpdating(true);
    await supabase
      .from('kiosk_status')
      .update({ tray_pages: 0, updated_at: new Date().toISOString() })
      .eq('id', 'oxway_01');
    fetchStatus();
    setUpdating(false);
  };

  const handleResetCartridge = async () => {
    if (!confirm('Cartridge refill ho gayi? Counter 0 karein?')) return;
    setUpdating(true);
    await supabase
      .from('kiosk_status')
      .update({ cartridge_pages: 0, updated_at: new Date().toISOString() })
      .eq('id', 'oxway_01');
    fetchStatus();
    setUpdating(false);
  };

  // 1. PIN Lock Screen (for unauthorized users)
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center p-4 font-sans">
        <form onSubmit={handlePinSubmit} className="bg-slate-900 border border-slate-800 p-6 rounded-2xl w-full max-w-sm shadow-xl">
          <h2 className="text-xl font-bold text-red-500 mb-1">OXWAY Secure Portal</h2>
          <p className="text-xs text-slate-400 mb-5">Restricted to Kiosk Owner</p>

          <input
            type="password"
            maxLength={6}
            placeholder="Enter Owner PIN"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            className="w-full px-4 py-3 bg-slate-950 border border-slate-800 rounded-xl text-center text-lg tracking-widest outline-none focus:border-red-500 mb-3"
            autoFocus
          />

          {pinError && <p className="text-xs text-rose-500 mb-3 text-center">Incorrect PIN. Try again.</p>}

          <button
            type="submit"
            className="w-full py-3 bg-red-600 hover:bg-red-500 font-semibold text-sm rounded-xl transition active:scale-95"
          >
            Unlock Dashboard
          </button>
        </form>
      </div>
    );
  }

  // 2. Loading State
  if (loading) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 font-sans text-white">
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-600/20 blur-3xl" />
        <div className="relative flex w-full max-w-xs flex-col items-center px-6 text-center">
          <div className="animate-logo-entrance relative h-24 w-64 sm:h-28 sm:w-72">
            <Image
              src="/oxway-logo.jpg"
              alt="OXWAY"
              fill
              priority
              sizes="(max-width: 640px) 256px, 288px"
              className="object-contain"
            />
          </div>
          <div className="mt-8 w-48">
            <div className="h-px overflow-hidden rounded-full bg-red-950">
              <div className="h-full w-2/5 animate-[loadingLine_1.6s_ease-in-out_infinite] rounded-full bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.9)]" />
            </div>
            <p className="mt-3 text-[10px] font-medium tracking-[0.28em] text-red-400">SYNCING KIOSK...</p>
          </div>
        </div>
      </div>
    );
  }

  const trayPercent = Math.min(((data?.tray_pages || 0) / (data?.tray_max || 200)) * 100, 100);
  const cartridgePercent = Math.min(((data?.cartridge_pages || 0) / (data?.cartridge_max || 1100)) * 100, 100);

  // 3. Authenticated Owner Dashboard
  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 max-w-lg mx-auto font-sans pb-10">
      <div className="flex justify-between items-center py-4 border-b border-slate-800 mb-6">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-red-500">OXWAY</h1>
          <p className="text-xs text-slate-400">Owner Dashboard (Kiosk #01)</p>
        </div>
        <button
          onClick={() => {
            sessionStorage.removeItem('oxway_admin_auth');
            setIsAuthenticated(false);
          }}
          className="text-xs text-slate-500 hover:text-white transition underline"
        >
          Lock
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Total Revenue</p>
          <h2 className="text-3xl font-extrabold text-white mt-1">₹{data?.total_revenue || 0}</h2>
        </div>
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Total Prints</p>
          <h2 className="text-3xl font-extrabold text-white mt-1">{data?.total_lifetime_prints || 0}</h2>
        </div>
      </div>

      <div className="space-y-4">
        {/* Paper Tray */}
        <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
          <div className="flex justify-between items-baseline mb-2">
            <span className="font-semibold text-sm">Paper Tray</span>
            <span className={`text-xs font-bold ${data && data.tray_pages >= 180 ? 'text-amber-400' : 'text-slate-400'}`}>
              {data?.tray_pages || 0} / {data?.tray_max || 200} Sheets
            </span>
          </div>

          <div className="w-full bg-slate-800 rounded-full h-3 mb-2 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                data && data.tray_pages >= 180 ? 'bg-amber-500' : 'bg-blue-500'
              }`}
              style={{ width: `${trayPercent}%` }}
            />
          </div>

          {data && data.tray_pages >= 180 && (
            <p className="text-xs text-amber-400 mb-3 font-medium">⚠️ Refill paper tray soon (180+ printed)</p>
          )}

          <button
            onClick={handleResetTray}
            disabled={updating}
            className="w-full mt-2 py-2.5 bg-slate-800 hover:bg-slate-700 active:scale-[0.99] text-xs font-semibold rounded-xl border border-slate-700 transition"
          >
            Refilled Paper? (Reset Counter)
          </button>
        </div>

        {/* Cartridge */}
        <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
          <div className="flex justify-between items-baseline mb-2">
            <span className="font-semibold text-sm">Cartridge Life</span>
            <span className={`text-xs font-bold ${data && data.cartridge_pages >= 1100 ? 'text-red-400' : 'text-slate-400'}`}>
              {data?.cartridge_pages || 0} / {data?.cartridge_max || 1100} Prints
            </span>
          </div>

          <div className="w-full bg-slate-800 rounded-full h-3 mb-2 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                data && data.cartridge_pages >= 1100 ? 'bg-red-500' : 'bg-emerald-500'
              }`}
              style={{ width: `${cartridgePercent}%` }}
            />
          </div>

          {data && data.cartridge_pages >= 1100 && (
            <p className="text-xs text-red-400 mb-3 font-medium">🚨 Cartridge refill needed! (1100+ prints)</p>
          )}

          <button
            onClick={handleResetCartridge}
            disabled={updating}
            className="w-full mt-2 py-2.5 bg-slate-800 hover:bg-slate-700 active:scale-[0.99] text-xs font-semibold rounded-xl border border-slate-700 transition"
          >
            Refilled Cartridge? (Reset Counter)
          </button>
        </div>
      </div>
    </div>
  );
}