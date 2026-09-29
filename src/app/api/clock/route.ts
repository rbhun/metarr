import { applyTimeZone, clockInfo, parseTimeZone, saveTimeZone } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  applyTimeZone(db);
  return NextResponse.json(clockInfo(db));
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as { timeZone?: unknown } | null;
  const raw = body?.timeZone;
  const clearing = raw === "" || raw === null;
  const zone = clearing ? null : parseTimeZone(raw);
  if (!clearing && !zone) return NextResponse.json({ error: "Pick a time zone from the list, for example Europe/Budapest." }, { status: 400 });
  const db = getDb();
  saveTimeZone(db, zone);
  return NextResponse.json(clockInfo(db));
}
