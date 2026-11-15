import type Database from "better-sqlite3";
import { parseAudioTracks, parseSubtitleTracks, parseVersions } from "@/lib/db";
import { assignSidecars, readSidecarNames, withAudioSidecars } from "@/lib/detect/sidecars";
import type { ScanFile } from "@/lib/detect/targets";
import type { AudioTrack, SubtitleTrack } from "@/lib/types";

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

function withAudio(videoPath: string | null, tracks: AudioTrack[]): AudioTrack[] {
  return withAudioSidecars(videoPath, tracks);
}

function fromTitle(row: TitleFileRow): ScanFile {
  const name = row.year ? `${row.title} (${row.year})` : row.title;
  return {
    titleId: row.id,
    label: name,
    path: row.path,
    container: row.container,
    playableLabel: row.playable_label,
    audioTracks: withAudio(row.path, parseAudioTracks(jsonValue(row.audio_tracks))),
    subtitleTracks: withSidecars(row.path, parseSubtitleTracks(jsonValue(row.subtitle_tracks))),
    versions: parseVersions(row.versions_json).map((version) => ({
      ...version,
      audioTracks: withAudio(version.path, version.audioTracks),
      subtitleTracks: withSidecars(version.path, version.subtitleTracks),
    })),
  };
}

function fromEpisode(row: EpisodeFileRow): ScanFile {
  return {
    titleId: row.catalog_id,
    label: `${row.series_title} ${episodeCode(row.season, row.episode)} ${row.title}`.trim(),
    path: row.path,
    container: row.container,
    playableLabel: row.playable_label,
    audioTracks: withAudio(row.path, parseAudioTracks(jsonValue(row.audio_tracks))),
    subtitleTracks: withSidecars(row.path, parseSubtitleTracks(jsonValue(row.subtitle_tracks))),
    versions: parseVersions(row.versions_json).map((version) => ({
      ...version,
      audioTracks: withAudio(version.path, version.audioTracks),
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

/** Paths the Rips and Tasks pages need. No track JSON and no folder listing, so a page does not wait on the NAS. */
export type LibraryMedia = {
  titleId: number;
  label: string;
  path: string | null;
  container: string | null;
  playableLabel: string;
  versions: Array<{ path: string | null; container: string | null; playableLabel: string }>;
};

type LibrarySnapshot = {
  at: number;
  files: LibraryMedia[];
  paths: Map<string, number>;
  folders: Map<string, number | null>;
};

const MEDIA_MS = 10_000;
const snapshots = new Map<string, LibrarySnapshot>();

function playableLabel(value: unknown): string {
  if (
    value === "video" ||
    value === "dvd" ||
    value === "bluray" ||
    value === "iso" ||
    value === "dvd-iso" ||
    value === "bluray-iso" ||
    value === "disc" ||
    value === "missing"
  ) {
    return value;
  }
  return "missing";
}

function versionMedia(value: string | null): LibraryMedia["versions"] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const versions: LibraryMedia["versions"] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const version = item as Record<string, unknown>;
    versions.push({
      path: typeof version.path === "string" ? version.path : null,
      container: typeof version.container === "string" ? version.container : null,
      playableLabel: playableLabel(version.playableLabel),
    });
  }
  return versions;
}

function rememberPath(paths: Map<string, number>, filePath: string | null, titleId: number) {
  if (!filePath) return;
  paths.set(filePath, titleId);
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized !== filePath) paths.set(normalized, titleId);
}

/** Every ancestor folder of a movie file, so a sidecar in that folder still finds the one movie there. */
function rememberFolders(folders: Map<string, number | null>, filePath: string, titleId: number) {
  let directory = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  while (true) {
    const slash = directory.lastIndexOf("/");
    if (slash <= 0) break;
    directory = directory.slice(0, slash);
    const current = folders.get(directory);
    if (folders.has(directory) && current == null) continue;
    if (current == null) folders.set(directory, titleId);
    else if (current !== titleId) folders.set(directory, null);
  }
}

function loadSnapshot(db: Database.Database): LibrarySnapshot {
  const paths = new Map<string, number>();
  const folders = new Map<string, number | null>();
  const files: LibraryMedia[] = [];
  const movies = db
    .prepare(`SELECT id, title, year, path, container, playable_label, versions_json FROM catalog_titles WHERE kind = 'movie'`)
    .all() as Array<{ id: number; title: string; year: number | null; path: string | null; container: string | null; playable_label: string; versions_json: string | null }>;
  for (const row of movies) {
    const versions = versionMedia(row.versions_json);
    const file: LibraryMedia = {
      titleId: row.id,
      label: row.year ? `${row.title} (${row.year})` : row.title,
      path: row.path,
      container: row.container,
      playableLabel: playableLabel(row.playable_label),
      versions,
    };
    files.push(file);
    rememberPath(paths, file.path, file.titleId);
    for (const version of versions) rememberPath(paths, version.path, file.titleId);
    if (file.path) rememberFolders(folders, file.path, file.titleId);
  }
  const episodes = db
    .prepare(
      `SELECT e.catalog_id, e.title, e.season, e.episode, e.path, e.container, e.playable_label, e.versions_json, t.title AS series_title
       FROM catalog_episodes e JOIN catalog_titles t ON t.id = e.catalog_id`,
    )
    .all() as Array<{
    catalog_id: number;
    title: string;
    season: number | null;
    episode: number | null;
    path: string | null;
    container: string | null;
    playable_label: string;
    versions_json: string | null;
    series_title: string;
  }>;
  for (const row of episodes) {
    const code = row.season == null || row.episode == null ? "Special" : `S${String(row.season).padStart(2, "0")}E${String(row.episode).padStart(2, "0")}`;
    const versions = versionMedia(row.versions_json);
    const file: LibraryMedia = {
      titleId: row.catalog_id,
      label: `${row.series_title} ${code} ${row.title}`.trim(),
      path: row.path,
      container: row.container,
      playableLabel: playableLabel(row.playable_label),
      versions,
    };
    files.push(file);
    rememberPath(paths, file.path, file.titleId);
    for (const version of versions) rememberPath(paths, version.path, file.titleId);
  }
  return { at: Date.now(), files, paths, folders };
}

/** Catalog paths for the Rips and Tasks pages. Reused briefly so a poll does not parse the library again. */
export function librarySnapshot(db: Database.Database): LibrarySnapshot {
  const name = db.name;
  if (name && name !== ":memory:") {
    const cached = snapshots.get(name);
    if (cached && Date.now() - cached.at < MEDIA_MS) return cached;
  }
  const snapshot = loadSnapshot(db);
  if (name && name !== ":memory:") snapshots.set(name, snapshot);
  return snapshot;
}
