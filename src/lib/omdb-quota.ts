import type Database from "better-sqlite3";
import { getDb, getMeta, setMeta } from "@/lib/db";

export const OMDB_DAILY_LIMIT = 1000;
const META_KEY = "omdb_daily";

export type OmdbUsage = {
  day: string;
  count: number;
  limit: number;
  remaining: number;
};

export function omdbDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function readCount(db: Database.Database, day: string): number {
  const raw = getMeta(db, META_KEY);
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as { day?: string; count?: number };
    if (parsed.day !== day || typeof parsed.count !== "number" || parsed.count < 0) return 0;
    return Math.min(OMDB_DAILY_LIMIT, Math.floor(parsed.count));
  } catch {
    return 0;
  }
}

export function omdbUsage(db = getDb(), now = new Date()): OmdbUsage {
  const day = omdbDay(now);
  const count = readCount(db, day);
  return { day, count, limit: OMDB_DAILY_LIMIT, remaining: OMDB_DAILY_LIMIT - count };
}

export function reserveOmdbRequest(db = getDb(), now = new Date()): boolean {
  const day = omdbDay(now);
  const count = readCount(db, day);
  if (count >= OMDB_DAILY_LIMIT) return false;
  setMeta(db, META_KEY, JSON.stringify({ day, count: count + 1 }));
  return true;
}

export function markOmdbExhausted(db = getDb(), now = new Date()) {
  setMeta(db, META_KEY, JSON.stringify({ day: omdbDay(now), count: OMDB_DAILY_LIMIT }));
}
