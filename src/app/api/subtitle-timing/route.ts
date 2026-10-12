import { getDb } from "@/lib/db";
import { readTimingProgress, readTimingSettings, requestTimingPass, timingCounts, writeTimingSettings } from "@/lib/subtitle-check/store";
import { kickTimingWorker } from "@/lib/subtitle-check/worker";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function snapshot() {
  const db = getDb();
  return { settings: readTimingSettings(db), progress: readTimingProgress(db), counts: timingCounts(db) };
}

export async function GET() {
  return NextResponse.json(snapshot());
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as { enabled?: unknown; autoFix?: unknown } | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  const db = getDb();
  const current = readTimingSettings(db);
  writeTimingSettings(db, {
    enabled: typeof body.enabled === "boolean" ? body.enabled : current.enabled,
    autoFix: typeof body.autoFix === "boolean" ? body.autoFix : current.autoFix,
  });
  kickTimingWorker();
  return NextResponse.json(snapshot());
}

/** Check every subtitle now instead of waiting for the language detection hours. */
export async function POST() {
  const db = getDb();
  if (!readTimingSettings(db).enabled) return NextResponse.json({ error: "Turn on the subtitle timing check first." }, { status: 400 });
  requestTimingPass(db, true);
  kickTimingWorker();
  return NextResponse.json(snapshot());
}
