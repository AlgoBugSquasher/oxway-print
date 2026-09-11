export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

export async function POST(req: Request) {
  console.log('POST /api/print-complete invoked');

  try {
    const body = await req.json();
    console.log('Received print completion payload:', body);

    const insertPayload = {
      ...body,
      order_id: body.order_id ?? body.paymentOrderId ?? body.orderId ?? null,
      razorpay_payment_id: body.razorpay_payment_id ?? body.paymentId ?? null,
      file_url: body.file_url ?? body.fileUrl ?? null,
      status: body.status ?? 'paid',
      total_pages: body.total_pages ?? body.pagesPrinted ?? null,
      copies: body.copies ?? 1,
      created_at: new Date().toISOString(),
    };

    const supabaseAdmin = getSupabaseAdmin();
    const { data, error } = await supabaseAdmin
      .from('print_orders')
      .insert([insertPayload])
      .select();

    if (error) {
      console.error('Supabase insert failed:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log('Supabase insert success:', data);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('Unhandled error in /api/print-complete:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to record print completion' },
      { status: 500 }
    );
  }
}