import { clampHour } from "@/lib/detect/schedule";
import { getDb } from "@/lib/db";
import { libraryAvis, listRewrapCandidates, rewrapItemsForSelection } from "@/lib/rewrap/candidates";
import { canRewrap } from "@/lib/rewrap/source";
import { splitIdentity } from "@/lib/media";
import {
  activeRewrap,
  clearRewrapJobs,
  enqueueRewraps,
  latestRewrap,
  parseFirstLanguage,
  readRewrapPause,
  readRewrapSettings,
  rewrapTotals,
  writeRewrapSettings,
  type RewrapItem,
} from "@/lib/rewrap/store";
import { kickRewrapWorker, startRewrapWorker } from "@/lib/rewrap/worker";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function idList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0);
}

function itemList(value: unknown): RewrapItem[] {
  if (!Array.isArray(value)) return [];
  const items: RewrapItem[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry.trim()) items.push({ path: entry.trim() });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const filePath = typeof record.path === "string" ? record.path.trim() : "";
    if (!filePath) continue;
    const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined;
    items.push({ path: filePath, label });
  }
  return items;
}

export async function GET(request: Request) {
  startRewrapWorker();
  const db = getDb();
  const url = new URL(request.url);
  const includeFiles = url.searchParams.get("files") === "1";
  return NextResponse.json({
    settings: readRewrapSettings(db),
    totals: rewrapTotals(db),
    active: activeRewrap(db),
    pause: readRewrapPause(db),
    latest: latestRewrap(db),
    files: includeFiles ? listRewrapCandidates(db) : undefined,
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
  const pasted = itemList(record.paths);
  const library = pasted.length ? libraryAvis(db) : new Map<string, RewrapItem>();
  const items: RewrapItem[] = [
    ...rewrapItemsForSelection(db, idList(record.titles), idList(record.episodes)),
    ...pasted.map((item) => {
      const known = library.get(item.path);
      return known ? { ...known, label: item.label ?? known.label } : item;
    }),
  ];
  const avis = items.filter((item) => canRewrap(null, item.path) || Boolean(splitIdentity(item.path)));
  const result = enqueueRewraps(db, avis, record.immediate === true);
  kickRewrapWorker();
  return NextResponse.json({ ...result, skipped: items.length - avis.length, totals: rewrapTotals(db) });
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
  const current = readRewrapSettings(db);
  const startHour = record.startHour == null ? current.startHour : clampHour(record.startHour, -1);
  const endHour = record.endHour == null ? current.endHour : clampHour(record.endHour, -1);
  if (startHour < 0 || endHour < 0) return NextResponse.json({ error: "Use hours from 0 to 23." }, { status: 400 });
  if (startHour === endHour) {
    return NextResponse.json({ error: "The end hour has to be different from the start. An earlier end hour runs past midnight." }, { status: 400 });
  }
  const firstLanguage = record.firstLanguage == null ? current.firstLanguage : parseFirstLanguage(record.firstLanguage);
  if (firstLanguage == null) return NextResponse.json({ error: "Metarr does not know that language. Try a name like Hungarian or a code like hun." }, { status: 400 });
  writeRewrapSettings(db, {
    enabled: typeof record.enabled === "boolean" ? record.enabled : current.enabled,
    startHour,
    endHour,
    firstLanguage,
  });
  kickRewrapWorker();
  return NextResponse.json({ settings: readRewrapSettings(db) });
}

export async function DELETE() {
  const db = getDb();
  const removed = clearRewrapJobs(db, "pending");
  return NextResponse.json({ removed, totals: rewrapTotals(db) });
}
