import { compareFrames } from "@/lib/merge/compare";
import {
  inspectTitleMerge,
  listMergeCandidates,
  mergeCandidateForPaths,
  resolveTitleIdForMerge,
} from "@/lib/merge/candidates";
import {
  activeMerge,
  clearMergeJobs,
  enqueueMerges,
  latestMerge,
  mergeTotals,
  parseMaxDurationDeltaMinutes,
  readMergePause,
  readMergeSettings,
  writeMergeSettings,
  type MergeItem,
} from "@/lib/merge/store";
import { kickMergeWorker, startMergeWorker } from "@/lib/merge/worker";
import { resolveMediaPath } from "@/lib/detect/paths";
import { readDetectSettings } from "@/lib/detect/store";
import { getDb } from "@/lib/db";
import fs from "node:fs";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function existsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function pairOptions(db: ReturnType<typeof getDb>) {
  return { maxDurationDeltaMinutes: readMergeSettings(db).maxDurationDeltaMinutes };
}

function itemFromBody(record: Record<string, unknown>, db: ReturnType<typeof getDb>): MergeItem | null {
  const leftPath = typeof record.leftPath === "string" ? record.leftPath.trim() : "";
  const rightPath = typeof record.rightPath === "string" ? record.rightPath.trim() : "";
  if (!leftPath || !rightPath || leftPath === rightPath) return null;
  const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined;
  const skipFrameCheck = record.skipFrameCheck === true;
  const known = mergeCandidateForPaths(db, leftPath, rightPath, pairOptions(db));
  if (known) {
    const preferred = known.videoFrom === "left" ? known.left.path : known.right.path;
    const requested = typeof record.videoPath === "string" ? record.videoPath.trim() : "";
    const videoPath = requested === known.left.path || requested === known.right.path ? requested : preferred;
    return { leftPath: known.left.path, rightPath: known.right.path, videoPath, label: label ?? known.label, skipFrameCheck };
  }
  const videoPath = typeof record.videoPath === "string" ? record.videoPath.trim() : "";
  if (videoPath !== leftPath && videoPath !== rightPath) return null;
  return { leftPath, rightPath, videoPath, label, skipFrameCheck };
}

export async function GET(request: Request) {
  startMergeWorker();
  const db = getDb();
  const url = new URL(request.url);
  const search = url.searchParams.get("q") ?? "";
  const includeCandidates = url.searchParams.get("candidates") === "1";
  const settings = readMergeSettings(db);
  return NextResponse.json({
    settings,
    totals: mergeTotals(db),
    active: activeMerge(db),
    pause: readMergePause(db),
    latest: latestMerge(db),
    candidates: includeCandidates ? listMergeCandidates(db, search, { maxDurationDeltaMinutes: settings.maxDurationDeltaMinutes }) : undefined,
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
  if (!readMergeSettings(db).enabled) {
    return NextResponse.json({ error: "Version merge is turned off in Settings." }, { status: 400 });
  }

  if (record.action === "inspect") {
    const settings = readMergeSettings(db);
    let titleId =
      typeof record.titleId === "number" && Number.isInteger(record.titleId) && record.titleId > 0 ? record.titleId : null;
    if (!titleId && typeof record.title === "string") {
      const found = resolveTitleIdForMerge(db, record.title);
      if (!found) return NextResponse.json({ error: "No library title matched that name or id." }, { status: 404 });
      titleId = found.titleId;
    }
    if (!titleId) return NextResponse.json({ error: "Choose a library title to check." }, { status: 400 });
    const inspect = inspectTitleMerge(db, titleId, { maxDurationDeltaMinutes: settings.maxDurationDeltaMinutes });
    if (!inspect) return NextResponse.json({ error: "That library title was not found." }, { status: 404 });
    return NextResponse.json({ inspect, settings });
  }

  if (record.action === "compare") {
    const leftPath = typeof record.leftPath === "string" ? record.leftPath.trim() : "";
    const rightPath = typeof record.rightPath === "string" ? record.rightPath.trim() : "";
    if (!leftPath || !rightPath) return NextResponse.json({ error: "Choose two files to compare." }, { status: 400 });
    const maps = readDetectSettings(db).pathMaps;
    const left = resolveMediaPath(leftPath, maps, existsFile);
    const right = resolveMediaPath(rightPath, maps, existsFile);
    if (!left || !right) {
      return NextResponse.json({ error: "Cannot open both files. Add a path mapping in Settings if Plex uses a different path." }, { status: 400 });
    }
    try {
      const result = await compareFrames(left, right);
      return NextResponse.json({ result });
    } catch (caught) {
      return NextResponse.json({ error: caught instanceof Error ? caught.message : "Frame compare failed." }, { status: 500 });
    }
  }

  const item = itemFromBody(record, db);
  if (!item) return NextResponse.json({ error: "Choose two versions of the same title to merge." }, { status: 400 });
  const result = enqueueMerges(db, [item]);
  kickMergeWorker();
  return NextResponse.json({ ...result, totals: mergeTotals(db) });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const db = getDb();
  const current = readMergeSettings(db);
  const maxDurationDeltaMinutes =
    record.maxDurationDeltaMinutes == null ? current.maxDurationDeltaMinutes : parseMaxDurationDeltaMinutes(record.maxDurationDeltaMinutes);
  if (maxDurationDeltaMinutes == null) {
    return NextResponse.json({ error: "Use a runtime difference between 0 and 120 minutes." }, { status: 400 });
  }
  writeMergeSettings(db, {
    enabled: typeof record.enabled === "boolean" ? record.enabled : current.enabled,
    maxDurationDeltaMinutes,
  });
  kickMergeWorker();
  return NextResponse.json({ settings: readMergeSettings(db) });
}

export async function DELETE() {
  const db = getDb();
  const removed = clearMergeJobs(db, "pending");
  return NextResponse.json({ removed, totals: mergeTotals(db) });
}
