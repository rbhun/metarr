import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { enrichmentKey } from "@/lib/online";
import type {
  ConnectorId,
  ConnectorSettings,
  HdrLabel,
  LibraryEpisode,
  LibraryResponse,
  LibraryTitle,
  MediaFile,
  OnlineMeta,
  PlayableLabel,
  ProviderId,
  ProviderSettings,
  SourceDraft,
  SyncNote,
  TitleKind,
} from "@/lib/types";
import { CONNECTORS, PROVIDERS } from "@/lib/types";

const globalForDb = globalThis as unknown as { __metarrDb?: Database.Database };

function databasePath(): string {
  return process.env.DATABASE_PATH || path.join(process.cwd(), "data", "library.db");
}

export function getDb(): Database.Database {
  if (!globalForDb.__metarrDb) {
    const file = databasePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
    globalForDb.__metarrDb = db;
  }
  return globalForDb.__metarrDb;
}

export function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      last_test_ok INTEGER,
      last_test_at TEXT,
      last_test_message TEXT,
      last_sync_at TEXT,
      last_sync_ok INTEGER,
      last_sync_message TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      connector TEXT NOT NULL,
      kind TEXT NOT NULL,
      external_key TEXT NOT NULL,
      title TEXT NOT NULL,
      series_title TEXT,
      year INTEGER,
      season INTEGER,
      episode INTEGER,
      imdb_id TEXT,
      tmdb_id TEXT,
      tvdb_id TEXT,
      guid TEXT,
      parent_key TEXT,
      has_file INTEGER NOT NULL DEFAULT 0,
      wanted INTEGER NOT NULL DEFAULT 0,
      monitored INTEGER NOT NULL DEFAULT 0,
      container TEXT,
      path TEXT,
      quality_name TEXT,
      resolution TEXT,
      hdr TEXT,
      is_3d INTEGER NOT NULL DEFAULT 0,
      audio_languages TEXT NOT NULL DEFAULT '[]',
      subtitle_languages TEXT NOT NULL DEFAULT '[]',
      subtitle_wanted TEXT NOT NULL DEFAULT '[]',
      rating REAL,
      genres TEXT NOT NULL DEFAULT '[]',
      files_json TEXT NOT NULL DEFAULT '[]',
      air_date TEXT,
      UNIQUE (connector, kind, external_key)
    );

    CREATE TABLE IF NOT EXISTS catalog_titles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      sort_title TEXT NOT NULL,
      year INTEGER,
      imdb_id TEXT,
      tmdb_id TEXT,
      tvdb_id TEXT,
      in_plex INTEGER NOT NULL DEFAULT 0,
      in_radarr INTEGER NOT NULL DEFAULT 0,
      in_sonarr INTEGER NOT NULL DEFAULT 0,
      in_bazarr INTEGER NOT NULL DEFAULT 0,
      has_file INTEGER NOT NULL DEFAULT 0,
      container TEXT,
      path TEXT,
      playable_label TEXT NOT NULL,
      playable_note TEXT,
      quality_name TEXT,
      resolution TEXT,
      hdr TEXT,
      is_3d INTEGER NOT NULL DEFAULT 0,
      audio_languages TEXT NOT NULL DEFAULT '[]',
      subtitle_languages TEXT NOT NULL DEFAULT '[]',
      subtitle_wanted TEXT NOT NULL DEFAULT '[]',
      rating REAL,
      genres TEXT NOT NULL DEFAULT '[]',
      missing_reason TEXT,
      episode_count INTEGER NOT NULL DEFAULT 0,
      episode_file_count INTEGER NOT NULL DEFAULT 0,
      missing_episode_count INTEGER NOT NULL DEFAULT 0,
      match_key TEXT
    );

    CREATE TABLE IF NOT EXISTS catalog_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catalog_id INTEGER NOT NULL REFERENCES catalog_titles(id) ON DELETE CASCADE,
      season INTEGER,
      episode INTEGER,
      title TEXT NOT NULL,
      has_file INTEGER NOT NULL DEFAULT 0,
      wanted INTEGER NOT NULL DEFAULT 0,
      container TEXT,
      path TEXT,
      playable_label TEXT NOT NULL,
      quality_name TEXT,
      resolution TEXT,
      hdr TEXT,
      is_3d INTEGER NOT NULL DEFAULT 0,
      audio_languages TEXT NOT NULL DEFAULT '[]',
      subtitle_languages TEXT NOT NULL DEFAULT '[]',
      subtitle_wanted TEXT NOT NULL DEFAULT '[]',
      in_plex INTEGER NOT NULL DEFAULT 0,
      in_sonarr INTEGER NOT NULL DEFAULT 0,
      in_bazarr INTEGER NOT NULL DEFAULT 0,
      air_date TEXT
    );

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS enrichment (
      match_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      sources TEXT NOT NULL DEFAULT '[]',
      overview TEXT,
      poster_url TEXT,
      original_title TEXT,
      runtime_minutes INTEGER,
      rating REAL,
      genres TEXT NOT NULL DEFAULT '[]',
      imdb_id TEXT,
      tmdb_id TEXT,
      tvdb_id TEXT,
      message TEXT,
      fetched_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_kind_sort ON catalog_titles(kind, sort_title);
    CREATE INDEX IF NOT EXISTS idx_episodes_catalog ON catalog_episodes(catalog_id, season, episode);
    CREATE INDEX IF NOT EXISTS idx_source_connector ON source_records(connector, kind);
  `);

  const titleColumns = db.prepare(`PRAGMA table_info(catalog_titles)`).all() as Array<{ name: string }>;
  if (!titleColumns.some((column) => column.name === "match_key")) {
    db.exec(`ALTER TABLE catalog_titles ADD COLUMN match_key TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_match ON catalog_titles(match_key)`);

  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO connectors (id, base_url, api_key, enabled, updated_at) VALUES (?, '', '', 0, ?)`,
  );
  for (const id of CONNECTORS) insert.run(id, now);
  const insertProvider = db.prepare(
    `INSERT OR IGNORE INTO providers (id, api_key, enabled, updated_at) VALUES (?, '', 0, ?)`,
  );
  for (const id of PROVIDERS) insertProvider.run(id, now);
}

