import { NextResponse } from "next/server";

interface PrintJob {
  fileName: string;
  selectedPages: number[];
  copies: number;
  isColor: boolean;
  totalPrice: number;
  timestamp: string;
  orderId: string;
}

export const printQueue: PrintJob[] = [];

export async function POST(request: Request) {
  const body = (await request.json()) as Omit<PrintJob, "timestamp" | "orderId">;
  const timestamp = new Date().toISOString();
  const orderId = `PRINT-${Date.now()}`;
  const job: PrintJob = { ...body, timestamp, orderId };

  printQueue.push(job);

  return NextResponse.json({ success: true, orderId });
}

export function GET() {
  return NextResponse.json(printQueue);
}
