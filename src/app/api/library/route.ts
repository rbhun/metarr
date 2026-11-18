import { ensureHoverSources, rebuildCatalog } from "@/lib/catalog";
import { clearLibrary, getDb, getMeta, queryLibrary } from "@/lib/db";
import { parseRules } from "@/lib/filters";
import { FOLDER_MASK_KNOWN_KEY, refreshClosedTitles } from "@/lib/plex-access";
import { outputDirectory } from "@/lib/remux/source";
import { titleIdForPath } from "@/lib/title-link";
import { getSyncStatus } from "@/lib/sync";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const db = getDb();
  if (!getSyncStatus().running) {
    ensureHoverSources(db);
    // Titles from Radarr and Bazarr are already stored. Stamp the ones whose folder Plex cannot read.
    if (getMeta(db, FOLDER_MASK_KNOWN_KEY) !== "1" && refreshClosedTitles(db, false).updated) rebuildCatalog(db);
  }
  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind");
  const kind = kindParam === "movie" || kindParam === "series" ? kindParam : "all";
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50));
  const file = url.searchParams.get("file")?.trim() ?? "";
  // Catalog ids change on every rebuild, so links from Rips and Tasks carry the file path instead.
  const id = file ? (titleIdForPath(getDb(), file, outputDirectory(file)) ?? -1) : null;
  const library = queryLibrary({
    kind,
    rules: parseRules(url.searchParams.get("rules")),
    q: url.searchParams.get("q") ?? "",
    offset,
    limit,
    ...(id != null ? { id } : {}),
  });
  return NextResponse.json(library);
}

export async function DELETE() {
  if (getSyncStatus().running) {
    return NextResponse.json({ error: "Wait for the sync to finish before clearing the library." }, { status: 409 });
  }
  clearLibrary();
  return NextResponse.json({ ok: true });
}
