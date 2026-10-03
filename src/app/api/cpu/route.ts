import { readCpu } from "@/lib/cpu";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const reading = await readCpu();
  return NextResponse.json({ percent: reading.host, host: reading.host, docker: reading.docker });
}
