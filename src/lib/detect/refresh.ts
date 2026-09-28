import fs from "node:fs";
import type Database from "better-sqlite3";
import { fetchBazarrEpisode, fetchBazarrMovie } from "@/lib/connectors/bazarr";
import { fetchPlexMetadata } from "@/lib/connectors/plex";
import { fetchRadarrMovie } from "@/lib/connectors/radarr";
import { fetchSonarrEpisode } from "@/lib/connectors/sonarr";
import { resolveMediaPath } from "@/lib/detect/paths";
import { readDetectSettings } from "@/lib/detect/store";
import { readFolderScan, scanOneFile } from "@/lib/folder-scan";
import { languageName, sameSpokenLanguage } from "@/lib/media";
import { sourceDraft } from "@/lib/source";
import { insertSourceRecords, listConnectors } from "@/lib/db";
import type { SourceDraft } from "@/lib/types";

export type SourceReport = {
  plexAudio?: Array<string | null>;
  plexSubtitles?: Array<string | null>;
  radarrAudio?: string[];
  radarrSubtitles?: string[];
  sonarrAudio?: string[];
  sonarrSubtitles?: string[];
  fileAudio?: Array<string | null>;
  fileSubtitles?: Array<string | null>;
  bazarrSubtitles?: string[];
};

type StoredRow = {
  connector: string;
  kind: string;
  external_key: string;
  parent_key: string | null;
  path: string | null;
  files_json: string;
  title: string;
  series_title: string | null;
  year: number | null;
  imdb_id: string | null;
  tmdb_id: string | null;
  tvdb_id: string | null;
};

function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, "/") === right.replace(/\\/g, "/");
}

function filesContain(filesJson: string, videoPath: string): boolean {
  try {
    const files = JSON.parse(filesJson) as unknown;
    if (!Array.isArray(files)) return false;
    return files.some((item) => {
      if (!item || typeof item !== "object") return false;
      const filePath = (item as { path?: unknown }).path;
      return typeof filePath === "string" && samePath(filePath, videoPath);
    });
  } catch {
    return false;
  }
}

function rowMatches(row: StoredRow, videoPaths: string[]): boolean {
  return videoPaths.some((videoPath) => (row.path && samePath(row.path, videoPath)) || filesContain(row.files_json, videoPath));
}

function spoken(value: string | null | undefined): string | null {
  if (!value) return null;
  return languageName(value) ?? value;
}

function listedValue(trackLanguage: unknown, languages: string[]): string | null {
  if (!languages.length) return null;
  const named = typeof trackLanguage === "string" ? spoken(trackLanguage) : null;
  if (!named) return null;
  return languages.some((language) => sameSpokenLanguage(language, named)) ? spoken(named) : null;
}

function indexedValue(values: Array<string | null>, ordinal: number): string | null {
  return spoken(values[ordinal] ?? null);
}

function assign(track: Record<string, unknown>, key: string, value: string | null) {
  const sources = track.sources && typeof track.sources === "object" && !Array.isArray(track.sources) ? { ...(track.sources as Record<string, unknown>) } : {};
  sources[key] = value;
  track.sources = sources;
}

/** Write the languages just read for this file onto the tracks that already belong to it. */
export function paintTrackList(tracks: unknown, kind: "audio" | "subtitle", report: SourceReport): boolean {
  if (!Array.isArray(tracks)) return false;
  let changed = false;
  tracks.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const track = item as Record<string, unknown>;
    const ordinal = typeof track.streamIndex === "number" ? track.streamIndex : index;
    let touched = false;
    if (kind === "audio") {
      if (report.plexAudio) {
        assign(track, "plex", indexedValue(report.plexAudio, ordinal));
        touched = true;
      }
      if (report.radarrAudio) {
        assign(track, "radarr", listedValue(track.language, report.radarrAudio));
        touched = true;
      }
      if (report.sonarrAudio) {
        assign(track, "sonarr", listedValue(track.language, report.sonarrAudio));
        touched = true;
      }
      if (report.fileAudio) {
        assign(track, "file", indexedValue(report.fileAudio, ordinal));
        touched = true;
      }
    } else {
      if (report.plexSubtitles) {
        assign(track, "plex", indexedValue(report.plexSubtitles, ordinal));
        touched = true;
      }
      if (report.radarrSubtitles) {
        assign(track, "radarr", listedValue(track.language, report.radarrSubtitles));
        touched = true;
      }
      if (report.sonarrSubtitles) {
        assign(track, "sonarr", listedValue(track.language, report.sonarrSubtitles));
        touched = true;
      }
      if (report.bazarrSubtitles) {
        assign(track, "bazarr", listedValue(track.language, report.bazarrSubtitles));
        touched = true;
      }
      if (report.fileSubtitles) {
        assign(track, "file", indexedValue(report.fileSubtitles, ordinal));
        touched = true;
      }
    }
    if (touched) changed = true;
  });
  return changed;
}

