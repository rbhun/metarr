import { listDiscCandidates } from "@/lib/remux/candidates";
import { clampHour } from "@/lib/detect/schedule";
import { filesForSelection } from "@/lib/detect/files";
import {
  activeRemux,
  clearPendingRemux,
  enqueueDiscs,
  enqueuePaths,
  latestRemux,
  listRemuxJobs,
  parseBinary,
  parseLicenseKey,
  readRemuxPause,
  readRemuxSettings,
  remuxCounts,
  remuxTotals,
  writeRemuxSettings,
  type RemuxJobStatus,
} from "@/lib/remux/store";
import { kickRemuxWorker, startRemuxWorker } from "@/lib/remux/worker";
import { getDb } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function idList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0);
}

function pathList(value: unknown): Array<{ path: string; label?: string }> {
  if (!Array.isArray(value)) return [];
  const paths: Array<{ path: string; label?: string }> = [];
  for (const item of value) {
    if (typeof item === "string") {
      const path = item.trim();
      if (path) paths.push({ path });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!path) continue;
    const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined;
    paths.push({ path, label });
  }
  return paths;
}

function publicSettings(settings: ReturnType<typeof readRemuxSettings>) {
  return {
    startHour: settings.startHour,
    endHour: settings.endHour,
    binary: settings.binary,
    hasKey: Boolean(settings.licenseKey),
  };
}

const JOB_STATUSES = new Set<RemuxJobStatus>(["pending", "running", "done", "failed"]);

export async function GET(request: Request) {
  startRemuxWorker();
  const db = getDb();
  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus && JOB_STATUSES.has(rawStatus as RemuxJobStatus) ? (rawStatus as RemuxJobStatus) : null;
  const page = Math.max(1, Math.trunc(Number(url.searchParams.get("page")) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("pageSize")) || 50)));
  const list = status ? listRemuxJobs(db, { status, page, pageSize }) : { jobs: [], total: 0 };
  const includeDiscs = url.searchParams.get("discs") === "1" || url.searchParams.get("discs") === "true";
  return NextResponse.json({
    settings: publicSettings(readRemuxSettings(db)),
    counts: remuxCounts(db),
    totals: remuxTotals(db),
    active: activeRemux(db),
    pause: readRemuxPause(db),
    latest: latestRemux(db),
    discs: includeDiscs ? listDiscCandidates(db) : undefined,
    jobs: list.jobs,
    total: list.total,
    page,
    pageSize,
  });
}

export async function DELETE() {
  const db = getDb();
  const removed = clearPendingRemux(db);
  return NextResponse.json({
    removed,
    counts: remuxCounts(db),
    totals: remuxTotals(db),
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
  const paths = pathList(record.paths);
  const result = paths.length
    ? enqueuePaths(db, paths, record.extras === true)
    : enqueueDiscs(db, filesForSelection(db, idList(record.titles), idList(record.episodes)), record.extras === true);
  startRemuxWorker();
  kickRemuxWorker();
  return NextResponse.json({ ...result, counts: remuxCounts(db), totals: remuxTotals(db) });
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
