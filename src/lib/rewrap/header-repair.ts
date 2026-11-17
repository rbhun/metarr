import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { announceFolder } from "@/lib/announce";
import { parseAudioTracks, parseVersions } from "@/lib/db";
import { readDetectSettings } from "@/lib/detect/store";
import { inDetectWindow } from "@/lib/detect/schedule";
import { resolveMediaPath } from "@/lib/detect/paths";
import { dryRun } from "@/lib/dry-run";
import { languageCode } from "@/lib/media";
import { restoreBlankHeaderLanguages } from "@/lib/rewrap/run";
import { readRewrapSettings, rewrapTotals } from "@/lib/rewrap/store";
import { placeAtFront } from "@/lib/tasks/order";
import { stuckTools } from "@/lib/stuck";
import type { AudioTrack } from "@/lib/types";

const BATCH = 8;
export const HEADER_LANGUAGE_PATH = "metarr:header-languages";

/** Queue the library sweep at the front once. A finished sweep is not queued again. */
export function queueHeaderLanguageJob(db: Database.Database): boolean {
  const existing = db
    .prepare(`SELECT 1 AS ok FROM rewrap_jobs WHERE mode = 'header' AND status IN ('pending', 'running', 'done') LIMIT 1`)
    .get();
  if (existing) return false;
  const now = new Date().toISOString();
  const inserted = db
    .prepare(
      `INSERT INTO rewrap_jobs (path, mode, label, languages, immediate, status, created_at, rank) VALUES (?, 'header', 'Header languages', '[]', 1, 'pending', ?, 0)`,
    )
    .run(HEADER_LANGUAGE_PATH, now);
  placeAtFront(db, "rewrap", Number(inserted.lastInsertRowid));
  return true;
}

type RepairFile = {
  path: string | null;
  container: string | null;
  audioTracks: AudioTrack[];
};

function labeled(language: string | null | undefined): boolean {
  return Boolean(language && languageCode(language));
}

function isMkv(container: string | null, filePath: string | null): boolean {
  if ((container ?? "").toLowerCase() === "mkv") return true;
  return Boolean(filePath && filePath.toLowerCase().endsWith(".mkv"));
}

/** MKV files whose audio track has no language Plex can show. Sidecar audio is left out. */
export function mkvsWithBlankAudio(files: RepairFile[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const file of files) {
    if (!file.path || !isMkv(file.container, file.path)) continue;
    const internal = file.audioTracks.filter((track) => !track.file && !track.folderOnly);
    if (!internal.some((track) => !labeled(track.language))) continue;
    const key = file.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(file.path);
  }
  return paths;
}

function jsonValue(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** Library MKVs that still have a blank audio track, from the catalog Plex last reported. */
export function blankMkvPaths(db: Database.Database): string[] {
  return mkvsWithBlankAudio(libraryFiles(db));
}

function libraryFiles(db: Database.Database): RepairFile[] {
  const files: RepairFile[] = [];
  const add = (filePath: string | null, container: string | null, audio: string | null, versions: string | null) => {
    files.push({ path: filePath, container, audioTracks: parseAudioTracks(jsonValue(audio)) });
    for (const version of parseVersions(versions)) {
      if (!version.path || version.path === filePath) continue;
      files.push({ path: version.path, container: version.container, audioTracks: version.audioTracks });
    }
  };
  const titles = db
    .prepare(
      `SELECT path, container, audio_tracks, versions_json FROM catalog_titles WHERE kind = 'movie'`,
    )
    .all() as Array<{ path: string | null; container: string | null; audio_tracks: string | null; versions_json: string | null }>;
  for (const row of titles) add(row.path, row.container, row.audio_tracks, row.versions_json);
  const episodes = db
    .prepare(`SELECT path, container, audio_tracks, versions_json FROM catalog_episodes`)
    .all() as Array<{ path: string | null; container: string | null; audio_tracks: string | null; versions_json: string | null }>;
  for (const row of episodes) add(row.path, row.container, row.audio_tracks, row.versions_json);
  return files;
}

function existsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function remember(db: Database.Database, filePath: string, mtime: number) {
  db.prepare(
    `INSERT INTO header_language_checks (path, mtime_ms, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, checked_at = excluded.checked_at`,
  ).run(filePath, mtime, new Date().toISOString());
}

/**
 * Write a header language onto blank MKV audio tracks. A few files are checked each pass.
 * The scheduled pass waits for rewrap hours and an empty queue. The header job passes
 * `ignoreSchedule` and walks the library now. A track that already has a language is left alone.
 */
export async function repairBlankHeaderLanguages(
  db: Database.Database,
  options?: { ignoreSchedule?: boolean; limit?: number },
): Promise<{ restored: number; probed: number }> {
  if (dryRun() || stuckTools().length) return { restored: 0, probed: 0 };
  if (!options?.ignoreSchedule) {
    const settings = readRewrapSettings(db);
    if (!settings.enabled || !inDetectWindow(new Date().getHours(), settings.startHour, settings.endHour)) return { restored: 0, probed: 0 };
    const totals = rewrapTotals(db);
    if (totals.pending > 0 || totals.running > 0) return { restored: 0, probed: 0 };
  }
  const limit = options?.limit ?? BATCH;

  const maps = readDetectSettings(db).pathMaps;
  const checked = new Map(
    (db.prepare(`SELECT path, mtime_ms FROM header_language_checks`).all() as Array<{ path: string; mtime_ms: number }>).map((row) => [
      row.path.toLowerCase(),
      row.mtime_ms,
    ]),
  );
  const folders = new Set<string>();
  let restored = 0;
  let probed = 0;
  for (const filePath of blankMkvPaths(db)) {
    if (probed >= limit) break;
    const key = filePath.toLowerCase();
    const recorded = checked.get(key);
    const local = resolveMediaPath(filePath, maps, existsFile);
    if (!local) {
      if (recorded !== -1) remember(db, filePath, -1);
      checked.set(key, -1);
      continue;
    }
    let mtime = 0;
    try {
      mtime = Math.round(fs.statSync(local).mtimeMs);
    } catch {
      continue;
    }
    if (recorded === mtime) continue;
    probed += 1;
    try {
      const wrote = await restoreBlankHeaderLanguages(local);
      const after = Math.round(fs.statSync(local).mtimeMs);
      remember(db, filePath, after);
      checked.set(key, after);
      if (wrote > 0) {
        restored += 1;
        folders.add(path.dirname(local));
        folders.add(path.dirname(filePath));
      }
    } catch (caught) {
      remember(db, filePath, mtime);
      checked.set(key, mtime);
      console.error(`Could not write the header language on ${path.basename(local)}.`, caught);
    }
  }
  if (restored > 0) {
    try {
      await announceFolder(db, [...folders]);
    } catch {
      // Plex is asked again on the next sync.
    }
  }
  return { restored, probed };
}