function paintVersions(versions: unknown, videoPath: string, report: SourceReport): boolean {
  if (!Array.isArray(versions)) return false;
  let changed = false;
  for (const item of versions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const version = item as Record<string, unknown>;
    const versionPath = typeof version.path === "string" ? version.path : null;
    if (!versionPath || !samePath(versionPath, videoPath)) continue;
    if (paintTrackList(version.audioTracks, "audio", report)) changed = true;
    if (paintTrackList(version.subtitleTracks, "subtitle", report)) changed = true;
  }
  return changed;
}

export function paintFileSources(db: Database.Database, videoPath: string, report: SourceReport) {
  const tables = ["catalog_titles", "catalog_episodes"] as const;
  for (const table of tables) {
    const rows = db
      .prepare(
        `SELECT id, path, audio_tracks, subtitle_tracks, versions_json
         FROM ${table}
         WHERE path = ?
            OR instr(ifnull(audio_tracks, ''), ?) > 0
            OR instr(ifnull(subtitle_tracks, ''), ?) > 0
            OR instr(ifnull(versions_json, ''), ?) > 0`,
      )
      .all(videoPath, videoPath, videoPath, videoPath) as Array<{
      id: number;
      path: string | null;
      audio_tracks: string | null;
      subtitle_tracks: string | null;
      versions_json: string | null;
    }>;
    const update = db.prepare(`UPDATE ${table} SET audio_tracks = ?, subtitle_tracks = ?, versions_json = ? WHERE id = ?`);
    for (const row of rows) {
      const audio = parseJson(row.audio_tracks);
      const subtitles = parseJson(row.subtitle_tracks);
      const versions = parseJson(row.versions_json);
      let changed = false;
      if (row.path && samePath(row.path, videoPath)) {
        if (paintTrackList(audio, "audio", report)) changed = true;
        if (paintTrackList(subtitles, "subtitle", report)) changed = true;
      }
      if (paintVersions(versions, videoPath, report)) changed = true;
      if (!changed) continue;
      update.run(JSON.stringify(audio ?? []), JSON.stringify(subtitles ?? []), JSON.stringify(versions ?? []), row.id);
    }
  }
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function languagesOf(draft: SourceDraft, videoPath: string, kind: "audio" | "subtitle"): string[] {
  const file = draft.files.find((item) => item.path && samePath(item.path, videoPath));
  const listed = kind === "audio" ? (file?.audioLanguages ?? draft.audioLanguages) : (file?.subtitleLanguages ?? draft.subtitleLanguages);
  return listed;
}

function tracksOf(draft: SourceDraft, videoPath: string, kind: "audio" | "subtitle"): Array<string | null> | null {
  const file = draft.files.find((item) => item.path && samePath(item.path, videoPath));
  const tracks = kind === "audio" ? file?.audioTracks : file?.subtitleTracks;
  if (!tracks?.length) return null;
  return tracks.map((track) => track.language);
}

function addDraft(report: SourceReport, draft: SourceDraft, videoPath: string) {
  if (draft.connector === "plex") {
    report.plexAudio = tracksOf(draft, videoPath, "audio") ?? languagesOf(draft, videoPath, "audio").map((language) => language);
    report.plexSubtitles = tracksOf(draft, videoPath, "subtitle") ?? languagesOf(draft, videoPath, "subtitle").map((language) => language);
  } else if (draft.connector === "radarr") {
    report.radarrAudio = languagesOf(draft, videoPath, "audio");
    report.radarrSubtitles = languagesOf(draft, videoPath, "subtitle");
  } else if (draft.connector === "sonarr" && draft.kind === "episode") {
    report.sonarrAudio = languagesOf(draft, videoPath, "audio");
    report.sonarrSubtitles = languagesOf(draft, videoPath, "subtitle");
  } else if (draft.connector === "bazarr") {
    report.bazarrSubtitles = languagesOf(draft, videoPath, "subtitle");
  } else if (draft.connector === "files") {
    report.fileAudio = tracksOf(draft, videoPath, "audio") ?? [];
    report.fileSubtitles = tracksOf(draft, videoPath, "subtitle") ?? [];
  }
}

function seriesFor(db: Database.Database, episode: StoredRow): SourceDraft {
  const seriesId = episode.parent_key?.match(/^sonarr-series:(\d+)$/)?.[1];
  const series = seriesId
    ? (db
        .prepare(
          `SELECT title, year, imdb_id, tmdb_id, tvdb_id, parent_key
           FROM source_records WHERE connector = 'sonarr' AND kind = 'series' AND external_key = ?`,
        )
        .get(seriesId) as
        | { title: string; year: number | null; imdb_id: string | null; tmdb_id: string | null; tvdb_id: string | null; parent_key: string | null }
        | undefined)
    : undefined;
  return sourceDraft({
    connector: "sonarr",
    kind: "series",
    externalKey: seriesId ?? episode.external_key,
    title: series?.title || episode.series_title || "Untitled series",
    year: series?.year ?? episode.year,
    imdbId: series?.imdb_id ?? episode.imdb_id,
    tmdbId: series?.tmdb_id ?? episode.tmdb_id,
    tvdbId: series?.tvdb_id ?? episode.tvdb_id,
    parentKey: series?.parent_key ?? episode.parent_key,
  });
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasAudioLanguage(draft: SourceDraft | null): boolean {
  if (!draft) return false;
  return draft.audioLanguages.length > 0 || draft.files.some((file) => (file.audioTracks ?? []).some((track) => track.language) || file.audioLanguages.length > 0);
}

/**
 * Read this file back from each source that has it, and store that on the open library row.
 * A full library sync, including the folder walk, is left for Sync.
 */
export async function refreshFileSources(db: Database.Database, videoPaths: string[], options?: { waitForPlex?: boolean }): Promise<string> {
  const paths = [...new Set(videoPaths.filter(Boolean))];
  if (!paths.length) return "";
  const rows = (
    db.prepare(`SELECT connector, kind, external_key, parent_key, path, files_json, title, series_title, year, imdb_id, tmdb_id, tvdb_id FROM source_records`).all() as StoredRow[]
  ).filter((row) => rowMatches(row, paths));
  const connectors = listConnectors(db);
  const records: SourceDraft[] = [];
  const names: string[] = [];

  const plex = connectors.find((connector) => connector.id === "plex" && connector.enabled && connector.baseUrl && connector.apiKey);
  const plexKeys = [
    ...new Set(
      rows
        .filter((row) => row.connector === "plex")
        .map((row) => row.external_key.match(/^(?:item|episode):(\d+)$/)?.[1])
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  if (plex && plexKeys.length) {
    for (const ratingKey of plexKeys) {
      try {
        let draft = await fetchPlexMetadata(plex.baseUrl, plex.apiKey, ratingKey);
        if (options?.waitForPlex) {
          for (let attempt = 0; attempt < 4 && !hasAudioLanguage(draft); attempt += 1) {
            await delay(2000);
            draft = await fetchPlexMetadata(plex.baseUrl, plex.apiKey, ratingKey);
          }
        }
        if (draft) {
          records.push(draft);
          names.push("Plex");
        }
      } catch {
        // The file write already succeeded. This source stays as it was.
      }
    }
  }

  const radarr = connectors.find((connector) => connector.id === "radarr" && connector.enabled && connector.baseUrl && connector.apiKey);
  const radarrIds = [
    ...new Set(rows.filter((row) => row.connector === "radarr" && /^\d+$/.test(row.external_key)).map((row) => Number(row.external_key))),
  ];
  if (radarr) {
    for (const movieId of radarrIds) {
      try {
        const draft = await fetchRadarrMovie(radarr.baseUrl, radarr.apiKey, movieId);
        if (draft) {
          records.push(draft);
          names.push("Radarr");
        }
      } catch {
        // Keep the previous Radarr row.
      }
    }
  }

  const sonarr = connectors.find((connector) => connector.id === "sonarr" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (sonarr) {
    for (const row of rows.filter((item) => item.connector === "sonarr" && item.kind === "episode" && /^\d+$/.test(item.external_key))) {
      try {
        const draft = await fetchSonarrEpisode(sonarr.baseUrl, sonarr.apiKey, Number(row.external_key), seriesFor(db, row));
        if (draft) {
          records.push(draft);
          names.push("Sonarr");
        }
      } catch {
        // Keep the previous Sonarr row.
      }
    }
  }

  const bazarr = connectors.find((connector) => connector.id === "bazarr" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (bazarr) {
    for (const row of rows.filter((item) => item.connector === "bazarr")) {
      try {
        const movieId = row.external_key.match(/^radarr:(\d+)$/)?.[1];
        const seriesId = row.parent_key?.match(/^sonarr-series:(\d+)$/)?.[1];
        const videoPath = paths.find((candidate) => rowMatches(row, [candidate]));
        const draft = movieId
          ? await fetchBazarrMovie(bazarr.baseUrl, bazarr.apiKey, Number(movieId))
          : seriesId && videoPath
            ? await fetchBazarrEpisode(bazarr.baseUrl, bazarr.apiKey, seriesId, videoPath)
            : null;
        if (draft) {
          records.push(draft);
          names.push("Bazarr");
        }
      } catch {
        // Keep the previous Bazarr row.
      }
    }
  }

  const scan = readFolderScan(db);
  if (scan.enabled) {
    const maps = readDetectSettings(db).pathMaps;
    for (const videoPath of paths) {
      const local = resolveMediaPath(videoPath, maps, (candidate) => {
        try {
          return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
        } catch {
          return false;
        }
      });
      if (!local) continue;
      try {
        const drafted = await scanOneFile(local, null);
        if (!drafted) continue;
        records.push({
          ...drafted,
          externalKey: `path:${videoPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}`,
          path: videoPath,
          files: drafted.files.map((file) => ({ ...file, path: videoPath })),
        });
        names.push("File scan");
      } catch {
        // The folder scanner stays as it was for this file.
      }
    }
  }

  const unique = [...new Set(names)];
  if (!records.length) return "";
  const write = db.transaction(() => {
    insertSourceRecords(db, records);
    for (const videoPath of paths) {
      const report: SourceReport = {};
      for (const record of records) addDraft(report, record, videoPath);
      paintFileSources(db, videoPath, report);
    }
  });
  write();
  return unique.length ? `Re-read this file from ${joinNames(unique)}.` : "";
}
