import { getSyncStatus, startSync } from "@/lib/sync";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getSyncStatus());
}

export async function POST() {
  const result = startSync();
  return NextResponse.json(result.status, { status: result.started ? 202 : 200 });
}
