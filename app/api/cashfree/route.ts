import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { amount, fileName, selectedPages, settings } = await req.json();
    const clientId = process.env.CASHFREE_APP_ID;
    const clientSecret = process.env.CASHFREE_SECRET_KEY;

    if (!clientId || !clientSecret) {
      return NextResponse.json({ error: "Cashfree credentials are not configured" }, { status: 500 });
    }

    const orderId = `oxway_${Date.now()}`;

    const orderPayload = {
      order_id: orderId,
      order_amount: Number(amount),
      order_currency: "INR",
      customer_details: {
        customer_id: `cust_${Date.now()}`,
        customer_phone: "9876543210",
        customer_name: "Kiosk User",
      },
      order_meta: {
        return_url: `${process.env.NEXT_PUBLIC_BASE_URL || "https://oxway-print.vercel.app"}/api/verify-print?order_id={order_id}`,
      },
      order_note: JSON.stringify({ fileName, selectedPages, settings }),
    };

    // Cashfree Sandbox Order API call
    const response = await fetch("https://sandbox.cashfree.com/pg/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-version": "2023-08-01",
        "x-client-id": clientId,
        "x-client-secret": clientSecret,
      },
      body: JSON.stringify(orderPayload),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json({ error: data.message || "Failed to create order" }, { status: 400 });
    }

    // Isme payment_session_id milega jo frontend checkout kholega
    return NextResponse.json({ orderId: data.order_id, paymentSessionId: data.payment_session_id });
  } catch (error: unknown) {
    console.error("Cashfree order error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cashfree order creation failed" }, { status: 500 });
  }
}