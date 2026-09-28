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

/** Ask Plex to scan the folder for a title it does not have yet. */
export async function askPlexToScan(catalogId: number, episodeId?: number | null): Promise<{ message: string }> {
  const db = getDb();
  const connector = listConnectors(db).find((item) => item.id === "plex");
  if (!connector?.enabled || !connector.baseUrl || !connector.apiKey) {
    throw new Error("Plex is not connected. Add it in Settings.");
  }
  const filePath = filePathForScan(catalogId, episodeId);
  if (!filePath) throw new Error("This title has no file path to scan.");
  const maps = readDetectSettings(db).pathMaps;
  const onPlex = pathOnPlex(filePath, maps);
  const locations = await fetchPlexLibraryFolders(connector.baseUrl, connector.apiKey, plexExcludedLibraries(db));
  const target = plexFolderToScan(locations, onPlex) ?? (onPlex === filePath ? null : plexFolderToScan(locations, filePath));
  if (!target) throw new Error("This file is not inside a Plex library folder.");
  await refreshPlexSectionFolder(connector.baseUrl, connector.apiKey, target.key, target.path);
  const name = target.path.split("/").filter(Boolean).pop() || "this folder";
  return { message: `Plex is scanning ${name}. Sync again after it finishes to show the title here.` };
}
