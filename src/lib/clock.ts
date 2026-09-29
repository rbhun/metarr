import type Database from "better-sqlite3";
import { getMeta, setMeta } from "@/lib/db";

const KEY = "time_zone";

const globalForClock = globalThis as { __metarrStartTz?: string | null };

/** TZ from the environment at startup, used again when the setting is cleared. */
function startTz(): string | null {
  if (globalForClock.__metarrStartTz === undefined) globalForClock.__metarrStartTz = process.env.TZ ?? null;
  return globalForClock.__metarrStartTz;
}

/** The canonical IANA name, or null when the name is not a time zone. */
export function parseTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Node reads TZ on every change, so schedule hours follow the setting without a restart. */
export function applyTimeZone(db: Database.Database) {
  const fallback = startTz();
  const stored = parseTimeZone(getMeta(db, KEY));
  const zone = stored ?? fallback;
  if (zone) process.env.TZ = zone;
  else delete process.env.TZ;
}

export function saveTimeZone(db: Database.Database, zone: string | null) {
  setMeta(db, KEY, zone ?? "");
  applyTimeZone(db);
}

export type ClockInfo = { timeZone: string; now: string; setting: string | null };

export function clockInfo(db: Database.Database, now = new Date()): ClockInfo {
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    now: `${hours}:${minutes}`,
    setting: parseTimeZone(getMeta(db, KEY)),
  };
}