type ConnectorRow = {
  id: string;
  base_url: string;
  api_key: string;
  enabled: number;
  last_test_ok: number | null;
  last_test_at: string | null;
  last_test_message: string | null;
  last_sync_at: string | null;
  last_sync_ok: number | null;
  last_sync_message: string | null;
};

function mapConnector(row: ConnectorRow): ConnectorSettings {
  return {
    id: row.id as ConnectorId,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    enabled: row.enabled === 1,
    lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
    lastTestAt: row.last_test_at,
    lastTestMessage: row.last_test_message,
    lastSyncAt: row.last_sync_at,
    lastSyncOk: row.last_sync_ok === null ? null : row.last_sync_ok === 1,
    lastSyncMessage: row.last_sync_message,
  };
}

export function listConnectors(db = getDb()): ConnectorSettings[] {
  const rows = db.prepare(`SELECT * FROM connectors ORDER BY id`).all() as ConnectorRow[];
  const byId = new Map(rows.map((row) => [row.id, mapConnector(row)]));
  return CONNECTORS.map((id) => byId.get(id)!).filter(Boolean);
}

export function listProviders(db = getDb()): ProviderSettings[] {
  const rows = db.prepare(`SELECT id, api_key, enabled FROM providers`).all() as Array<{
    id: string;
    api_key: string;
    enabled: number;
  }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return PROVIDERS.map((id) => {
    const row = byId.get(id);
    return { id, apiKey: row?.api_key ?? "", enabled: row?.enabled === 1 };
  });
}

export function saveProvider(input: { id: ProviderId; apiKey: string; enabled: boolean }, db = getDb()) {
  db.prepare(
    `UPDATE providers SET api_key = ?, enabled = ?, updated_at = ? WHERE id = ?`,
  ).run(input.apiKey, input.enabled ? 1 : 0, new Date().toISOString(), input.id);
}

