import { getDb } from "@/lib/db";
import { offeredSyncInterval, readSyncSchedule, writeSyncSchedule } from "@/lib/sync-schedule";
import { kickSyncWorker, startSyncWorker } from "@/lib/sync-worker";
import { getSyncStatus, startSync } from "@/lib/sync";
import { CONNECTORS, type ConnectorId } from "@/lib/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  startSyncWorker();
  return NextResponse.json({ ...getSyncStatus(), schedule: readSyncSchedule(getDb()) });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const intervalHours = offeredSyncInterval(record.intervalHours);
  if (!intervalHours) {
    return NextResponse.json({ error: "Choose an interval of 1, 3, 6, 12, or 24 hours." }, { status: 400 });
  }
  const db = getDb();
  writeSyncSchedule(db, { enabled: record.enabled === true, intervalHours });
  kickSyncWorker();
  return NextResponse.json({ schedule: readSyncSchedule(db) });
}

export async function POST(request: Request) {
  const text = await request.text();
  let only: ConnectorId | undefined;
  if (text.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
    }
    const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
    if (id != null) {
      if (typeof id !== "string" || !CONNECTORS.includes(id as ConnectorId)) {
        return NextResponse.json({ error: "Unknown connector." }, { status: 400 });
      }
      only = id as ConnectorId;
    }
  }
  const result = startSync(only);
  return NextResponse.json(result.status, { status: result.started ? 202 : 200 });
}
