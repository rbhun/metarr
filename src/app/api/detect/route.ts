import { filesForSelection } from "@/lib/detect/files";
import { parsePathMaps } from "@/lib/detect/paths";
import { clampHour } from "@/lib/detect/schedule";
import { activeJob, detectCounts, enqueueTargets, listJobs, readDetectSettings, writeDetectSettings } from "@/lib/detect/store";
import { targetsFromFiles, type DetectTarget } from "@/lib/detect/targets";
import { kickDetectWorker, startDetectWorker } from "@/lib/detect/worker";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function idList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0);
}

function trackList(value: unknown): DetectTarget[] {
  if (!Array.isArray(value)) return [];
  const targets: DetectTarget[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const kind = record.kind === "audio" || record.kind === "subtitle" ? record.kind : null;
    const ordinal = typeof record.ordinal === "number" && Number.isInteger(record.ordinal) && record.ordinal >= 0 ? record.ordinal : null;
    if (!path || !kind || ordinal == null) continue;
    targets.push({
      path,
      kind,
      ordinal,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : path,
      format: typeof record.format === "string" ? record.format : null,
      placement: typeof record.placement === "string" ? record.placement : null,
      streamLabel: typeof record.streamLabel === "string" ? record.streamLabel : null,
    });
  }
  return targets;
}

export async function GET() {
  startDetectWorker();
  const db = getDb();
  return NextResponse.json({
    settings: readDetectSettings(db),
    counts: detectCounts(db),
    active: activeJob(db),
    jobs: listJobs(db),
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
  const direct = trackList(record.tracks);
  const targets = direct.length ? direct : targetsFromFiles(filesForSelection(db, idList(record.titles), idList(record.episodes)), true, new Set());
  const queued = enqueueTargets(db, targets, mode === "now" ? "immediate" : "window");
  if (mode === "now") kickDetectWorker();
  else startDetectWorker();
  return NextResponse.json({ ...queued, counts: detectCounts(db) });
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
