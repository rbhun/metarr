import type Database from "better-sqlite3";
import { getMeta, setMeta } from "@/lib/db";

const INTERVALS = [1, 3, 6, 12, 24] as const;

export type SyncInterval = (typeof INTERVALS)[number];

export type SyncSchedule = {
  enabled: boolean;
  intervalHours: SyncInterval;
};

export function offeredSyncInterval(value: unknown): SyncInterval | null {
  const hours = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return (INTERVALS as readonly number[]).includes(hours) ? (hours as SyncInterval) : null;
}

export function parseSyncInterval(value: unknown, fallback: SyncInterval = 6): SyncInterval {
  return offeredSyncInterval(value) ?? fallback;
}

export function readSyncSchedule(db: Database.Database): SyncSchedule {
  return {
    enabled: getMeta(db, "sync_schedule_enabled") === "1",
    intervalHours: parseSyncInterval(getMeta(db, "sync_schedule_interval")),
  };
}

export function writeSyncSchedule(db: Database.Database, settings: SyncSchedule) {
  setMeta(db, "sync_schedule_enabled", settings.enabled ? "1" : "0");
  setMeta(db, "sync_schedule_interval", String(parseSyncInterval(settings.intervalHours)));
}

/** A resync is due when the last finished sync is older than the interval. */
export function syncIsDue(lastSyncAt: string | null, intervalHours: number, now: number): boolean {
  if (!lastSyncAt) return true;
  const then = Date.parse(lastSyncAt);
  if (!Number.isFinite(then)) return true;
  return now - then >= intervalHours * 3_600_000;
}
