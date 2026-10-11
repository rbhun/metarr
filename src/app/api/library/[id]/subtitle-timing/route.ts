import { getDb } from "@/lib/db";
import { fixSubtitleTiming, inspectSubtitleTiming, restoreSubtitleTiming } from "@/lib/subtitle-fix";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

type Body = { episodeId?: unknown; action?: unknown; file?: unknown; scale?: unknown; offset?: unknown };

export async function POST(request: Request, { params }: Params) {
  const catalogId = Number((await params).id);
  if (!Number.isInteger(catalogId) || catalogId <= 0) {
    return NextResponse.json({ error: "Unknown title." }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as Body | null;
  const episodeId = body?.episodeId == null ? null : Number(body.episodeId);
  if (episodeId != null && (!Number.isInteger(episodeId) || episodeId <= 0)) {
    return NextResponse.json({ error: "Unknown episode." }, { status: 400 });
  }
  const action = body?.action ?? "inspect";
  const file = typeof body?.file === "string" ? body.file : "";
  try {
    const db = getDb();
    if (action === "inspect") return NextResponse.json({ rows: await inspectSubtitleTiming(db, catalogId, episodeId) });
    if (!file) return NextResponse.json({ error: "Choose a subtitle file." }, { status: 400 });
    if (action === "restore") return NextResponse.json(await restoreSubtitleTiming(db, catalogId, episodeId, file));
    if (action === "fix") {
      const map = { scale: Number(body?.scale), offset: Number(body?.offset ?? 0) };
      return NextResponse.json(await fixSubtitleTiming(db, catalogId, episodeId, file, map));
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The subtitle timing could not be changed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
