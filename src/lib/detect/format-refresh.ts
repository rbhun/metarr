import { pathKey } from "@/lib/folder-scan";
import { getMeta, setMeta } from "@/lib/db";
import { notifyPlayers } from "@/lib/detect/publish";
import type Database from "better-sqlite3";

const QUEUE_KEY = "format_refresh_queue";
const DONE_KEY = "format_refresh_done";

const deferred = new Set<string>();

function readPaths(db: Database.Database, key: string): string[] {
  try {
    const parsed = JSON.parse(getMeta(db, key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function writePaths(db: Database.Database, key: string, paths: string[]) {
  setMeta(db, key, JSON.stringify(paths));
}

/** Remember files whose stream has a format the apps have not stored yet. */
export function queueFormatRefresh(db: Database.Database, paths: string[]) {
  const done = new Set(readPaths(db, DONE_KEY).map((filePath) => pathKey(filePath)).filter((key): key is string => Boolean(key)));
  const queue = readPaths(db, QUEUE_KEY);
  const queued = new Set(queue.map((filePath) => pathKey(filePath)));
  let changed = false;
  for (const filePath of paths) {
    const key = pathKey(filePath);
    if (!key || done.has(key) || queued.has(key)) continue;
    queue.push(filePath);
    queued.add(key);
    changed = true;
  }
  if (changed) writePaths(db, QUEUE_KEY, queue);
}

export function hasFormatRefresh(db: Database.Database): boolean {
  return readPaths(db, QUEUE_KEY).some((filePath) => {
    const key = pathKey(filePath);
    return Boolean(key) && !deferred.has(key!);
  });
}

/**
 * Ask Plex, Radarr, and Sonarr to read one file again. The codec and channel
 * count are already in the stream, which is what those apps store.
 */
export async function refreshNextFormat(db: Database.Database): Promise<boolean> {
  const queue = readPaths(db, QUEUE_KEY);
  const index = queue.findIndex((filePath) => {
    const key = pathKey(filePath);
    return Boolean(key) && !deferred.has(key!);
  });
  if (index < 0) return false;
  const filePath = queue[index]!;
  const key = pathKey(filePath)!;
  queue.splice(index, 1);
  writePaths(db, QUEUE_KEY, queue);
  let sentence = "";
  try {
    sentence = await notifyPlayers(db, [filePath], false);
  } catch {
    deferred.add(key);
    queue.push(filePath);
    writePaths(db, QUEUE_KEY, queue);
    return true;
  }
  const asked = /was asked|were asked/.test(sentence);
  const failed = /could not be asked/.test(sentence);
  if (failed && !asked) {
    deferred.add(key);
    queue.push(filePath);
    writePaths(db, QUEUE_KEY, queue);
    return true;
  }
  const done = readPaths(db, DONE_KEY);
  if (!done.some((item) => pathKey(item) === key)) done.push(filePath);
  writePaths(db, DONE_KEY, done);
  return true;
}
