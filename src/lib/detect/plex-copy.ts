import type Database from "better-sqlite3";
import { canRewrap } from "@/lib/rewrap/source";
import { enqueueLanguageRewrap } from "@/lib/rewrap/store";

/** Heard audio languages for one file, in track order. A track that was not recognized stays empty. */
export function recognizedAudioLanguages(db: Database.Database, filePath: string): Array<string | null> {
  const rows = db
    .prepare(`SELECT ordinal, language FROM detect_results WHERE path = ? AND kind = 'audio' AND language IS NOT NULL ORDER BY ordinal`)
    .all(filePath) as Array<{ ordinal: number; language: string }>;
  const languages: Array<string | null> = [];
  for (const row of rows) languages[row.ordinal] = row.language;
  return Array.from(languages, (language) => language ?? null);
}

const QUEUED =
  "Plex does not read a language stored in an AVI or a loose transport stream. An MKV copy was queued with the recognized languages on the audio streams. Plex is asked to scan that MKV, and the original is kept as .metarr-orig so the episode Plex plays is the MKV.";

const WAITING = "An MKV copy is already queued. Plex is asked to scan it when the copy is saved.";

/**
 * Queue one MKV copy for a file whose language Plex cannot read from the original.
 * A copy that is already waiting is left as it is. A finished copy is queued again
 * only when this is a new recognition, so a second track can be tagged on the MKV.
 */
export function queueLanguageCopy(db: Database.Database, filePath: string): { sentence: string; queued: boolean } {
  if (!canRewrap(null, filePath)) {
    return { sentence: "This file cannot store a language Plex reads, and it is not copied to an MKV.", queued: false };
  }
  const result = enqueueLanguageRewrap(db, { path: filePath }, true);
  if (result === "waiting") return { sentence: WAITING, queued: false };
  return { sentence: QUEUED, queued: true };
}

/**
 * Recognized audio on an AVI or loose transport stream that has never been copied.
 * One row per file. A file that already has a rewrap job is left alone.
 */
export function queueRecognizedCopies(db: Database.Database): boolean {
  const paths = db
    .prepare(`SELECT DISTINCT path FROM detect_results WHERE kind = 'audio' AND language IS NOT NULL`)
    .all() as Array<{ path: string }>;
  const hasJob = db.prepare(`SELECT 1 AS ok FROM rewrap_jobs WHERE path = ? LIMIT 1`);
  let queued = false;
  for (const row of paths) {
    if (!row.path || !canRewrap(null, row.path)) continue;
    if (hasJob.get(row.path)) continue;
    if (enqueueLanguageRewrap(db, { path: row.path }, false) === "queued") queued = true;
  }
  return queued;
}
