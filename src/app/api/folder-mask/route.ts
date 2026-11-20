import { announceFolder } from "@/lib/announce";
import { rebuildCatalog } from "@/lib/catalog";
import { filesForSelection } from "@/lib/detect/files";
import { getDb } from "@/lib/db";
import { checkFolderMasks } from "@/lib/folder-scan";
import { isDirectory, repairTitlePaths } from "@/lib/plex-access";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Item = { catalogId: number; episodeId?: number };

function readItems(value: unknown): Item[] | null {
  if (!Array.isArray(value)) return null;
  const items: Item[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const catalogId = Number(record.catalogId);
    if (!Number.isInteger(catalogId) || catalogId <= 0) continue;
    const episodeId = record.episodeId == null ? undefined : Number(record.episodeId);
    if (episodeId != null && (!Number.isInteger(episodeId) || episodeId <= 0)) continue;
    items.push(episodeId ? { catalogId, episodeId } : { catalogId });
  }
  return items;
}

/** With `items`, check and correct the folders of those titles only. Without, every scan folder and stored title. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { items?: unknown } | null;
  const items = readItems(body?.items);
  const db = getDb();
  try {
    if (!items) {
      const pass = await checkFolderMasks(db);
      return NextResponse.json({ opened: pass.opened, failed: pass.failed, remaining: pass.remaining });
    }
    const titleIds = items.filter((item) => !item.episodeId).map((item) => item.catalogId);
    const episodeIds = items.flatMap((item) => (item.episodeId ? [item.episodeId] : []));
    const paths = filesForSelection(db, titleIds, episodeIds)
      .flatMap((file) => [file.path, ...file.versions.map((version) => version.path)])
      .filter((item): item is string => Boolean(item));
    if (!paths.length) return NextResponse.json({ error: "The selection has no file to open." }, { status: 400 });
    const result = repairTitlePaths(db, paths);
    rebuildCatalog(db);
    const folders = result.opened.filter((item) => isDirectory(item)).slice(0, 40);
    for (const folder of folders) await announceFolder(db, [folder]).catch(() => "");
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not check the folders." }, { status: 400 });
  }
}
