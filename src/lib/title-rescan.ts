import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { rebuildCatalog } from "@/lib/catalog";
import { filesForSelection } from "@/lib/detect/files";
import { queueFormatRefresh } from "@/lib/detect/format-refresh";
import { resolveMediaPath } from "@/lib/detect/paths";
import { refreshFileSources } from "@/lib/detect/refresh";
import { readDetectSettings, hasUnwritten } from "@/lib/detect/store";
import { kickDetectWorker } from "@/lib/detect/worker";
import {
  chooseMatch,
  filesRepresentingFolders,
  formatRefreshPaths,
  listVideos,
  pathKey,
  readFolderScan,
  scanOneFile,
  underKnownSeries,
} from "@/lib/folder-scan";
import { insertSourceRecords, loadSourceRecords, parseVersions } from "@/lib/db";
import type { SourceDraft } from "@/lib/types";

function uniquePaths(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = pathKey(trimmed) ?? trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(trimmed);
  }
  return paths;
}

function pathsFromSelection(db: Database.Database, catalogId: number, episodeId?: number | null): string[] {
  const files = filesForSelection(db, episodeId ? [] : [catalogId], episodeId ? [episodeId] : []);
  return uniquePaths(files.flatMap((file) => [file.path, ...file.versions.map((version) => version.path)]));
}

/** Movie: the folder that holds the file. Series: each season (or show) folder that holds an episode. */
function foldersForPaths(paths: string[]): string[] {
  const folders = new Set<string>();
  for (const filePath of paths) {
    const directory = path.dirname(filePath);
    if (directory && directory !== "." && directory !== "/") folders.add(directory);
  }
  return [...folders];
}

function localizeExisting(filePath: string, maps: ReturnType<typeof readDetectSettings>["pathMaps"]): string | null {
  return resolveMediaPath(filePath, maps, (candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function localizeFolder(folder: string, maps: ReturnType<typeof readDetectSettings>["pathMaps"]): string | null {
  return resolveMediaPath(folder, maps, (candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}

function sameTitle(match: SourceDraft, identity: { title: string; year: number | null; imdbId: string | null; tmdbId: string | null; tvdbId: string | null }): boolean {
  if (identity.imdbId && match.imdbId && identity.imdbId === match.imdbId) return true;
  if (identity.tmdbId && match.tmdbId && identity.tmdbId === match.tmdbId) return true;
  if (identity.tvdbId && match.tvdbId && identity.tvdbId === match.tvdbId) return true;
  const left = match.title.trim().toLowerCase();
  const right = identity.title.trim().toLowerCase();
  if (!left || left !== right) return false;
  if (identity.year != null && match.year != null) return identity.year === match.year;
  return true;
}

/**
 * Re-read the files for one library title (or one episode) from disk and from the
 * connected apps, then rebuild the catalog so the library row matches.
 */
export async function rescanTitle(
  db: Database.Database,
  catalogId: number,
  episodeId?: number | null,
): Promise<{ message: string; matchKey: string | null; scanned: number; catalogId: number | null }> {
  const title = db
    .prepare(`SELECT id, kind, title, year, imdb_id, tmdb_id, tvdb_id, match_key, path, versions_json FROM catalog_titles WHERE id = ?`)
    .get(catalogId) as
    | {
        id: number;
        kind: string;
        title: string;
        year: number | null;
        imdb_id: string | null;
        tmdb_id: string | null;
        tvdb_id: string | null;
        match_key: string | null;
        path: string | null;
        versions_json: string | null;
      }
    | undefined;
  if (!title) throw new Error("Unknown title.");

  const knownPaths = pathsFromSelection(db, catalogId, episodeId);
  if (!knownPaths.length) {
    const fallback = uniquePaths([title.path, ...parseVersions(title.versions_json).map((version) => version.path)]);
    if (!fallback.length) throw new Error("This title has no file path to scan.");
    knownPaths.push(...fallback);
  }

  const maps = readDetectSettings(db).pathMaps;
  const known = loadSourceRecords(db);
  const identity = {
    title: title.title,
    year: title.year,
    imdbId: title.imdb_id,
    tmdbId: title.tmdb_id,
    tvdbId: title.tvdb_id,
  };

  const scan = readFolderScan(db);
  const folderPaths = new Set<string>(knownPaths);
  for (const folder of foldersForPaths(knownPaths)) {
    const localFolder = localizeFolder(folder, maps) ?? (fs.existsSync(folder) ? folder : null);
    if (!localFolder) continue;
    let listed: string[] = [];
    try {
      listed = listVideos(localFolder);
    } catch {
      continue;
    }
    for (const file of filesRepresentingFolders(listed, known)) {
      const match = chooseMatch(known, file, scan.roots);
      if (match && !sameTitle(match, identity)) continue;
      if (!match) {
        // A brand-new file in this title's folder still belongs here when the path is under it.
        const underKnown = knownPaths.some((knownPath) => {
          const parent = path.dirname(knownPath).replace(/\\/g, "/").toLowerCase();
          const candidate = file.replace(/\\/g, "/").toLowerCase();
          return candidate.startsWith(`${parent}/`);
        });
        if (!underKnown) continue;
      }
      folderPaths.add(file);
    }
  }

  const drafts: SourceDraft[] = [];
  for (const videoPath of folderPaths) {
    const local = localizeExisting(videoPath, maps) ?? (fs.existsSync(videoPath) ? videoPath : null);
    if (!local) continue;
    try {
      const match = chooseMatch(known, videoPath, scan.roots) ?? chooseMatch(known, local, scan.roots);
      const drafted = await scanOneFile(local, match, {
        underSeries: underKnownSeries(known, videoPath, scan.roots) || underKnownSeries(known, local, scan.roots),
      });
      if (!drafted) continue;
      drafts.push({
        ...drafted,
        externalKey: `path:${pathKey(videoPath) ?? videoPath}`,
        path: videoPath,
        files: drafted.files.map((file) => ({ ...file, path: videoPath })),
      });
    } catch {
      // Leave this path for the app refresh below.
    }
  }

  if (drafts.length) {
    insertSourceRecords(db, drafts);
    const refresh = formatRefreshPaths(known, drafts);
    if (refresh.length) queueFormatRefresh(db, refresh);
    if (refresh.length || hasUnwritten(db)) kickDetectWorker();
  }

  const refreshed = await refreshFileSources(db, [...folderPaths]);
  rebuildCatalog(db);

  const next = title.match_key
    ? (db.prepare(`SELECT id FROM catalog_titles WHERE match_key = ?`).get(title.match_key) as { id: number } | undefined)
    : (db
        .prepare(
          `SELECT id FROM catalog_titles
           WHERE kind = ? AND lower(title) = lower(?) AND (year IS ? OR year = ?)
           ORDER BY id LIMIT 1`,
        )
        .get(title.kind, title.title, title.year, title.year) as { id: number } | undefined);

  const scanned = drafts.length || folderPaths.size;
  const parts = [
    scanned === 1 ? "Re-read 1 file." : `Re-read ${scanned} files.`,
    refreshed || null,
    "The library row was rebuilt from the sources.",
  ].filter(Boolean);
  return {
    message: parts.join(" "),
    matchKey: title.match_key,
    scanned,
    catalogId: next?.id ?? null,
  };
}
