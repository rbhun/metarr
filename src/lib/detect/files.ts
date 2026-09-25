import type Database from "better-sqlite3";
import { parseAudioTracks, parseSubtitleTracks, parseVersions } from "@/lib/db";
import { assignSidecars, readSidecarNames } from "@/lib/detect/sidecars";
import type { ScanFile } from "@/lib/detect/targets";
import type { SubtitleTrack } from "@/lib/types";

type TitleFileRow = {
  id: number;
  kind: string;
  title: string;
  year: number | null;
  path: string | null;
  container: string | null;
  playable_label: string;
  audio_tracks: string | null;
  subtitle_tracks: string | null;
  versions_json: string | null;
};

type EpisodeFileRow = {
  id: number;
  catalog_id: number;
  title: string;
  season: number | null;
  episode: number | null;
  path: string | null;
  container: string | null;
  playable_label: string;
  audio_tracks: string | null;
  subtitle_tracks: string | null;
  versions_json: string | null;
  series_title: string;
};

function jsonValue(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function episodeCode(season: number | null, episode: number | null): string {
  if (season == null || episode == null) return "Special";
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function withSidecars(videoPath: string | null, tracks: SubtitleTrack[]): SubtitleTrack[] {
  return assignSidecars(videoPath, tracks, readSidecarNames(videoPath));
}

function fromTitle(row: TitleFileRow): ScanFile {
  const name = row.year ? `${row.title} (${row.year})` : row.title;
  return {
    label: name,
    path: row.path,
    container: row.container,
    playableLabel: row.playable_label,
    audioTracks: parseAudioTracks(jsonValue(row.audio_tracks)),
    subtitleTracks: withSidecars(row.path, parseSubtitleTracks(jsonValue(row.subtitle_tracks))),
    versions: parseVersions(row.versions_json).map((version) => ({
      ...version,
      subtitleTracks: withSidecars(version.path, version.subtitleTracks),
    })),
  };
}

function fromEpisode(row: EpisodeFileRow): ScanFile {
  return {
    label: `${row.series_title} ${episodeCode(row.season, row.episode)} ${row.title}`.trim(),
    path: row.path,
    container: row.container,
    playableLabel: row.playable_label,
    audioTracks: parseAudioTracks(jsonValue(row.audio_tracks)),
    subtitleTracks: withSidecars(row.path, parseSubtitleTracks(jsonValue(row.subtitle_tracks))),
    versions: parseVersions(row.versions_json).map((version) => ({
      ...version,
      subtitleTracks: withSidecars(version.path, version.subtitleTracks),
    })),
  };
}

const titleSql = `SELECT id, kind, title, year, path, container, playable_label, audio_tracks, subtitle_tracks, versions_json FROM catalog_titles`;
const episodeSql = `SELECT e.id, e.catalog_id, e.title, e.season, e.episode, e.path, e.container, e.playable_label,
  e.audio_tracks, e.subtitle_tracks, e.versions_json, t.title AS series_title
  FROM catalog_episodes e JOIN catalog_titles t ON t.id = e.catalog_id`;

export function filesForSelection(db: Database.Database, titleIds: number[], episodeIds: number[]): ScanFile[] {
  const files: ScanFile[] = [];
  const titleStmt = db.prepare(`${titleSql} WHERE id = ?`);
  const seriesStmt = db.prepare(`${episodeSql} WHERE e.catalog_id = ?`);
  const episodeStmt = db.prepare(`${episodeSql} WHERE e.id = ?`);
  for (const id of titleIds) {
    const row = titleStmt.get(id) as TitleFileRow | undefined;
    if (!row) continue;
    if (row.kind === "series") {
      files.push(...(seriesStmt.all(id) as EpisodeFileRow[]).map(fromEpisode));
    } else {
      files.push(fromTitle(row));
    }
  }
  for (const id of episodeIds) {
    const row = episodeStmt.get(id) as EpisodeFileRow | undefined;
    if (row) files.push(fromEpisode(row));
  }
  return files;
}

export function filesForLibrary(db: Database.Database): ScanFile[] {
  const movies = (db.prepare(`${titleSql} WHERE kind = 'movie'`).all() as TitleFileRow[]).map(fromTitle);
  const episodes = (db.prepare(episodeSql).all() as EpisodeFileRow[]).map(fromEpisode);
  return [...movies, ...episodes];
}
