import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { detectionMap } from "@/lib/detect/store";
import { overlayAudio, overlaySubtitles } from "@/lib/detect/overlay";
import { assignSidecars, readSidecarNames } from "@/lib/detect/sidecars";
import { rulesWhere, type FilterRule } from "@/lib/filters";
import { mergeAudioTracks, mergeSubtitleTracks } from "@/lib/media";
import { displayLocalTitle, enrichmentKey } from "@/lib/online";
import { titleLanguage } from "@/lib/title-language";
import type { StoredDetection } from "@/lib/detect/store";
import type {
  AudioTrack,
  ConnectorId,
  ConnectorSettings,
  HdrLabel,
  LibraryEpisode,
  MediaVersion,
  LibraryResponse,
  LibraryTitle,
  MediaDetail,
  MediaFile,
  OnlineMeta,
  PlayableLabel,
  ProviderId,
  ProviderSettings,
  SourceDraft,
  SubtitleTrack,
  SyncNote,
  TitleKind,
  TitleNotes,
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
    globalForDb.__metarrDb = db;
  }
  migrate(globalForDb.__metarrDb);
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

    CREATE TABLE IF NOT EXISTS detect_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      label TEXT NOT NULL,
      format TEXT,
      placement TEXT,
      stream_label TEXT,
      message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS detect_results (
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      language TEXT,
      role TEXT,
      confidence REAL,
      message TEXT,
      scanned_at TEXT NOT NULL,
      PRIMARY KEY (path, kind, ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_kind_sort ON catalog_titles(kind, sort_title);
    CREATE INDEX IF NOT EXISTS idx_episodes_catalog ON catalog_episodes(catalog_id, season, episode);
    CREATE INDEX IF NOT EXISTS idx_source_connector ON source_records(connector, kind);
    CREATE INDEX IF NOT EXISTS idx_detect_jobs_status ON detect_jobs(status, priority, id);

    CREATE TABLE IF NOT EXISTS remux_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      label TEXT NOT NULL,
      extras INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      message TEXT,
      progress INTEGER,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_remux_jobs_status ON remux_jobs(status, id);
  `);

  const titleColumns = db.prepare(`PRAGMA table_info(catalog_titles)`).all() as Array<{ name: string }>;
  if (!titleColumns.some((column) => column.name === "match_key")) {
    db.exec(`ALTER TABLE catalog_titles ADD COLUMN match_key TEXT`);
  }
  ensureColumn(db, "catalog_titles", "content_rating", "TEXT");
  ensureColumn(db, "catalog_titles", "bitrate_kbps", "INTEGER");
  ensureColumn(db, "catalog_titles", "audio_tracks", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "catalog_titles", "subtitle_tracks", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "catalog_titles", "poster_path", "TEXT");
  ensureColumn(db, "catalog_titles", "runtime_minutes", "INTEGER");
  ensureColumn(db, "catalog_episodes", "audio_tracks", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "catalog_episodes", "subtitle_tracks", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "catalog_episodes", "runtime_minutes", "INTEGER");
  ensureColumn(db, "catalog_episodes", "detail_json", "TEXT");
  ensureColumn(db, "source_records", "content_rating", "TEXT");
  ensureColumn(db, "source_records", "poster_path", "TEXT");
  ensureColumn(db, "source_records", "runtime_minutes", "INTEGER");
  ensureColumn(db, "source_records", "notes_json", "TEXT");
  ensureColumn(db, "catalog_titles", "detail_json", "TEXT");
  ensureColumn(db, "catalog_titles", "versions_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "catalog_titles", "version_resolutions", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "catalog_titles", "version_hdrs", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "catalog_titles", "version_flags", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "catalog_episodes", "versions_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "enrichment", "content_rating", "TEXT");
  ensureColumn(db, "enrichment", "local_titles", "TEXT NOT NULL DEFAULT '{}'");
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

function ensureColumn(db: Database.Database, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

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
      match_key, kind, status, sources, overview, poster_url, original_title, local_titles, runtime_minutes,
      rating, content_rating, genres, imdb_id, tmdb_id, tvdb_id, message, fetched_at
    ) VALUES (
      @matchKey, @kind, @status, @sources, @overview, @posterUrl, @originalTitle, @localTitles, @runtimeMinutes,
      @rating, @contentRating, @genres, @imdbId, @tmdbId, @tvdbId, @message, @fetchedAt
    )
    ON CONFLICT(match_key) DO UPDATE SET
      kind = excluded.kind,
      status = excluded.status,
      sources = excluded.sources,
      overview = excluded.overview,
      poster_url = excluded.poster_url,
      original_title = excluded.original_title,
      local_titles = excluded.local_titles,
      runtime_minutes = excluded.runtime_minutes,
      rating = excluded.rating,
      content_rating = excluded.content_rating,
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
    localTitles: JSON.stringify(meta.localTitles ?? {}),
    runtimeMinutes: meta.runtimeMinutes,
    rating: meta.rating,
    contentRating: meta.contentRating,
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
  local_titles: string | null;
  runtime_minutes: number | null;
  rating: number | null;
  content_rating: string | null;
  genres: string;
  imdb_id: string | null;
  tmdb_id: string | null;
  tvdb_id: string | null;
  message: string | null;
  fetched_at: string;
};

function parseLocalTitles(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const titles: Record<string, string> = {};
    for (const [code, name] of Object.entries(value)) {
      if (typeof name === "string" && name.trim()) titles[code] = name.trim();
    }
    return titles;
  } catch {
    return {};
  }
}

function mapEnrichment(row: EnrichmentRow): OnlineMeta {
  const sources = parseStringArray(row.sources).filter((source): source is ProviderId => source === "tmdb" || source === "omdb");
  return {
    status: row.status === "found" || row.status === "error" ? row.status : "missing",
    sources,
    overview: row.overview,
    posterUrl: row.poster_url,
    originalTitle: row.original_title,
    localTitles: parseLocalTitles(row.local_titles),
    runtimeMinutes: row.runtime_minutes,
    rating: row.rating,
    contentRating: row.content_rating,
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

const PLEX_EXCLUDED_KEY = "plex_excluded_libraries";

export function plexExcludedLibraries(db = getDb()): string[] {
  const raw = getMeta(db, PLEX_EXCLUDED_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

export function savePlexExcludedLibraries(keys: string[], db = getDb()) {
  const unique = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
  setMeta(db, PLEX_EXCLUDED_KEY, JSON.stringify(unique));
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
  content_rating: string | null;
  genres: string;
  files_json: string;
  air_date: string | null;
  poster_path: string | null;
  runtime_minutes: number | null;
  notes_json: string | null;
};

function asHdr(value: string | null | undefined): HdrLabel {
  if (value === "Dolby Vision" || value === "HDR10+" || value === "HDR10" || value === "HLG") return value;
  return "none";
}

function asPlayable(value: string | null | undefined): PlayableLabel {
  if (value === "video" || value === "dvd" || value === "bluray" || value === "iso" || value === "dvd-iso" || value === "bluray-iso" || value === "disc" || value === "missing") {
    return value;
  }
  return "missing";
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
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

export function parseVersions(value: string | null | undefined): MediaVersion[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    const version = asRecordTrack(item);
    if (!version) return [];
    const name = typeof version.name === "string" ? version.name : "File";
    return [
      {
        name,
        path: typeof version.path === "string" ? version.path : null,
        container: typeof version.container === "string" ? version.container : null,
        resolution: typeof version.resolution === "string" ? version.resolution : null,
        hdr: asHdr(typeof version.hdr === "string" ? version.hdr : null),
        is3d: version.is3d === true,
        qualityName: typeof version.qualityName === "string" ? version.qualityName : null,
        bitrateKbps: typeof version.bitrateKbps === "number" ? version.bitrateKbps : null,
        playableLabel: asPlayable(typeof version.playableLabel === "string" ? version.playableLabel : null),
        edition: typeof version.edition === "string" ? version.edition : null,
        audioLanguages: Array.isArray(version.audioLanguages)
          ? version.audioLanguages.filter((language): language is string => typeof language === "string")
          : [],
        subtitleLanguages: Array.isArray(version.subtitleLanguages)
          ? version.subtitleLanguages.filter((language): language is string => typeof language === "string")
          : [],
        audioTracks: parseAudioTracks(version.audioTracks),
        subtitleTracks: parseSubtitleTracks(version.subtitleTracks),
        missing: Array.isArray(version.missing) ? version.missing.filter((gap): gap is string => typeof gap === "string") : [],
        flags: Array.isArray(version.flags) ? version.flags.filter((flag): flag is string => flag === "sample" || flag === "short") : [],
        fileBytes: typeof version.fileBytes === "number" ? version.fileBytes : null,
        durationMinutes: typeof version.durationMinutes === "number" ? version.durationMinutes : null,
      },
    ];
  });
}

function optionalIndex(value: unknown): number | null {
  const index = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(index) && index >= 0 ? index : null;
}

export function parseAudioTracks(value: unknown): AudioTrack[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const track = asRecordTrack(item);
    if (!track) return [];
    const language = typeof track.language === "string" ? track.language : null;
    const layout = typeof track.layout === "string" ? track.layout : null;
    const codec = typeof track.codec === "string" ? track.codec : null;
    if (!language && !layout && !codec) return [];
    const streamIndex = optionalIndex(track.streamIndex);
    const label = typeof track.label === "string" ? track.label : null;
    return [{ language, layout, codec, ...(streamIndex != null ? { streamIndex } : {}), ...(label ? { label } : {}) }];
  });
}

export function parseSubtitleTracks(value: unknown): SubtitleTrack[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const track = asRecordTrack(item);
    if (!track) return [];
    const placement = track.placement === "burn-in" || track.placement === "external" || track.placement === "internal" ? track.placement : "internal";
    const streamIndex = optionalIndex(track.streamIndex);
    const file = typeof track.file === "string" ? track.file : null;
    return [{
      language: typeof track.language === "string" ? track.language : null,
      placement,
      format: typeof track.format === "string" ? track.format : null,
      forced: track.forced === true,
      ...(streamIndex != null ? { streamIndex } : {}),
      ...(file ? { file } : {}),
    }];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asRecordTrack(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
        audioTracks: parseAudioTracks(file.audioTracks),
        subtitleTracks: parseSubtitleTracks(file.subtitleTracks),
        bitrateKbps: typeof file.bitrateKbps === "number" && Number.isFinite(file.bitrateKbps) ? file.bitrateKbps : null,
        videoCodec: typeof file.videoCodec === "string" ? file.videoCodec : null,
        videoProfile: typeof file.videoProfile === "string" ? file.videoProfile : null,
        frameRate: typeof file.frameRate === "string" ? file.frameRate : null,
        width: typeof file.width === "number" ? file.width : null,
        height: typeof file.height === "number" ? file.height : null,
        bitDepth: typeof file.bitDepth === "number" ? file.bitDepth : null,
        aspectRatio: typeof file.aspectRatio === "string" ? file.aspectRatio : null,
        fileBytes: typeof file.fileBytes === "number" ? file.fileBytes : null,
        durationMinutes: typeof file.durationMinutes === "number" ? file.durationMinutes : null,
      };
    });
  } catch {
    return [];
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function parseNotes(raw: string | null): TitleNotes | null {
  if (!raw) return null;
  try {
    const value = asRecord(JSON.parse(raw));
    if (!value) return null;
    return {
      summary: typeof value.summary === "string" ? value.summary : null,
      studio: typeof value.studio === "string" ? value.studio : null,
      tagline: typeof value.tagline === "string" ? value.tagline : null,
      released: typeof value.released === "string" ? value.released : null,
      addedAt: typeof value.addedAt === "string" ? value.addedAt : null,
      directors: stringList(value.directors),
      writers: stringList(value.writers),
      countries: stringList(value.countries),
      collections: stringList(value.collections),
    };
  } catch {
    return null;
  }
}

function parseDetail(raw: string | null): MediaDetail | null {
  if (!raw) return null;
  try {
    const value = asRecord(JSON.parse(raw));
    if (!value) return null;
    const notes = parseNotes(JSON.stringify(value));
    const files = Array.isArray(value.files)
      ? value.files.flatMap((entry) => {
          const file = asRecord(entry);
          if (!file || typeof file.name !== "string") return [];
          return [
            {
              name: file.name,
              container: typeof file.container === "string" ? file.container : null,
              resolution: typeof file.resolution === "string" ? file.resolution : null,
              frameRate: typeof file.frameRate === "string" ? file.frameRate : null,
              videoCodec: typeof file.videoCodec === "string" ? file.videoCodec : null,
            },
          ];
        })
      : [];
    return {
      summary: notes?.summary ?? null,
      studio: notes?.studio ?? null,
      tagline: notes?.tagline ?? null,
      released: notes?.released ?? null,
      addedAt: notes?.addedAt ?? null,
      directors: notes?.directors ?? [],
      writers: notes?.writers ?? [],
      countries: notes?.countries ?? [],
      collections: notes?.collections ?? [],
      videoCodec: typeof value.videoCodec === "string" ? value.videoCodec : null,
      videoProfile: typeof value.videoProfile === "string" ? value.videoProfile : null,
      frameRate: typeof value.frameRate === "string" ? value.frameRate : null,
      width: typeof value.width === "number" ? value.width : null,
      height: typeof value.height === "number" ? value.height : null,
      bitDepth: typeof value.bitDepth === "number" ? value.bitDepth : null,
      aspectRatio: typeof value.aspectRatio === "string" ? value.aspectRatio : null,
      fileBytes: typeof value.fileBytes === "number" ? value.fileBytes : null,
      files,
    };
  } catch {
    return null;
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
    audioTracks: [],
    subtitleTracks: [],
    rating: row.rating,
    contentRating: row.content_rating,
    genres: parseStringArray(row.genres),
    files: parseFiles(row.files_json),
    airDate: row.air_date,
    posterPath: row.poster_path,
    runtimeMinutes: row.runtime_minutes,
    notes: parseNotes(row.notes_json),
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
      subtitle_languages, subtitle_wanted, rating, content_rating, genres, files_json, air_date, poster_path, runtime_minutes, notes_json
    ) VALUES (
      @connector, @kind, @externalKey, @title, @seriesTitle, @year, @season, @episode,
      @imdbId, @tmdbId, @tvdbId, @guid, @parentKey, @hasFile, @wanted, @monitored,
      @container, @path, @qualityName, @resolution, @hdr, @is3d, @audioLanguages,
      @subtitleLanguages, @subtitleWanted, @rating, @contentRating, @genres, @filesJson, @airDate, @posterPath, @runtimeMinutes, @notesJson
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
      content_rating = excluded.content_rating,
      genres = excluded.genres,
      files_json = excluded.files_json,
      air_date = excluded.air_date,
      poster_path = excluded.poster_path,
      runtime_minutes = excluded.runtime_minutes,
      notes_json = excluded.notes_json
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
      contentRating: record.contentRating,
      genres: JSON.stringify(record.genres),
      filesJson: JSON.stringify(record.files),
      airDate: record.airDate,
      posterPath: record.posterPath,
      runtimeMinutes: record.runtimeMinutes,
      notesJson: record.notes ? JSON.stringify(record.notes) : null,
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
  content_rating: string | null;
  bitrate_kbps: number | null;
  genres: string;
  missing_reason: string | null;
  episode_count: number;
  episode_file_count: number;
  missing_episode_count: number;
  match_key: string | null;
  audio_tracks: string | null;
  subtitle_tracks: string | null;
  poster_path: string | null;
  runtime_minutes: number | null;
  detail_json: string | null;
  versions_json: string | null;
};

function subtitles(videoPath: string | null, tracks: SubtitleTrack[], detections: Map<string, StoredDetection>): SubtitleTrack[] {
  return overlaySubtitles(videoPath, assignSidecars(videoPath, tracks, readSidecarNames(videoPath)), detections);
}

function mapTitle(row: TitleRow, online: OnlineMeta | null, language: string, detections: Map<string, StoredDetection>): LibraryTitle {
  const path = row.path;
  const versions = parseVersions(row.versions_json).map((version) => ({
    ...version,
    audioTracks: overlayAudio(version.path, version.audioTracks, detections),
    subtitleTracks: subtitles(version.path, version.subtitleTracks, detections),
  }));
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
    audioTracks: overlayAudio(path, parseAudioTracks(parseJson(row.audio_tracks)), detections),
    subtitleTracks: subtitles(path, parseSubtitleTracks(parseJson(row.subtitle_tracks)), detections),
    posterPath: row.poster_path,
    runtimeMinutes: row.runtime_minutes,
    detail: parseDetail(row.detail_json),
    versions,
    rating: row.rating,
    contentRating: row.content_rating,
    bitrateKbps: row.bitrate_kbps,
    genres: parseStringArray(row.genres),
    localTitle: displayLocalTitle(row.title, online, language),
    missingReason: row.missing_reason,
    episodeCount: row.episode_count,
    episodeFileCount: row.episode_file_count,
    missingEpisodeCount: row.missing_episode_count,
    online,
  };
}

export type LibraryQuery = {
  kind: "all" | TitleKind;
  rules: FilterRule[];
  q: string;
  offset: number;
  limit: number;
};

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function filterClause(query: LibraryQuery, language: string): { where: string; params: Array<string | number> } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (query.kind === "movie" || query.kind === "series") {
    where.push("kind = ?");
    params.push(query.kind);
  }
  const rules = rulesWhere(query.rules);
  where.push(...rules.clauses);
  params.push(...rules.params);
  const search = query.q.trim();
  if (search) {
    const pattern = likePattern(search);
    if (language) {
      where.push(
        "(title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM enrichment e WHERE e.match_key = catalog_titles.match_key AND json_extract(e.local_titles, ?) LIKE ? ESCAPE '\\'))",
      );
      params.push(pattern, `$.${language}`, pattern);
    } else {
      where.push("title LIKE ? ESCAPE '\\'");
      params.push(pattern);
    }
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

function countWhere(db: Database.Database, sql: string, params: Array<string | number> = []): number {
  const row = db.prepare(sql).get(...params) as { count: number };
  return row.count;
}

export function queryLibrary(query: LibraryQuery, db = getDb()): LibraryResponse {
  const language = titleLanguage(getMeta(db, "title_language"));
  const { where, params } = filterClause(query, language);
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
    fileBrowserUrl: getMeta(db, "file_browser_url") ?? "",
    fileBrowserRoot: getMeta(db, "file_browser_root") ?? "",
    stats: {
      total: countWhere(db, `SELECT COUNT(*) AS count FROM catalog_titles`),
      missing: countWhere(db, `SELECT COUNT(*) AS count FROM catalog_titles WHERE ${missingSql}`),
      notInPlex: countWhere(db, `SELECT COUNT(*) AS count FROM catalog_titles WHERE in_plex = 0`),
      notPlayable: countWhere(db, `SELECT COUNT(*) AS count FROM catalog_titles WHERE playable_label != 'video'`),
    },
    page: { offset: query.offset, limit: query.limit, filtered },
    titles: libraryTitles(rows, onlineByKey, language, db),
  };
}

function libraryTitles(
  rows: TitleRow[],
  onlineByKey: Map<string, OnlineMeta>,
  language: string,
  db: Database.Database,
): LibraryTitle[] {
  const detections = detectionMap(db);
  const titles = rows.map((row) => {
    const key = row.match_key || enrichmentKey({
      kind: row.kind === "series" ? "series" : "movie",
      title: row.title,
      year: row.year,
      imdbId: row.imdb_id,
      tmdbId: row.tmdb_id,
      tvdbId: row.tvdb_id,
    });
    return mapTitle(row, onlineByKey.get(key) ?? null, language, detections);
  });
  const seriesIds = titles.filter((title) => title.kind === "series").map((title) => title.id);
  if (seriesIds.length === 0) return titles;
  const placeholders = seriesIds.map(() => "?").join(", ");
  const episodes = db
    .prepare(
      `SELECT catalog_id, path, audio_tracks, subtitle_tracks, versions_json
       FROM catalog_episodes WHERE catalog_id IN (${placeholders})`,
    )
    .all(...seriesIds) as Array<{
    catalog_id: number;
    path: string | null;
    audio_tracks: string | null;
    subtitle_tracks: string | null;
    versions_json: string | null;
  }>;
  const grouped = new Map<number, Array<{ audioTracks: AudioTrack[]; subtitleTracks: SubtitleTrack[] }>>();
  for (const episode of episodes) {
    const versions = parseVersions(episode.versions_json);
    const audioTracks = versions.length
      ? versions.flatMap((version) => overlayAudio(version.path, version.audioTracks, detections))
      : overlayAudio(episode.path, parseAudioTracks(parseJson(episode.audio_tracks)), detections);
    const subtitleTracks = versions.length
      ? versions.flatMap((version) => subtitles(version.path, version.subtitleTracks, detections))
      : subtitles(episode.path, parseSubtitleTracks(parseJson(episode.subtitle_tracks)), detections);
    const list = grouped.get(episode.catalog_id) ?? [];
    list.push({ audioTracks, subtitleTracks });
    grouped.set(episode.catalog_id, list);
  }
  for (const title of titles) {
    const files = grouped.get(title.id);
    if (!files?.length) continue;
    title.audioTracks = mergeAudioTracks(files.map((file) => file.audioTracks));
    title.subtitleTracks = mergeSubtitleTracks(files.map((file) => file.subtitleTracks));
  }
  return titles;
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
  audio_tracks: string | null;
  subtitle_tracks: string | null;
  runtime_minutes: number | null;
  detail_json: string | null;
  versions_json: string | null;
};

export function queryEpisodes(catalogId: number, db = getDb()): LibraryEpisode[] {
  const detections = detectionMap(db);
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
    audioTracks: overlayAudio(row.path, parseAudioTracks(parseJson(row.audio_tracks)), detections),
    subtitleTracks: subtitles(row.path, parseSubtitleTracks(parseJson(row.subtitle_tracks)), detections),
    runtimeMinutes: row.runtime_minutes,
    detail: parseDetail(row.detail_json),
    versions: parseVersions(row.versions_json).map((version) => ({
      ...version,
      audioTracks: overlayAudio(version.path, version.audioTracks, detections),
      subtitleTracks: subtitles(version.path, version.subtitleTracks, detections),
    })),
    inPlex: row.in_plex === 1,
    inSonarr: row.in_sonarr === 1,
    inBazarr: row.in_bazarr === 1,
    airDate: row.air_date,
  }));
}

export function clearLibrary(db = getDb()) {
  const write = db.transaction(() => {
    deleteAllSourceRecords(db);
    clearCatalog(db);
    clearEnrichment(db);
    setMeta(db, "demo", "0");
    setMeta(db, "last_sync_status", "idle");
    setMeta(db, "last_sync_notes", "[]");
    setMeta(db, "last_sync_at", "");
  });
  write();
}

export function clearCatalog(db: Database.Database) {
  db.prepare(`DELETE FROM catalog_episodes`).run();
  db.prepare(`DELETE FROM catalog_titles`).run();
}
