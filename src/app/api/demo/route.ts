import { clearDemoLibrary, loadDemoLibrary } from "@/lib/demo";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  loadDemoLibrary();
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  clearDemoLibrary();
  return NextResponse.json({ ok: true });
}
