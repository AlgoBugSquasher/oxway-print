import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  try {
    const { pagesPrinted, amount, colorMode } = await req.json();

    // 1. Log Transaction
    await supabase.from('print_orders').insert({
      pages_printed: pagesPrinted,
      amount: amount,
      color_mode: colorMode,
      status: 'completed',
    });

    // 2. Fetch current counts
    const { data: kiosk, error } = await supabase
      .from('kiosk_status')
      .select('*')
      .eq('id', 'oxway_01')
      .single();

    if (error || !kiosk) {
      return NextResponse.json({ error: 'Kiosk record not found' }, { status: 404 });
    }

    const updatedTrayPages = (kiosk.tray_pages || 0) + pagesPrinted;
    const updatedCartridgePages = (kiosk.cartridge_pages || 0) + pagesPrinted;
    const updatedRevenue = Number(kiosk.total_revenue || 0) + Number(amount);
    const updatedLifetimePrints = (kiosk.total_lifetime_prints || 0) + pagesPrinted;

    // 3. Update Counters in Supabase
    await supabase
      .from('kiosk_status')
      .update({
        tray_pages: updatedTrayPages,
        cartridge_pages: updatedCartridgePages,
        total_revenue: updatedRevenue,
        total_lifetime_prints: updatedLifetimePrints,
        updated_at: new Date().toISOString(),
      })
      .eq('id', 'oxway_01');

    // 4. Threshold Checks (Console trigger / Alert point)
    if (updatedTrayPages >= 180) {
      console.warn(`[ALERT] Refill Paper Tray! Current count: ${updatedTrayPages}/200`);
    }

    if (updatedCartridgePages >= 1100) {
      console.warn(`[ALERT] Refill Cartridge! Current count: ${updatedCartridgePages}/1100`);
    }

    return NextResponse.json({ 
      success: true, 
      trayPages: updatedTrayPages, 
      cartridgePages: updatedCartridgePages 
    });

  } catch (err) {
    return NextResponse.json({ error: 'Failed to update kiosk status' }, { status: 500 });
  }
}