export function enabledProviderKeys(db = getDb()): Partial<Record<ProviderId, string>> {
  const keys: Partial<Record<ProviderId, string>> = {};
  for (const provider of listProviders(db)) {
    if (provider.enabled && provider.apiKey.trim()) keys[provider.id] = provider.apiKey.trim();
  }
  return keys;
}

export type StoredEnrichment = Omit<OnlineMeta, "fetchedAt"> & { fetchedAt: string };

export function saveEnrichment(
  matchKey: string,
  kind: TitleKind,
  meta: StoredEnrichment,
  db = getDb(),
) {
  db.prepare(
    `INSERT INTO enrichment (
      match_key, kind, status, sources, overview, poster_url, original_title, runtime_minutes,
      rating, genres, imdb_id, tmdb_id, tvdb_id, message, fetched_at
    ) VALUES (
      @matchKey, @kind, @status, @sources, @overview, @posterUrl, @originalTitle, @runtimeMinutes,
      @rating, @genres, @imdbId, @tmdbId, @tvdbId, @message, @fetchedAt
    )
    ON CONFLICT(match_key) DO UPDATE SET
      kind = excluded.kind,
      status = excluded.status,
      sources = excluded.sources,
      overview = excluded.overview,
      poster_url = excluded.poster_url,
      original_title = excluded.original_title,
      runtime_minutes = excluded.runtime_minutes,
      rating = excluded.rating,
      genres = excluded.genres,
      imdb_id = excluded.imdb_id,
      tmdb_id = excluded.tmdb_id,
      tvdb_id = excluded.tvdb_id,
      message = excluded.message,
      fetched_at = excluded.fetched_at`,
  ).run({
    matchKey,
    kind,
    status: meta.status,
    sources: JSON.stringify(meta.sources),
    overview: meta.overview,
    posterUrl: meta.posterUrl,
    originalTitle: meta.originalTitle,
    runtimeMinutes: meta.runtimeMinutes,
    rating: meta.rating,
    genres: JSON.stringify(meta.genres),
    imdbId: meta.imdbId,
    tmdbId: meta.tmdbId,
    tvdbId: meta.tvdbId,
    message: meta.message,
    fetchedAt: meta.fetchedAt,
  });
}

export function clearEnrichment(db = getDb()) {
  db.prepare(`DELETE FROM enrichment`).run();
}

type EnrichmentRow = {
  match_key: string;
  status: string;
  sources: string;
  overview: string | null;
  poster_url: string | null;
  original_title: string | null;
  runtime_minutes: number | null;
  rating: number | null;
  genres: string;
  imdb_id: string | null;
  tmdb_id: string | null;
  tvdb_id: string | null;
  message: string | null;
  fetched_at: string;
};

function mapEnrichment(row: EnrichmentRow): OnlineMeta {
  const sources = parseStringArray(row.sources).filter((source): source is ProviderId => source === "tmdb" || source === "omdb");
  return {
    status: row.status === "found" || row.status === "error" ? row.status : "missing",
    sources,
    overview: row.overview,
    posterUrl: row.poster_url,
    originalTitle: row.original_title,
    runtimeMinutes: row.runtime_minutes,
    rating: row.rating,
    genres: parseStringArray(row.genres),
    imdbId: row.imdb_id,
    tmdbId: row.tmdb_id,
    tvdbId: row.tvdb_id,
    fetchedAt: row.fetched_at,
    message: row.message,
  };
}

