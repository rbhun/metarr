import type Database from "better-sqlite3";

type StampInput = {
  path: string;
  kind: "audio" | "subtitle";
  ordinal: number;
  language: string;
  role: "commentary" | "forced" | "short" | null;
  renamedTo: string | null;
};

type CatalogRow = {
  id: number;
  path: string | null;
  audio_tracks: string | null;
  subtitle_tracks: string | null;
  versions_json: string | null;
  audio_languages: string;
  subtitle_languages: string;
};

function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, "/") === right.replace(/\\/g, "/");
}

function addLanguage(value: unknown, language: string): string[] {
  const current = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  if (current.some((item) => item.toLowerCase() === language.toLowerCase())) return current;
  return [...current, language];
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stampTracks(value: unknown, videoPath: string | null, input: StampInput): boolean {
  if (!Array.isArray(value)) return false;
  let changed = false;
  value.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const track = item as Record<string, unknown>;
    if (input.kind === "subtitle" && track.placement === "external") {
      const file = typeof track.file === "string" ? track.file : "";
      if (!file || !samePath(file, input.path)) return;
      if (!track.language) track.language = input.language;
      if (input.renamedTo) track.file = input.renamedTo;
      if (input.role === "forced") track.forced = true;
      changed = true;
      return;
    }
    if (input.kind === "subtitle" && track.placement === "external") return;
    if (!videoPath || !samePath(videoPath, input.path)) return;
    if (input.kind === "subtitle" && track.placement === "burn-in") return;
    const streamIndex = typeof track.streamIndex === "number" ? track.streamIndex : index;
    if (streamIndex !== input.ordinal) return;
    if (!track.language) {
      track.language = input.language;
      changed = true;
    }
    if (input.kind === "subtitle" && input.role === "forced" && track.forced !== true) {
      track.forced = true;
      changed = true;
    }
    if (input.kind === "audio" && input.role === "commentary") {
      const label = typeof track.label === "string" ? track.label : "";
      if (!label) {
        track.label = "Commentary";
        changed = true;
      }
    }
  });
  return changed;
}

function stampRow(row: CatalogRow, input: StampInput, videos: Set<string>): { audioTracks: string; subtitleTracks: string; versions: string; audioLanguages: string; subtitleLanguages: string } | null {
  const audioTracks = parseJson(row.audio_tracks);
  const subtitleTracks = parseJson(row.subtitle_tracks);
  const versions = parseJson(row.versions_json);
  const audioList = parseJson(row.audio_languages);
  const subtitleList = parseJson(row.subtitle_languages);
  let audioChanged = false;
  let subtitleChanged = false;

  if (input.kind === "audio") audioChanged = stampTracks(audioTracks, row.path, input);
  else subtitleChanged = stampTracks(subtitleTracks, row.path, input);
  if (audioChanged || subtitleChanged) {
    if (row.path) videos.add(row.path);
  }

  if (Array.isArray(versions)) {
    for (const item of versions) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const version = item as Record<string, unknown>;
      const versionPath = typeof version.path === "string" ? version.path : null;
      const tracks = input.kind === "audio" ? version.audioTracks : version.subtitleTracks;
      const changed = stampTracks(tracks, versionPath, input);
      if (!changed) continue;
      if (versionPath) videos.add(versionPath);
      if (input.kind === "audio") {
        version.audioLanguages = addLanguage(version.audioLanguages, input.language);
        audioChanged = true;
      } else {
        version.subtitleLanguages = addLanguage(version.subtitleLanguages, input.language);
        subtitleChanged = true;
      }
    }
  }

  if (!audioChanged && !subtitleChanged) return null;
  return {
    audioTracks: JSON.stringify(audioTracks ?? []),
    subtitleTracks: JSON.stringify(subtitleTracks ?? []),
    versions: JSON.stringify(versions ?? []),
    audioLanguages: JSON.stringify(input.kind === "audio" && audioChanged ? addLanguage(audioList, input.language) : audioList ?? []),
    subtitleLanguages: JSON.stringify(input.kind === "subtitle" && subtitleChanged ? addLanguage(subtitleList, input.language) : subtitleList ?? []),
  };
}

function matchingRows(db: Database.Database, table: "catalog_titles" | "catalog_episodes", filePath: string): CatalogRow[] {
  return db
    .prepare(
      `SELECT id, path, audio_tracks, subtitle_tracks, versions_json, audio_languages, subtitle_languages
       FROM ${table}
       WHERE path = ?
          OR instr(ifnull(audio_tracks, ''), ?) > 0
          OR instr(ifnull(subtitle_tracks, ''), ?) > 0
          OR instr(ifnull(versions_json, ''), ?) > 0`,
    )
    .all(filePath, filePath, filePath, filePath) as CatalogRow[];
}

/** Remember the language on the library row so the track is no longer unknown before the next sync. */
export function stampLanguage(db: Database.Database, input: StampInput): string[] {
  const videos = new Set<string>();
  const tables = ["catalog_titles", "catalog_episodes"] as const;
  for (const table of tables) {
    const update = db.prepare(
      `UPDATE ${table}
       SET audio_tracks = ?, subtitle_tracks = ?, versions_json = ?, audio_languages = ?, subtitle_languages = ?
       WHERE id = ?`,
    );
    for (const row of matchingRows(db, table, input.path)) {
      const next = stampRow(row, input, videos);
      if (!next) continue;
      update.run(next.audioTracks, next.subtitleTracks, next.versions, next.audioLanguages, next.subtitleLanguages, row.id);
    }
  }
  return [...videos];
}
