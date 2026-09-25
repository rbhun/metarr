import { countLookupRemaining, enabledProviderKeys, getDb, saveEnrichment, titlesForLookup } from "@/lib/db";
import { lookupOnline } from "@/lib/online-lookup";
import { markOmdbExhausted, reserveOmdbRequest } from "@/lib/omdb-quota";
import type { ProviderId } from "@/lib/types";
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
  let omdbStopped = false;
  let message: string | null = null;
  const db = getDb();
  const processedIds: number[] = [];
  for (const title of batch) {
    const active: Partial<Record<ProviderId, string>> = { ...keys };
    if (active.omdb && !reserveOmdbRequest(db)) {
      delete active.omdb;
      message = keys.tmdb
        ? "OMDb’s daily limit of 1,000 lookups is used. Further titles are filled from TMDB until 00:00 UTC."
        : "OMDb’s daily limit of 1,000 lookups is used. It resets at 00:00 UTC.";
    }
    if (!active.tmdb && !active.omdb) {
      omdbStopped = true;
      break;
    }
    const meta = await lookupOnline(title, active);
    const omdbLimited = meta.message === "OMDb daily request limit reached.";
    if (omdbLimited) {
      markOmdbExhausted(db);
      if (!active.tmdb) {
        omdbStopped = true;
        message = "OMDb reported that today’s request limit is already used. It resets at 00:00 UTC.";
        break;
      }
      message = "OMDb reported that today’s request limit is already used. Further titles are filled from TMDB until 00:00 UTC.";
    }
    const fetchedAt = new Date().toISOString();
    saveEnrichment(title.matchKey, title.kind, { ...meta, message: omdbLimited ? null : meta.message, fetchedAt }, db);
    processedIds.push(title.id);
    if (meta.status === "found") found += 1;
    else if (meta.status === "error") errors += 1;
    else missing += 1;
  }

  const remaining = omdbStopped
    ? 0
    : ids.length
      ? Math.max(0, ids.length - processedIds.length)
      : countLookupRemaining(db);
  return NextResponse.json({
    processed: processedIds.length,
    processedIds,
    remaining,
    found,
    missing,
    errors,
    omdbStopped,
    message,
  });
}