function loadEnrichment(keys: string[], db: Database.Database): Map<string, OnlineMeta> {
  const unique = [...new Set(keys.filter(Boolean))];
  const found = new Map<string, OnlineMeta>();
  if (unique.length === 0) return found;
  const placeholders = unique.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT * FROM enrichment WHERE match_key IN (${placeholders})`).all(...unique) as EnrichmentRow[];
  for (const row of rows) found.set(row.match_key, mapEnrichment(row));
  return found;
}

export function titlesForLookup(
  input: { ids?: number[]; gaps: boolean; limit: number },
  db = getDb(),
): Array<{ id: number; kind: TitleKind; title: string; year: number | null; imdbId: string | null; tmdbId: string | null; tvdbId: string | null; matchKey: string }> {
  const params: Array<string | number> = [];
  let where = "";
  if (input.ids && input.ids.length) {
    where = `WHERE id IN (${input.ids.map(() => "?").join(", ")})`;
    params.push(...input.ids);
  } else if (input.gaps) {
    where = `WHERE match_key IS NULL OR NOT EXISTS (
      SELECT 1 FROM enrichment e WHERE e.match_key = catalog_titles.match_key
    ) OR EXISTS (
      SELECT 1 FROM enrichment e WHERE e.match_key = catalog_titles.match_key AND e.status = 'error'
    )`;
  }
  const rows = db
    .prepare(
      `SELECT id, kind, title, year, imdb_id, tmdb_id, tvdb_id, match_key
       FROM catalog_titles ${where}
       ORDER BY sort_title COLLATE NOCASE
       LIMIT ?`,
    )
    .all(...params, input.limit) as Array<{
    id: number;
    kind: string;
    title: string;
    year: number | null;
    imdb_id: string | null;
    tmdb_id: string | null;
    tvdb_id: string | null;
    match_key: string | null;
  }>;
  return rows.map((row) => {
    const kind: TitleKind = row.kind === "series" ? "series" : "movie";
    const identity = {
      kind,
      title: row.title,
      year: row.year,
      imdbId: row.imdb_id,
      tmdbId: row.tmdb_id,
      tvdbId: row.tvdb_id,
    };
    return { id: row.id, ...identity, matchKey: row.match_key || enrichmentKey(identity) };
  });
}

export function countLookupRemaining(db = getDb()): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM catalog_titles
       WHERE match_key IS NULL OR NOT EXISTS (
         SELECT 1 FROM enrichment e WHERE e.match_key = catalog_titles.match_key
       ) OR EXISTS (
         SELECT 1 FROM enrichment e WHERE e.match_key = catalog_titles.match_key AND e.status = 'error'
       )`,
    )
    .get() as { count: number };
  return row.count;
}

export function saveConnector(
  input: { id: ConnectorId; baseUrl: string; apiKey: string; enabled: boolean },
  db = getDb(),
) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE connectors
     SET base_url = ?, api_key = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
  ).run(input.baseUrl, input.apiKey, input.enabled ? 1 : 0, now, input.id);
}

export function recordConnectorTest(
  id: ConnectorId,
  ok: boolean,
  message: string,
  db = getDb(),
) {
  db.prepare(
    `UPDATE connectors SET last_test_ok = ?, last_test_at = ?, last_test_message = ? WHERE id = ?`,
  ).run(ok ? 1 : 0, new Date().toISOString(), message, id);
}

export function recordConnectorSync(
  id: ConnectorId,
  ok: boolean,
  message: string,
  db = getDb(),
) {
  db.prepare(
    `UPDATE connectors SET last_sync_ok = ?, last_sync_at = ?, last_sync_message = ? WHERE id = ?`,
  ).run(ok ? 1 : 0, new Date().toISOString(), message, id);
}

