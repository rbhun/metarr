import { filesForSelection } from "@/lib/detect/files";
import { parsePathMaps } from "@/lib/detect/paths";
import { clampHour } from "@/lib/detect/schedule";
import { activeJob, detectCounts, enqueueTargets, readDetectSettings, writeDetectSettings } from "@/lib/detect/store";
import { targetsFromFiles } from "@/lib/detect/targets";
import { kickDetectWorker, startDetectWorker } from "@/lib/detect/worker";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function idList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0);
}

export async function GET() {
  startDetectWorker();
  const db = getDb();
  return NextResponse.json({
    settings: readDetectSettings(db),
    counts: detectCounts(db),
    active: activeJob(db),
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
  const mode = record.mode === "now" || record.mode === "queue" ? record.mode : null;
  if (!mode) return NextResponse.json({ error: "Choose start now or queue." }, { status: 400 });
  const db = getDb();
  const files = filesForSelection(db, idList(record.titles), idList(record.episodes));
  const added = enqueueTargets(db, targetsFromFiles(files, true, new Set()), mode === "now" ? "immediate" : "window");
  if (mode === "now") kickDetectWorker();
  else startDetectWorker();
  return NextResponse.json({ added, counts: detectCounts(db) });
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
  const db = getDb();
  writeDetectSettings(db, {
    enabled: record.enabled === true,
    startHour,
    endHour,
    pathMaps: parsePathMaps(record.pathMaps),
  });
  startDetectWorker();
  return NextResponse.json({ settings: readDetectSettings(db) });
}
