import type Database from "better-sqlite3";
import { asArray, asRecord, fetchJson, normalizeBaseUrl } from "@/lib/connectors/http";
import { listConnectors } from "@/lib/db";

export type PlexSection = { key: string; locations: string[] };

function clean(folder: string): string {
  const normalized = folder.replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function inside(folder: string, root: string): boolean {
  const child = clean(folder);
  const parent = clean(root);
  return child === parent || child.startsWith(`${parent}/`);
}

export function parsePlexSections(payload: unknown): PlexSection[] {
  const container = asRecord(asRecord(payload)?.MediaContainer);
  return asArray(container?.Directory).flatMap((item) => {
    const record = asRecord(item);
    const key = record?.key;
    if (typeof key !== "string" && typeof key !== "number") return [];
    const locations = asArray(record?.Location)
      .map((location) => asRecord(location)?.path)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    return [{ key: String(key), locations }];
  });
}

/** The section whose folder holds this path, preferring the deepest matching folder. */
export function plexScanTarget(sections: PlexSection[], folders: string[]): { key: string; folder: string } | null {
  let best: { key: string; folder: string; depth: number } | null = null;
  for (const folder of folders) {
    for (const section of sections) {
      for (const location of section.locations) {
        if (!inside(folder, location)) continue;
        const depth = clean(location).length;
        if (!best || depth > best.depth) best = { key: section.key, folder: clean(folder), depth };
      }
    }
  }
  return best ? { key: best.key, folder: best.folder } : null;
}

export function radarrMovieFor(movies: unknown[], folders: string[]): number | null {
  for (const movie of movies) {
    const record = asRecord(movie);
    const id = record?.id;
    const moviePath = record?.path;
    if (typeof id !== "number" || typeof moviePath !== "string") continue;
    if (folders.some((folder) => clean(folder) === clean(moviePath))) return id;
  }
  return null;
}

export function sonarrSeriesFor(series: unknown[], folders: string[]): number | null {
  for (const show of series) {
    const record = asRecord(show);
    const id = record?.id;
    const showPath = record?.path;
    if (typeof id !== "number" || typeof showPath !== "string") continue;
    if (folders.some((folder) => inside(folder, showPath))) return id;
  }
  return null;
}

async function post(url: string, headers: Record<string, string>, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await response.arrayBuffer().catch(() => undefined);
}

/**
 * After a new file lands in a folder: a Plex partial scan of that folder only,
 * and a Radarr or Sonarr rescan of the movie or series that owns it. Plex is only reached through its API.
 */
export async function announceFolder(db: Database.Database, folders: string[]): Promise<string> {
  const wanted = [...new Set(folders.filter(Boolean).map(clean))];
  if (wanted.length === 0) return "";
  const connectors = listConnectors(db);
  const told: string[] = [];
  const missed: string[] = [];

  const plex = connectors.find((connector) => connector.id === "plex" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (plex) {
    try {
      const base = normalizeBaseUrl(plex.baseUrl, 32400);
      const headers = { Accept: "application/json", "X-Plex-Token": plex.apiKey, "X-Plex-Product": "Metarr", "X-Plex-Client-Identifier": "metarr-local" };
      const target = plexScanTarget(parsePlexSections(await fetchJson(`${base}/library/sections`, headers)), wanted);
      if (!target) throw new Error("no library holds this folder");
      const response = await fetch(`${base}/library/sections/${encodeURIComponent(target.key)}/refresh?path=${encodeURIComponent(target.folder)}`, {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      told.push("Plex");
    } catch {
      missed.push("Plex");
    }
  }

  const radarr = connectors.find((connector) => connector.id === "radarr" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (radarr) {
    try {
      const base = normalizeBaseUrl(radarr.baseUrl, 7878);
      const headers = { Accept: "application/json", "X-Api-Key": radarr.apiKey };
      const movieId = radarrMovieFor(asArray(await fetchJson(`${base}/api/v3/movie`, headers, 60_000)), wanted);
      if (movieId != null) {
        await post(`${base}/api/v3/command`, headers, { name: "RescanMovie", movieId });
        told.push("Radarr");
      }
    } catch {
      missed.push("Radarr");
    }
  }

  const sonarr = connectors.find((connector) => connector.id === "sonarr" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (sonarr) {
    try {
      const base = normalizeBaseUrl(sonarr.baseUrl, 8989);
      const headers = { Accept: "application/json", "X-Api-Key": sonarr.apiKey };
      const seriesId = sonarrSeriesFor(asArray(await fetchJson(`${base}/api/v3/series`, headers, 60_000)), wanted);
      if (seriesId != null) {
        await post(`${base}/api/v3/command`, headers, { name: "RescanSeries", seriesId });
        told.push("Sonarr");
      }
    } catch {
      missed.push("Sonarr");
    }
  }

  const parts: string[] = [];
  if (told.length) parts.push(`${told.join(", ")} asked to rescan the folder.`);
  if (missed.length) parts.push(`${missed.join(", ")} could not be asked to rescan.`);
  return parts.join(" ");
}
