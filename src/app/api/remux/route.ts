import { filesForSelection } from "@/lib/detect/files";
import { clampHour } from "@/lib/detect/schedule";
import { activeRemux, enqueueDiscs, latestRemux, parseBinary, parseLicenseKey, readRemuxPause, readRemuxSettings, remuxCounts, writeRemuxSettings } from "@/lib/remux/store";
import { kickRemuxWorker, startRemuxWorker } from "@/lib/remux/worker";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function idList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0);
}

function publicSettings(settings: ReturnType<typeof readRemuxSettings>) {
  return {
    startHour: settings.startHour,
    endHour: settings.endHour,
    binary: settings.binary,
    hasKey: Boolean(settings.licenseKey),
  };
}

export async function GET() {
  startRemuxWorker();
  const db = getDb();
  return NextResponse.json({
    settings: publicSettings(readRemuxSettings(db)),
    counts: remuxCounts(db),
    active: activeRemux(db),
    pause: readRemuxPause(db),
    latest: latestRemux(db),
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const db = getDb();
  const files = filesForSelection(db, idList(record.titles), idList(record.episodes));
  const result = enqueueDiscs(db, files, record.extras === true);
  startRemuxWorker();
  kickRemuxWorker();
  return NextResponse.json({ ...result, counts: remuxCounts(db) });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const startHour = clampHour(record.startHour, -1);
  const endHour = clampHour(record.endHour, -1);
  if (startHour < 0 || endHour < 0) return NextResponse.json({ error: "Use hours from 0 to 23." }, { status: 400 });
  if (startHour === endHour) {
    return NextResponse.json({ error: "The end hour has to be different from the start. An earlier end hour runs past midnight." }, { status: 400 });
  }
  const binary = parseBinary(record.binary);
  if (!binary) return NextResponse.json({ error: "Enter the makemkvcon command or its full path." }, { status: 400 });
  const licenseKey = record.licenseKey == null || record.licenseKey === "" ? null : parseLicenseKey(record.licenseKey);
  if (record.licenseKey && !licenseKey) return NextResponse.json({ error: "That MakeMKV key is not usable." }, { status: 400 });
  const db = getDb();
  writeRemuxSettings(db, {
    startHour,
    endHour,
    binary,
    licenseKey,
    clearKey: record.clearKey === true,
  });
  startRemuxWorker();
  return NextResponse.json({ settings: publicSettings(readRemuxSettings(db)) });
}