export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Database.Database, key: string, value: string) {
  db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function isDemo(db = getDb()): boolean {
  return getMeta(db, "demo") === "1";
}

export function configuredConnectorIds(db = getDb()): ConnectorId[] {
  if (isDemo(db)) return [...CONNECTORS];
  return listConnectors(db)
    .filter((connector) => connector.enabled && connector.baseUrl.trim() && connector.apiKey.trim())
    .map((connector) => connector.id);
}

type SourceRow = {
  connector: string;
  kind: string;
  external_key: string;
  title: string;
  series_title: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  imdb_id: string | null;
  tmdb_id: string | null;
  tvdb_id: string | null;
  guid: string | null;
  parent_key: string | null;
  has_file: number;
  wanted: number;
  monitored: number;
  container: string | null;
  path: string | null;
  quality_name: string | null;
  resolution: string | null;
  hdr: string | null;
  is_3d: number;
  audio_languages: string;
  subtitle_languages: string;
  subtitle_wanted: string;
  rating: number | null;
  genres: string;
  files_json: string;
  air_date: string | null;
};

function asHdr(value: string | null | undefined): HdrLabel {
  if (value === "Dolby Vision" || value === "HDR10+" || value === "HDR10" || value === "HLG") return value;
  return "none";
}

function asPlayable(value: string | null | undefined): PlayableLabel {
  if (value === "video" || value === "disc" || value === "missing") return value;
  return "missing";
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseFiles(value: string | null | undefined): MediaFile[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      const file = (item ?? {}) as Partial<MediaFile>;
      return {
        container: typeof file.container === "string" ? file.container : null,
        path: typeof file.path === "string" ? file.path : null,
        qualityName: typeof file.qualityName === "string" ? file.qualityName : null,
        resolution: typeof file.resolution === "string" ? file.resolution : null,
        hdr: asHdr(typeof file.hdr === "string" ? file.hdr : null),
        is3d: Boolean(file.is3d),
        audioLanguages: Array.isArray(file.audioLanguages)
          ? file.audioLanguages.filter((lang): lang is string => typeof lang === "string")
          : [],
        subtitleLanguages: Array.isArray(file.subtitleLanguages)
          ? file.subtitleLanguages.filter((lang): lang is string => typeof lang === "string")
          : [],
      };
    });
  } catch {
    return [];
  }
}

export function mapSourceRow(row: SourceRow): SourceDraft {
  const kind = row.kind === "movie" || row.kind === "series" || row.kind === "episode" ? row.kind : "movie";
  const connector = CONNECTORS.includes(row.connector as ConnectorId) ? (row.connector as ConnectorId) : "plex";
  return {
    connector,
    kind,
    externalKey: row.external_key,
    title: row.title,
    seriesTitle: row.series_title,
    year: row.year,
    season: row.season,
    episode: row.episode,
    imdbId: row.imdb_id,
    tmdbId: row.tmdb_id,
    tvdbId: row.tvdb_id,
    guid: row.guid,
    parentKey: row.parent_key,
    hasFile: row.has_file === 1,
    wanted: row.wanted === 1,
    monitored: row.monitored === 1,
    container: row.container,
    path: row.path,
    qualityName: row.quality_name,
    resolution: row.resolution,
    hdr: asHdr(row.hdr),
    is3d: row.is_3d === 1,
    audioLanguages: parseStringArray(row.audio_languages),
    subtitleLanguages: parseStringArray(row.subtitle_languages),
    subtitleWanted: parseStringArray(row.subtitle_wanted),
    rating: row.rating,
    genres: parseStringArray(row.genres),
    files: parseFiles(row.files_json),
    airDate: row.air_date,
  };
}

export function loadSourceRecords(db: Database.Database): SourceDraft[] {
  const rows = db.prepare(`SELECT * FROM source_records`).all() as SourceRow[];
  return rows.map(mapSourceRow);
}

export function deleteAllSourceRecords(db: Database.Database) {
  db.prepare(`DELETE FROM source_records`).run();
}

export function deleteConnectorRecords(db: Database.Database, connector: ConnectorId) {
  db.prepare(`DELETE FROM source_records WHERE connector = ?`).run(connector);
}

export function connectorHasRecords(db: Database.Database, connector: ConnectorId): boolean {
  const row = db.prepare(`SELECT 1 AS ok FROM source_records WHERE connector = ? LIMIT 1`).get(connector) as
    | { ok: number }
    | undefined;
  return Boolean(row);
}

