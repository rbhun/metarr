import { readCpuPercent } from "@/lib/cpu";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ percent: await readCpuPercent() });
}
