import { fetchJson } from "@/lib/connectors/http";
import { listConnectors } from "@/lib/db";
import type Database from "better-sqlite3";

function container(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const root = value as { MediaContainer?: unknown };
  const media = root.MediaContainer;
  if (!media || typeof media !== "object" || Array.isArray(media)) return null;
  return media as Record<string, unknown>;
}

function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

export function plexActivitiesBusy(value: unknown): boolean {
  const media = container(value);
  if (!media) return false;
  if (typeof media.size === "number" && media.size > 0) return true;
  return listOf(media.Activity).length > 0;
}

export function plexTranscodeBusy(value: unknown): boolean {
  const media = container(value);
  if (!media) return false;
  return listOf(media.Metadata).some((item) => {
    if (!item || typeof item !== "object") return false;
    const session = (item as { TranscodeSession?: unknown }).TranscodeSession;
    return session != null && session !== false;
  });
}

/** Any current playback, including a direct play that is not transcoding. */
export function plexSessionBusy(value: unknown): boolean {
  const media = container(value);
  if (!media) return false;
  if (typeof media.size === "number" && media.size > 0) return true;
  return listOf(media.Metadata).length > 0;
}

export async function plexIsBusy(db: Database.Database): Promise<boolean> {
  const plex = listConnectors(db).find((connector) => connector.id === "plex" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (!plex) return false;
  const headers = { Accept: "application/json", "X-Plex-Token": plex.apiKey };
  try {
    const [activities, sessions] = await Promise.all([
      fetchJson(`${plex.baseUrl}/activities`, headers, 4_000),
      fetchJson(`${plex.baseUrl}/status/sessions`, headers, 4_000),
    ]);
    return plexActivitiesBusy(activities) || plexTranscodeBusy(sessions);
  } catch {
    return false;
  }
}

/** Scanning, or anyone watching. A failed request does not count as busy. */
export async function plexLibraryBusy(db: Database.Database): Promise<boolean> {
  const plex = listConnectors(db).find((connector) => connector.id === "plex" && connector.enabled && connector.baseUrl && connector.apiKey);
  if (!plex) return false;
  const headers = { Accept: "application/json", "X-Plex-Token": plex.apiKey };
  let busy = false;
  try {
    busy = plexActivitiesBusy(await fetchJson(`${plex.baseUrl}/activities`, headers, 4_000));
  } catch {
    busy = false;
  }
  try {
    busy = busy || plexSessionBusy(await fetchJson(`${plex.baseUrl}/status/sessions`, headers, 4_000));
  } catch {
    return busy;
  }
  return busy;
}