export function insertSourceRecords(db: Database.Database, records: SourceDraft[]) {
  const stmt = db.prepare(`
    INSERT INTO source_records (
      connector, kind, external_key, title, series_title, year, season, episode,
      imdb_id, tmdb_id, tvdb_id, guid, parent_key, has_file, wanted, monitored,
      container, path, quality_name, resolution, hdr, is_3d, audio_languages,
      subtitle_languages, subtitle_wanted, rating, genres, files_json, air_date
    ) VALUES (
      @connector, @kind, @externalKey, @title, @seriesTitle, @year, @season, @episode,
      @imdbId, @tmdbId, @tvdbId, @guid, @parentKey, @hasFile, @wanted, @monitored,
      @container, @path, @qualityName, @resolution, @hdr, @is3d, @audioLanguages,
      @subtitleLanguages, @subtitleWanted, @rating, @genres, @filesJson, @airDate
    )
    ON CONFLICT(connector, kind, external_key) DO UPDATE SET
      title = excluded.title,
      series_title = excluded.series_title,
      year = excluded.year,
      season = excluded.season,
      episode = excluded.episode,
      imdb_id = excluded.imdb_id,
      tmdb_id = excluded.tmdb_id,
      tvdb_id = excluded.tvdb_id,
      guid = excluded.guid,
      parent_key = excluded.parent_key,
      has_file = excluded.has_file,
      wanted = excluded.wanted,
      monitored = excluded.monitored,
      container = excluded.container,
      path = excluded.path,
      quality_name = excluded.quality_name,
      resolution = excluded.resolution,
      hdr = excluded.hdr,
      is_3d = excluded.is_3d,
      audio_languages = excluded.audio_languages,
      subtitle_languages = excluded.subtitle_languages,
      subtitle_wanted = excluded.subtitle_wanted,
      rating = excluded.rating,
      genres = excluded.genres,
      files_json = excluded.files_json,
      air_date = excluded.air_date
  `);
  for (const record of records) {
    stmt.run({
      connector: record.connector,
      kind: record.kind,
      externalKey: record.externalKey,
      title: record.title,
      seriesTitle: record.seriesTitle,
      year: record.year,
      season: record.season,
      episode: record.episode,
      imdbId: record.imdbId,
      tmdbId: record.tmdbId,
      tvdbId: record.tvdbId,
      guid: record.guid,
      parentKey: record.parentKey,
      hasFile: record.hasFile ? 1 : 0,
      wanted: record.wanted ? 1 : 0,
      monitored: record.monitored ? 1 : 0,
      container: record.container,
      path: record.path,
      qualityName: record.qualityName,
      resolution: record.resolution,
      hdr: record.hdr,
      is3d: record.is3d ? 1 : 0,
      audioLanguages: JSON.stringify(record.audioLanguages),
      subtitleLanguages: JSON.stringify(record.subtitleLanguages),
      subtitleWanted: JSON.stringify(record.subtitleWanted),
      rating: record.rating,
      genres: JSON.stringify(record.genres),
      filesJson: JSON.stringify(record.files),
      airDate: record.airDate,
    });
  }
}

type TitleRow = {
  id: number;
  kind: string;
  title: string;
  year: number | null;
  imdb_id: string | null;
  tmdb_id: string | null;
  tvdb_id: string | null;
  in_plex: number;
  in_radarr: number;
  in_sonarr: number;
  in_bazarr: number;
  has_file: number;
  container: string | null;
  path: string | null;
  playable_label: string;
  playable_note: string | null;
  quality_name: string | null;
  resolution: string | null;
  hdr: string | null;
  is_3d: number;
  audio_languages: string;
  subtitle_languages: string;
  subtitle_wanted: string;
  rating: number | null;
  genres: string;
  missing_reason: string | null;
  episode_count: number;
  episode_file_count: number;
  missing_episode_count: number;
  match_key: string | null;
};

