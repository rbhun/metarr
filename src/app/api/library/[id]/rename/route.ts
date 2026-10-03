import { getDb } from "@/lib/db";
import { renameSeriesForSonarr } from "@/lib/episode-rename";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const catalogId = Number((await params).id);
  if (!Number.isInteger(catalogId) || catalogId <= 0) {
    return NextResponse.json({ error: "Unknown title." }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as { episodeId?: unknown } | null;
  const episodeId = body?.episodeId == null ? null : Number(body.episodeId);
  if (episodeId != null && (!Number.isInteger(episodeId) || episodeId <= 0)) {
    return NextResponse.json({ error: "Unknown episode." }, { status: 400 });
  }
  try {
    const result = await renameSeriesForSonarr(getDb(), catalogId, episodeId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The rename failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
