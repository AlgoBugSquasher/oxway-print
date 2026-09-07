export const dynamic = 'force-dynamic';
import Razorpay from "razorpay";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const { amount } = (await request.json()) as { amount?: number };
    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return NextResponse.json({ error: "A valid amount is required" }, { status: 400 });
    }

    const keyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return NextResponse.json({ error: "Razorpay credentials are not configured" }, { status: 500 });
    }

    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const order = await razorpay.orders.create({
      amount: Math.round(numericAmount * 100),
      currency: "INR",
    });

    return NextResponse.json({ orderId: order.id, amount: order.amount });
  } catch (error) {
    console.error("Razorpay order creation failed:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create Razorpay order" }, { status: 500 });
  }
}
