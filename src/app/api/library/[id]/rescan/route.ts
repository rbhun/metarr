import { getDb } from "@/lib/db";
import { rescanTitle } from "@/lib/title-rescan";
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
    const result = await rescanTitle(getDb(), catalogId, episodeId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The rescan failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
