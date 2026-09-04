import { NextResponse } from "next/server";
import Razorpay from "razorpay";

export async function POST(req: Request) {
  try {
    const { amount } = await req.json();

    const key_id = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;

    console.log("-> Checking Keys: ID is", key_id ? "OK" : "MISSING", "| Secret is", key_secret ? "OK" : "MISSING");

    if (!key_id || !key_secret) {
      return NextResponse.json(
        { error: "Keys are missing in .env.local file" },
        { status: 400 }
      );
    }

    const instance = new Razorpay({
      key_id: key_id.trim(),
      key_secret: key_secret.trim(),
    });

    // Razorpay amount minimum 100 paise (₹1) honi chahiye
    const payableAmount = Math.max(100, Math.round(Number(amount) * 100));

    const order = await instance.orders.create({
      amount: payableAmount,
      currency: "INR",
      receipt: `ox_${Date.now()}`,
    });

    console.log("-> Razorpay Order Success:", order.id);
    return NextResponse.json(order);
  } catch (error: any) {
    console.error("-> Razorpay Backend Error Full:", error);
    const msg =
      error?.error?.description ||
      error?.message ||
      (typeof error === "object" ? JSON.stringify(error) : String(error));

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}