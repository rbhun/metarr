import { fetchPlexLibraryFolders, plexFolderToScan, refreshPlexSectionFolder } from "@/lib/connectors/plex";
import { pathOnPlex } from "@/lib/detect/paths";
import { readDetectSettings } from "@/lib/detect/store";
import { getDb, listConnectors, parseVersions, plexExcludedLibraries } from "@/lib/db";

function firstPath(path: string | null, versionsJson: string | null): string | null {
  if (path?.trim()) return path.trim();
  const version = parseVersions(versionsJson).find((item) => item.path?.trim());
  return version?.path?.trim() || null;
}

function filePathForScan(catalogId: number, episodeId?: number | null): string | null {
  const db = getDb();
  if (episodeId) {
    const episode = db
      .prepare(`SELECT path, versions_json FROM catalog_episodes WHERE id = ? AND catalog_id = ?`)
      .get(episodeId, catalogId) as { path: string | null; versions_json: string | null } | undefined;
    if (!episode) throw new Error("Unknown episode.");
    return firstPath(episode.path, episode.versions_json);
  }
  const title = db.prepare(`SELECT path, versions_json, kind FROM catalog_titles WHERE id = ?`).get(catalogId) as
    | { path: string | null; versions_json: string | null; kind: string }
    | undefined;
  if (!title) throw new Error("Unknown title.");
  const direct = firstPath(title.path, title.versions_json);
  if (direct) return direct;
  if (title.kind !== "series") return null;
  const episodes = db
    .prepare(`SELECT path, versions_json FROM catalog_episodes WHERE catalog_id = ? ORDER BY COALESCE(season, 9999), COALESCE(episode, 9999)`)
    .all(catalogId) as Array<{ path: string | null; versions_json: string | null }>;
  for (const episode of episodes) {
    const path = firstPath(episode.path, episode.versions_json);
    if (path) return path;
  }
  return null;
}

export type ScanItem = { catalogId: number; episodeId?: number | null };

/** One Plex refresh per folder, so several episodes of one show are a single scan. */
export function uniqueScanFolders(targets: Array<{ key: string; path: string }>): Array<{ key: string; path: string }> {
  const seen = new Set<string>();
  const unique: Array<{ key: string; path: string }> = [];
  for (const target of targets) {
    const path = target.path.replace(/\\/g, "/").replace(/\/+$/, "");
    const id = `${target.key}\0${path.toLowerCase()}`;
    if (!path || seen.has(id)) continue;
    seen.add(id);
    unique.push({ key: target.key, path });
  }
  return unique;
}

function scanTarget(
  item: ScanItem,
  maps: ReturnType<typeof readDetectSettings>["pathMaps"],
  locations: Array<{ key: string; path: string }>,
): { key: string; path: string } {
  const filePath = filePathForScan(item.catalogId, item.episodeId);
  if (!filePath) throw new Error("This title has no file path to scan.");
  const onPlex = pathOnPlex(filePath, maps);
  const target = plexFolderToScan(locations, onPlex) ?? (onPlex === filePath ? null : plexFolderToScan(locations, filePath));
  if (!target) throw new Error("This file is not inside a Plex library folder.");
  return target;
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() || "this folder";
}

/** Ask Plex to scan the folder for one title. */
export async function askPlexToScan(catalogId: number, episodeId?: number | null): Promise<{ message: string }> {
  return askPlexToScanSelection([{ catalogId, episodeId }]);
}

/** Ask Plex to scan the folders for the selected titles and episodes. */
export async function askPlexToScanSelection(items: ScanItem[]): Promise<{ message: string }> {
  if (items.length === 0) throw new Error("Select a title first.");
  const db = getDb();
  const connector = listConnectors(db).find((item) => item.id === "plex");
  if (!connector?.enabled || !connector.baseUrl || !connector.apiKey) {
    throw new Error("Plex is not connected. Add it in Settings.");
  }
  const maps = readDetectSettings(db).pathMaps;
  const locations = await fetchPlexLibraryFolders(connector.baseUrl, connector.apiKey, plexExcludedLibraries(db));
  if (items.length === 1) {
    const only = items[0];
    if (!only) throw new Error("Select a title first.");
    const target = scanTarget(only, maps, locations);
    await refreshPlexSectionFolder(connector.baseUrl, connector.apiKey, target.key, target.path);
    return { message: `Plex is scanning ${folderName(target.path)}. Sync again after it finishes to show the title here.` };
  }
  const targets: Array<{ key: string; path: string }> = [];
  let skipped = 0;
  for (const item of items) {
    try {
      targets.push(scanTarget(item, maps, locations));
    } catch {
      skipped += 1;
    }
  }
  const folders = uniqueScanFolders(targets);
  if (folders.length === 0) throw new Error("None of the selected files are inside a Plex library folder.");
  let sent = 0;
  let sentName = "";
  let firstError: string | null = null;
  for (const folder of folders) {
    try {
      await refreshPlexSectionFolder(connector.baseUrl, connector.apiKey, folder.key, folder.path);
      sent += 1;
      if (!sentName) sentName = folderName(folder.path);
    } catch (error) {
      firstError = error instanceof Error ? error.message : "Plex did not scan.";
    }
  }
  if (sent === 0) throw new Error(firstError ?? "Plex did not scan.");
  const lead = sent === 1 ? `Plex is scanning ${sentName}.` : `Plex is scanning ${sent} folders.`;
  const missed = skipped ? ` ${skipped} selected ${skipped === 1 ? "row was" : "rows were"} skipped.` : "";
  const dropped = sent < folders.length ? " Some folders could not be sent." : "";
  return { message: `${lead}${missed}${dropped} Sync again after it finishes to show changes here.` };
}
