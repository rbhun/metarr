import { asRecord, normalizeBaseUrl } from "@/lib/connectors/http";
import { refreshFileSources } from "@/lib/detect/refresh";
import { getMeta, listConnectors, parseSubtitleTracks, setMeta } from "@/lib/db";
import { plexReadsSidecar } from "@/lib/media";
import type Database from "better-sqlite3";

export type PlayerSource = {
  connector: string;
  externalKey: string;
  parentKey: string | null;
  path: string | null;
  filesJson: string;
};

export type PlayerIds = {
  plex: string[];
  radarr: number[];
  sonarr: number[];
  bazarrMovies: number[];
  bazarrSeries: number[];
};

const recent = new Map<string, number>();
const HOLD_MS = 10 * 60 * 1000;

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

function rowMatches(row: PlayerSource, videoPaths: string[]): boolean {
  return videoPaths.some((videoPath) => (row.path && samePath(row.path, videoPath)) || filesContain(row.filesJson, videoPath));
}

function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function addNumber(target: number[], value: number) {
  if (!target.includes(value)) target.push(value);
}

export function playerIdsForPaths(rows: PlayerSource[], videoPaths: string[]): PlayerIds {
  const ids: PlayerIds = { plex: [], radarr: [], sonarr: [], bazarrMovies: [], bazarrSeries: [] };
  for (const row of rows) {
    if (!rowMatches(row, videoPaths)) continue;
    if (row.connector === "plex") {
      const ratingKey = row.externalKey.match(/^(?:item|episode):(\d+)$/)?.[1];
      if (ratingKey && !ids.plex.includes(ratingKey)) ids.plex.push(ratingKey);
    } else if (row.connector === "radarr" && /^\d+$/.test(row.externalKey)) {
      addNumber(ids.radarr, Number(row.externalKey));
    } else if (row.connector === "sonarr") {
      const seriesId = row.parentKey?.match(/^sonarr-series:(\d+)$/)?.[1];
      if (seriesId) addNumber(ids.sonarr, Number(seriesId));
    } else if (row.connector === "bazarr") {
      const movieId = row.externalKey.match(/^radarr:(\d+)$/)?.[1];
      if (movieId) addNumber(ids.bazarrMovies, Number(movieId));
      const seriesId = row.parentKey?.match(/^sonarr-series:(\d+)$/)?.[1];
      if (seriesId) addNumber(ids.bazarrSeries, Number(seriesId));
    }
  }
  return ids;
}

function remembered(key: string): boolean {
  const at = recent.get(key);
  return at != null && Date.now() - at < HOLD_MS;
}

function remember(key: string) {
  recent.set(key, Date.now());
}

async function send(url: string, method: string, headers: Record<string, string>, body?: string): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers,
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function commandId(payload: unknown): number | null {
  const id = asRecord(payload)?.id;
  const numeric = typeof id === "number" ? id : typeof id === "string" ? Number(id) : NaN;
  return Number.isInteger(numeric) ? numeric : null;
}

async function waitForCommand(base: string, headers: Record<string, string>, id: number) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const status = String(asRecord(await send(`${base}/api/v3/command/${id}`, "GET", headers))?.status ?? "").toLowerCase();
      if (status === "completed" || status === "failed" || status === "aborted" || status === "cancelled") return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function sourcesFor(db: Database.Database, videoPaths: string[]): PlayerSource[] {
  const rows = db
    .prepare(`SELECT connector, external_key, parent_key, path, files_json FROM source_records`)
    .all() as Array<{ connector: string; external_key: string; parent_key: string | null; path: string | null; files_json: string }>;
  return rows.map((row) => ({
    connector: row.connector,
    externalKey: row.external_key,
    parentKey: row.parent_key,
    path: row.path,
    filesJson: row.files_json,
  }));
}

async function askEach(label: string, keys: string[], run: (key: string) => Promise<void>, asked: string[], failed: string[]) {
  if (keys.length === 0) return;
  let problem = false;
  for (const key of keys) {
    const memory = `${label}:${key}`;
    if (remembered(memory)) continue;
    try {
      await run(key);
      remember(memory);
    } catch {
      problem = true;
    }
  }
  if (problem) failed.push(label);
  else asked.push(label);
}

