import { countLookupRemaining, enabledProviderKeys, getDb, saveEnrichment, titlesForLookup } from "@/lib/db";
import { lookupOnline } from "@/lib/online-lookup";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BATCH = 8;

export async function POST(request: Request) {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rawIds = Array.isArray(record.ids) ? (record.ids as unknown[]) : null;
  const ids = rawIds
    ? rawIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0).slice(0, 40)
    : [];
  const hasIds = rawIds !== null;
  if (hasIds && ids.length === 0) {
    return NextResponse.json({ processed: 0, processedIds: [], remaining: 0, found: 0, missing: 0, errors: 0 });
  }
  const gaps = !hasIds;
  const keys = enabledProviderKeys();
  if (!keys.tmdb && !keys.omdb) {
    return NextResponse.json(
      { error: "Add a TMDB or OMDb key in Settings and turn the source on." },
      { status: 400 },
    );
  }

  const batch = titlesForLookup({ ids: ids.length ? ids : undefined, gaps, limit: BATCH });
  let found = 0;
  let missing = 0;
  let errors = 0;
  const db = getDb();
  for (const title of batch) {
    const meta = await lookupOnline(title, keys);
    const fetchedAt = new Date().toISOString();
    saveEnrichment(title.matchKey, title.kind, { ...meta, fetchedAt }, db);
    if (meta.status === "found") found += 1;
    else if (meta.status === "error") errors += 1;
    else missing += 1;
  }

  const remaining = ids.length ? Math.max(0, ids.length - batch.length) : countLookupRemaining(db);
  return NextResponse.json({
    processed: batch.length,
    processedIds: batch.map((title) => title.id),
    remaining,
    found,
    missing,
    errors,
  });
}
