import { ensureHoverSources } from "@/lib/catalog";
import { getDb, queryEpisodes } from "@/lib/db";
import { getSyncStatus } from "@/lib/sync";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const catalogId = Number(id);
  if (!Number.isInteger(catalogId) || catalogId <= 0) {
    return NextResponse.json({ error: "Unknown title." }, { status: 400 });
  }
  if (!getSyncStatus().running) ensureHoverSources(getDb());
  return NextResponse.json({ episodes: queryEpisodes(catalogId) });
}
