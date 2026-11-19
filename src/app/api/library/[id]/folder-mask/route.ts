import { announceFolder } from "@/lib/announce";
import { rebuildCatalog } from "@/lib/catalog";
import { filesForSelection } from "@/lib/detect/files";
import { getDb } from "@/lib/db";
import { isDirectory, repairTitlePaths } from "@/lib/plex-access";
import { titleIdForPath } from "@/lib/title-link";
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
  const db = getDb();
  const selected = filesForSelection(db, episodeId ? [] : [catalogId], episodeId ? [episodeId] : []);
  const paths = selected.flatMap((file) => [file.path, ...file.versions.map((version) => version.path)]).filter((item): item is string => Boolean(item));
  if (!paths.length) return NextResponse.json({ error: "This title has no file to open." }, { status: 400 });
  try {
    const result = repairTitlePaths(db, paths);
    rebuildCatalog(db);
    const folders = result.opened.filter((item) => isDirectory(item)).slice(0, 8);
    for (const folder of folders) await announceFolder(db, [folder]).catch(() => "");
    return NextResponse.json({ ...result, catalogId: titleIdForPath(db, paths[0] ?? "") });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not open the folder." }, { status: 400 });
  }
}