function mapTitle(row: TitleRow, online: OnlineMeta | null): LibraryTitle {
  return {
    id: row.id,
    kind: row.kind === "series" ? "series" : "movie",
    title: row.title,
    year: row.year,
    imdbId: row.imdb_id,
    tmdbId: row.tmdb_id,
    tvdbId: row.tvdb_id,
    inPlex: row.in_plex === 1,
    inRadarr: row.in_radarr === 1,
    inSonarr: row.in_sonarr === 1,
    inBazarr: row.in_bazarr === 1,
    hasFile: row.has_file === 1,
    container: row.container,
    path: row.path,
    playableLabel: asPlayable(row.playable_label),
    playableNote: row.playable_note,
    qualityName: row.quality_name,
    resolution: row.resolution,
    hdr: asHdr(row.hdr),
    is3d: row.is_3d === 1,
    audioLanguages: parseStringArray(row.audio_languages),
    subtitleLanguages: parseStringArray(row.subtitle_languages),
    subtitleWanted: parseStringArray(row.subtitle_wanted),
    rating: row.rating,
    genres: parseStringArray(row.genres),
    missingReason: row.missing_reason,
    episodeCount: row.episode_count,
    episodeFileCount: row.episode_file_count,
    missingEpisodeCount: row.missing_episode_count,
    online,
  };
}

export type LibraryQuery = {
  kind: "all" | TitleKind;
  missing: boolean;
  notInPlex: boolean;
  notPlayable: boolean;
  missingEnglish: boolean;
  only3d: boolean;
  hungarian: boolean;
  q: string;
  offset: number;
  limit: number;
};

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function jsonLanguage(column: string, language: string): string {
  return `${column} LIKE '%"${language}"%'`;
}

function languageSql(language: string): string {
  return `(
    ${jsonLanguage("audio_languages", language)}
    OR ${jsonLanguage("subtitle_languages", language)}
    OR ${jsonLanguage("subtitle_wanted", language)}
    OR EXISTS (
      SELECT 1 FROM catalog_episodes e
      WHERE e.catalog_id = catalog_titles.id
        AND (
          ${jsonLanguage("e.audio_languages", language)}
          OR ${jsonLanguage("e.subtitle_languages", language)}
          OR ${jsonLanguage("e.subtitle_wanted", language)}
        )
    )
  )`;
}

function missingEnglishSql(): string {
  return `(
    ${jsonLanguage("subtitle_wanted", "English")}
    OR (kind = 'movie' AND has_file = 1 AND NOT ${jsonLanguage("subtitle_languages", "English")})
    OR EXISTS (
      SELECT 1 FROM catalog_episodes e
      WHERE e.catalog_id = catalog_titles.id
        AND (
          (e.has_file = 1 AND NOT ${jsonLanguage("e.subtitle_languages", "English")})
          OR ${jsonLanguage("e.subtitle_wanted", "English")}
        )
    )
  )`;
}

