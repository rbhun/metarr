import { arrAction, bazarrOpenUrl, plexOpenUrl } from "@/lib/arr-action";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const catalogId = Number(id);
  if (!Number.isInteger(catalogId) || catalogId <= 0) {
    return NextResponse.json({ error: "Unknown title." }, { status: 400 });
  }
  const body = (await request.json().catch(() => null)) as { action?: string; app?: string; episodeId?: number } | null;
  const action = body?.action === "open" || body?.action === "search" ? body.action : null;
  if (!action) return NextResponse.json({ error: "Choose open or search." }, { status: 400 });
  try {
    if (body?.app === "plex") {
      if (action !== "open") return NextResponse.json({ error: "Plex can only be opened." }, { status: 400 });
      return NextResponse.json(await plexOpenUrl(catalogId, body.episodeId));
    }
    if (body?.app === "bazarr") {
      if (action !== "open") return NextResponse.json({ error: "Bazarr can only be opened." }, { status: 400 });
      return NextResponse.json(await bazarrOpenUrl(catalogId));
    }
    const app = body?.app === "radarr" || body?.app === "sonarr" ? body.app : undefined;
    return NextResponse.json(await arrAction(catalogId, action, app));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The request failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
