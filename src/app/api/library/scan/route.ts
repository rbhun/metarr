import { askPlexToScanSelection, type ScanItem } from "@/lib/plex-scan";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { items?: unknown } | null;
  const items: ScanItem[] = [];
  if (Array.isArray(body?.items)) {
    for (const item of body.items) {
      if (!item || typeof item !== "object") continue;
      const record = item as { catalogId?: unknown; episodeId?: unknown };
      const catalogId = Number(record.catalogId);
      if (!Number.isInteger(catalogId) || catalogId <= 0) continue;
      const episodeId = record.episodeId == null ? null : Number(record.episodeId);
      if (episodeId != null && (!Number.isInteger(episodeId) || episodeId <= 0)) continue;
      items.push({ catalogId, episodeId });
    }
  }
  if (items.length === 0) return NextResponse.json({ error: "Select a title first." }, { status: 400 });
  try {
    return NextResponse.json(await askPlexToScanSelection(items));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The request failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