export type SidecarFile = { videoPath: string; file: string };

/** Subtitle files the folder scan found that Plex does not list, but would read by name. */
export function unreadSidecars(rows: Array<{ path: string | null; subtitleTracks: string | null; versions: string | null }>): SidecarFile[] {
  const found: SidecarFile[] = [];
  const add = (videoPath: unknown, tracks: unknown) => {
    if (typeof videoPath !== "string" || !videoPath) return;
    for (const track of parseSubtitleTracks(tracks)) {
      if (track.folderOnly && track.file && plexReadsSidecar(videoPath, track.file)) found.push({ videoPath, file: track.file });
    }
  };
  for (const row of rows) {
    add(row.path, parseJsonValue(row.subtitleTracks));
    const versions = parseJsonValue(row.versions);
    if (!Array.isArray(versions)) continue;
    for (const version of versions) {
      const record = asRecord(version);
      if (record) add(record.path, record.subtitleTracks);
    }
  }
  return found;
}

function parseJsonValue(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

const SIDECAR_ASKS = "plex_sidecar_asks";
const SIDECAR_ASK_AGAIN_MS = 7 * 24 * 60 * 60 * 1000;
const SIDECAR_ASKS_PER_SYNC = 25;

/**
 * Plex finds a new subtitle file only when it scans that folder, which it often
 * skips on network shares. Ask it to refresh titles whose folder has one it
 * would read. A file is asked about at most once a week.
 */
export async function askPlexToReadSidecars(db: Database.Database): Promise<string> {
  const plex = listConnectors(db).find((connector) => connector.id === "plex" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (!plex) return "";
  const rows = [
    ...(db.prepare(`SELECT path, subtitle_tracks AS subtitleTracks, versions_json AS versions FROM catalog_titles`).all() as Array<{ path: string | null; subtitleTracks: string | null; versions: string | null }>),
    ...(db.prepare(`SELECT path, subtitle_tracks AS subtitleTracks, versions_json AS versions FROM catalog_episodes`).all() as Array<{ path: string | null; subtitleTracks: string | null; versions: string | null }>),
  ];
  const now = Date.now();
  const previous = asRecord(parseJsonValue(getMeta(db, SIDECAR_ASKS))) ?? {};
  const asks: Record<string, number> = {};
  for (const [file, at] of Object.entries(previous)) {
    if (typeof at === "number" && now - at < SIDECAR_ASK_AGAIN_MS) asks[file] = at;
  }
  const due = unreadSidecars(rows).filter((sidecar) => asks[sidecar.file] == null);
  if (!due.length) return "";
  const sources = sourcesFor(db, []);
  const base = normalizeBaseUrl(plex.baseUrl, 32400);
  const headers = { Accept: "application/json", "X-Plex-Token": plex.apiKey, "X-Plex-Product": "Metarr", "X-Plex-Client-Identifier": "metarr-local" };
  const refreshed = new Set<string>();
  let failed = 0;
  for (const sidecar of due) {
    const ids = playerIdsForPaths(sources, [sidecar.videoPath]).plex;
    if (!ids.length) continue;
    const fresh = ids.filter((id) => !refreshed.has(id));
    if (refreshed.size + fresh.length > SIDECAR_ASKS_PER_SYNC) break;
    try {
      for (const id of fresh) {
        await send(`${base}/library/metadata/${id}/refresh`, "PUT", headers);
        refreshed.add(id);
      }
      asks[sidecar.file] = now;
    } catch {
      failed += 1;
    }
  }
  setMeta(db, SIDECAR_ASKS, JSON.stringify(asks));
  if (!refreshed.size && !failed) return "";
  const titles = refreshed.size === 1 ? "1 title" : `${refreshed.size} titles`;
  return failed
    ? `Asked Plex to refresh ${titles} with new subtitle files. ${failed} could not be asked.`
    : `Asked Plex to refresh ${titles} with new subtitle files.`;
}

/**
 * Plex, Radarr, and Sonarr copy track languages from the file. Asking them to
 * re-read is what updates their databases. Bazarr re-reads subtitle names.
 */
export async function notifyPlayers(db: Database.Database, videoPaths: string[], subtitles: boolean): Promise<string> {
  if (videoPaths.length === 0) return "";
  const ids = playerIdsForPaths(sourcesFor(db, videoPaths), videoPaths);
  const connectors = listConnectors(db);
  const asked: string[] = [];
  const failed: string[] = [];
  const pending: Array<{ base: string; headers: Record<string, string>; id: number }> = [];
  let plexFresh = false;

  const plex = connectors.find((connector) => connector.id === "plex" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (plex) {
    const base = normalizeBaseUrl(plex.baseUrl, 32400);
    const headers = { Accept: "application/json", "X-Plex-Token": plex.apiKey, "X-Plex-Product": "Metarr", "X-Plex-Client-Identifier": "metarr-local" };
    await askEach(
      "Plex",
      ids.plex,
      async (id) => {
        await send(`${base}/library/metadata/${id}/analyze`, "PUT", headers);
        plexFresh = true;
      },
      asked,
      failed,
    );
  }

  const radarr = connectors.find((connector) => connector.id === "radarr" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (radarr) {
    const base = normalizeBaseUrl(radarr.baseUrl, 7878);
    const headers = { Accept: "application/json", "Content-Type": "application/json", "X-Api-Key": radarr.apiKey };
    await askEach(
      "Radarr",
      ids.radarr.map(String),
      async (id) => {
        const command = commandId(await send(`${base}/api/v3/command`, "POST", headers, JSON.stringify({ name: "RescanMovie", movieId: Number(id) })));
        if (command != null) pending.push({ base, headers, id: command });
      },
      asked,
      failed,
    );
  }

  const sonarr = connectors.find((connector) => connector.id === "sonarr" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (sonarr) {
    const base = normalizeBaseUrl(sonarr.baseUrl, 8989);
    const headers = { Accept: "application/json", "Content-Type": "application/json", "X-Api-Key": sonarr.apiKey };
    await askEach(
      "Sonarr",
      ids.sonarr.map(String),
      async (id) => {
        const command = commandId(await send(`${base}/api/v3/command`, "POST", headers, JSON.stringify({ name: "RescanSeries", seriesId: Number(id) })));
        if (command != null) pending.push({ base, headers, id: command });
      },
      asked,
      failed,
    );
  }

  const bazarr = connectors.find((connector) => connector.id === "bazarr" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (bazarr && subtitles) {
    const base = normalizeBaseUrl(bazarr.baseUrl, 6767);
    const headers = { Accept: "application/json", "Content-Type": "application/json", "X-Api-Key": bazarr.apiKey };
    await askEach(
      "Bazarr",
      [...ids.bazarrMovies.map((id) => `movie:${id}`), ...ids.bazarrSeries.map((id) => `series:${id}`)],
      async (key) => {
        const movie = key.match(/^movie:(\d+)$/)?.[1];
        if (movie) {
          await send(`${base}/api/movies`, "PATCH", headers, JSON.stringify({ radarrid: Number(movie), action: "scan-disk" }));
          return;
        }
        const series = key.match(/^series:(\d+)$/)?.[1];
        await send(`${base}/api/series`, "PATCH", headers, JSON.stringify({ seriesid: Number(series), action: "scan-disk" }));
      },
      asked,
      failed,
    );
  }

  await Promise.all(pending.map((command) => waitForCommand(command.base, command.headers, command.id)));
  let refreshed = "";
  try {
    refreshed = await refreshFileSources(db, videoPaths, { waitForPlex: plexFresh });
  } catch {
    refreshed = "";
  }

  const parts: string[] = [];
  if (asked.length === 1) parts.push(`${asked[0]} was asked to re-read the file.`);
  else if (asked.length > 1) parts.push(`${nameList(asked)} were asked to re-read the file.`);
  if (failed.length === 1) parts.push(`${failed[0]} could not be asked to re-read the file.`);
  else if (failed.length > 1) parts.push(`${nameList(failed)} could not be asked to re-read the file.`);
  if (refreshed) parts.push(refreshed);
  return parts.join(" ");
}