function filterClause(query: LibraryQuery): { where: string; params: Array<string | number> } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (query.kind === "movie" || query.kind === "series") {
    where.push("kind = ?");
    params.push(query.kind);
  }
  if (query.missing) {
    where.push(
      "((kind = 'movie' AND has_file = 0) OR (kind = 'series' AND (missing_episode_count > 0 OR has_file = 0)))",
    );
  }
  if (query.notInPlex) where.push("in_plex = 0");
  if (query.notPlayable) where.push("playable_label != 'video'");
  if (query.missingEnglish) where.push(missingEnglishSql());
  if (query.only3d) where.push("is_3d = 1");
  if (query.hungarian) where.push(languageSql("Hungarian"));
  const search = query.q.trim();
  if (search) {
    where.push("title LIKE ? ESCAPE '\\'");
    params.push(likePattern(search));
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

function countWhere(db: Database.Database, sql: string, params: Array<string | number> = []): number {
  const row = db.prepare(sql).get(...params) as { count: number };
  return row.count;
}

export function queryLibrary(query: LibraryQuery, db = getDb()): LibraryResponse {
  const { where, params } = filterClause(query);
  const filtered = countWhere(db, `SELECT COUNT(*) AS count FROM catalog_titles ${where}`, params);
  const rows = db
    .prepare(
      `SELECT * FROM catalog_titles ${where}
       ORDER BY sort_title COLLATE NOCASE, COALESCE(year, 0), title
       LIMIT ? OFFSET ?`,
    )
    .all(...params, query.limit, query.offset) as TitleRow[];
  const onlineByKey = loadEnrichment(
    rows.map((row) => row.match_key || enrichmentKey({
      kind: row.kind === "series" ? "series" : "movie",
      title: row.title,
      year: row.year,
      imdbId: row.imdb_id,
      tmdbId: row.tmdb_id,
      tvdbId: row.tvdb_id,
    })),
    db,
  );

  const missingSql =
    "((kind = 'movie' AND has_file = 0) OR (kind = 'series' AND (missing_episode_count > 0 OR has_file = 0)))";
  const lastSyncAt = getMeta(db, "last_sync_at");
  const lastSyncStatus = getMeta(db, "last_sync_status");
  let syncNotes: SyncNote[] = [];
  const rawNotes = getMeta(db, "last_sync_notes");
  if (rawNotes) {
    try {
      const parsed = JSON.parse(rawNotes) as SyncNote[];
      if (Array.isArray(parsed)) syncNotes = parsed;
    } catch {
      syncNotes = [];
    }
  }

  return {
    demo: isDemo(db),
    configured: configuredConnectorIds(db),
    lastSyncAt,
    lastSyncStatus:
      lastSyncStatus === "success" || lastSyncStatus === "partial" || lastSyncStatus === "error" || lastSyncStatus === "idle"
        ? lastSyncStatus
        : null,
    syncNotes,
    stats: {
      total: countWhere(db, `SELECT COUNT(*) AS count FROM catalog_titles`),
      missing: countWhere(db, `SELECT COUNT(*) AS count FROM catalog_titles WHERE ${missingSql}`),
      notInPlex: countWhere(db, `SELECT COUNT(*) AS count FROM catalog_titles WHERE in_plex = 0`),
      notPlayable: countWhere(db, `SELECT COUNT(*) AS count FROM catalog_titles WHERE playable_label != 'video'`),
    },
    page: { offset: query.offset, limit: query.limit, filtered },
    titles: rows.map((row) => {
      const key = row.match_key || enrichmentKey({
        kind: row.kind === "series" ? "series" : "movie",
        title: row.title,
        year: row.year,
        imdbId: row.imdb_id,
        tmdbId: row.tmdb_id,
        tvdbId: row.tvdb_id,
      });
      return mapTitle(row, onlineByKey.get(key) ?? null);
    }),
  };
}

type EpisodeRow = {
  id: number;
  season: number | null;
  episode: number | null;
  title: string;
  has_file: number;
  wanted: number;
  container: string | null;
  path: string | null;
  playable_label: string;
  quality_name: string | null;
  resolution: string | null;
  hdr: string | null;
  is_3d: number;
  audio_languages: string;
  subtitle_languages: string;
  subtitle_wanted: string;
  in_plex: number;
  in_sonarr: number;
  in_bazarr: number;
  air_date: string | null;
};

export function queryEpisodes(catalogId: number, db = getDb()): LibraryEpisode[] {
  const rows = db
    .prepare(
      `SELECT * FROM catalog_episodes
       WHERE catalog_id = ?
       ORDER BY COALESCE(season, 9999), COALESCE(episode, 9999), title`,
    )
    .all(catalogId) as EpisodeRow[];
  return rows.map((row) => ({
    id: row.id,
    season: row.season,
    episode: row.episode,
    title: row.title,
    hasFile: row.has_file === 1,
    wanted: row.wanted === 1,
    container: row.container,
    path: row.path,
    playableLabel: asPlayable(row.playable_label),
    qualityName: row.quality_name,
    resolution: row.resolution,
    hdr: asHdr(row.hdr),
    is3d: row.is_3d === 1,
    audioLanguages: parseStringArray(row.audio_languages),
    subtitleLanguages: parseStringArray(row.subtitle_languages),
    subtitleWanted: parseStringArray(row.subtitle_wanted),
    inPlex: row.in_plex === 1,
    inSonarr: row.in_sonarr === 1,
    inBazarr: row.in_bazarr === 1,
    airDate: row.air_date,
  }));
}

export function clearCatalog(db: Database.Database) {
  db.prepare(`DELETE FROM catalog_episodes`).run();
  db.prepare(`DELETE FROM catalog_titles`).run();
}
