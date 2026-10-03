import path from "node:path";
import type Database from "better-sqlite3";
import { clampHour } from "@/lib/detect/schedule";
import { languageCode } from "@/lib/media";

export type RewrapPause = "window" | "plex" | "detect" | "remux" | "merge" | "off";

export type RewrapSettings = {
  enabled: boolean;
  startHour: number;
  endHour: number;
  /** Audio in this language moves to the front and becomes the default track. Empty keeps the file order. */
  firstLanguage: string;
};

export type RewrapItem = {
  path: string;
  label?: string;
  /** Known language per audio track, in file order; null where unknown. */
  languages?: Array<string | null>;
  /** Known language per subtitle stream inside the file, in file order. */
  subtitleLanguages?: Array<string | null>;
};

export type RewrapJob = {
  id: number;
  path: string;
  label: string;
  languages: Array<string | null>;
  subtitleLanguages: Array<string | null>;
};

export type RewrapJobStatus = "pending" | "running" | "done" | "failed";

export type RewrapJobView = {
  id: number;
  path: string;
  label: string;
  status: RewrapJobStatus;
  message: string | null;
  progress: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RewrapTotals = { pending: number; running: number; done: number; failed: number };

type JobRow = {
  id: number;
  path: string;
  label: string;
  languages: string;
  immediate: number;
  status: string;
  message: string | null;
  progress: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const DEFAULT_FIRST_LANGUAGE = "Hungarian";

function meta(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMetaValue(db: Database.Database, key: string, value: string) {
  db.prepare(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export function readRewrapSettings(db: Database.Database): RewrapSettings {
  const first = meta(db, "rewrap_first_language");
  return {
    enabled: meta(db, "rewrap_schedule_enabled") !== "0",
    startHour: clampHour(meta(db, "rewrap_schedule_start"), 1),
    endHour: clampHour(meta(db, "rewrap_schedule_end"), 7),
    firstLanguage: first == null ? DEFAULT_FIRST_LANGUAGE : first,
  };
}

/** Null when the text is not a language Metarr knows; an empty string turns reordering off. */
export function parseFirstLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return "";
  if (text.length > 40 || !languageCode(text)) return null;
  return text;
}

export function writeRewrapSettings(
  db: Database.Database,
  settings: { enabled?: boolean; startHour?: number; endHour?: number; firstLanguage?: string },
) {
  if (settings.enabled != null) setMetaValue(db, "rewrap_schedule_enabled", settings.enabled ? "1" : "0");
  if (settings.startHour != null) setMetaValue(db, "rewrap_schedule_start", String(settings.startHour));
  if (settings.endHour != null) setMetaValue(db, "rewrap_schedule_end", String(settings.endHour));
  if (settings.firstLanguage != null) setMetaValue(db, "rewrap_first_language", settings.firstLanguage);
}

export function readRewrapPause(db: Database.Database): RewrapPause | null {
  const value = meta(db, "rewrap_pause");
  if (value === "window" || value === "plex" || value === "detect" || value === "remux" || value === "merge" || value === "off") return value;
  return null;
}

export function writeRewrapPause(db: Database.Database, pause: RewrapPause | null) {
  if (!pause) {
    db.prepare(`DELETE FROM app_meta WHERE key = ?`).run("rewrap_pause");
    return;
  }
  setMetaValue(db, "rewrap_pause", pause);
}

export type RewrapEnqueueResult = { added: number; already: number; promoted: number };

/** `immediate` jobs skip the schedule window and the busy pauses; a waiting job for the same file is moved up. */
export function enqueueRewraps(db: Database.Database, items: RewrapItem[], immediate = false): RewrapEnqueueResult {
  const existing = db.prepare(`SELECT status, immediate FROM rewrap_jobs WHERE path = ? AND status IN ('pending', 'running') ORDER BY id LIMIT 1`);
  const promote = db.prepare(`UPDATE rewrap_jobs SET immediate = 1 WHERE path = ? AND status = 'pending'`);
  const insert = db.prepare(
    `INSERT INTO rewrap_jobs (path, label, languages, immediate, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
  );
  const now = new Date().toISOString();
  let added = 0;
  let already = 0;
  let promoted = 0;
  const seen = new Set<string>();
  const write = db.transaction(() => {
    for (const item of items) {
      const filePath = item.path.trim();
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      const row = existing.get(filePath) as { status: string; immediate: number } | undefined;
      if (row) {
        if (immediate && row.status === "pending" && row.immediate !== 1) {
          promote.run(filePath);
          promoted += 1;
        } else {
          already += 1;
        }
        continue;
      }
      const label = item.label?.trim() || path.basename(filePath) || filePath;
      const languages = item.subtitleLanguages?.length
        ? { audio: item.languages ?? [], subtitles: item.subtitleLanguages }
        : (item.languages ?? []);
      insert.run(filePath, label, JSON.stringify(languages), immediate ? 1 : 0, now);
      added += 1;
    }
  });
  write();
  return { added, already, promoted };
}

function languageList(value: unknown): Array<string | null> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" && item.trim() ? item.trim() : null));
}

/** Older jobs stored only the audio list; newer ones store audio and subtitles together. */
export function parseLanguages(raw: string): { audio: Array<string | null>; subtitles: Array<string | null> } {
  try {
    const value = JSON.parse(raw) as unknown;
    if (Array.isArray(value)) return { audio: languageList(value), subtitles: [] };
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return { audio: languageList(record.audio), subtitles: languageList(record.subtitles) };
  } catch {
    return { audio: [], subtitles: [] };
  }
}

export function hasImmediateRewrap(db: Database.Database): boolean {
  return Boolean(db.prepare(`SELECT 1 AS ok FROM rewrap_jobs WHERE status = 'pending' AND immediate = 1 LIMIT 1`).get());
}

/** Immediate jobs first; with `onlyImmediate`, scheduled jobs keep waiting for their window. */
export function claimNextRewrap(db: Database.Database, onlyImmediate = false): RewrapJob | null {
  const row = db
    .prepare(`SELECT * FROM rewrap_jobs WHERE status = 'pending' ${onlyImmediate ? "AND immediate = 1" : ""} ORDER BY immediate DESC, id LIMIT 1`)
    .get() as JobRow | undefined;
  if (!row) return null;
  const changed = db
    .prepare(`UPDATE rewrap_jobs SET status = 'running', started_at = ?, message = 'Waiting to start', progress = 0 WHERE id = ? AND status = 'pending'`)
    .run(new Date().toISOString(), row.id);
  if (changed.changes !== 1) return null;
  const languages = parseLanguages(row.languages);
  return { id: row.id, path: row.path, label: row.label, languages: languages.audio, subtitleLanguages: languages.subtitles };
}

export function updateRewrapProgress(db: Database.Database, id: number, progress: number, message: string) {
  db.prepare(`UPDATE rewrap_jobs SET progress = ?, message = ? WHERE id = ? AND status = 'running'`).run(progress, message.slice(0, 500), id);
}

/** Mark the other parts of a joined movie done, so a second queued part does not run. */
export function settleSplitRewraps(db: Database.Database, paths: string[], message: string, exceptId: number) {
  const wanted = new Set(paths.map((item) => item.toLowerCase()));
  const now = new Date().toISOString();
  const text = message.trim().slice(0, 1000);
  const pending = db.prepare(`SELECT id, path FROM rewrap_jobs WHERE status = 'pending'`).all() as Array<{ id: number; path: string }>;
  const mark = db.prepare(`UPDATE rewrap_jobs SET status = 'done', message = ?, progress = NULL, finished_at = ? WHERE id = ? AND status = 'pending'`);
  const existing = db.prepare(
    `SELECT 1 AS ok FROM rewrap_jobs WHERE lower(path) = lower(?) AND status IN ('pending', 'running', 'done') LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO rewrap_jobs (path, label, languages, immediate, status, message, created_at, finished_at) VALUES (?, ?, '[]', 0, 'done', ?, ?, ?)`,
  );
  const write = db.transaction(() => {
    for (const row of pending) {
      if (row.id === exceptId || !wanted.has(row.path.toLowerCase())) continue;
      mark.run(text, now, row.id);
    }
    for (const filePath of paths) {
      if (existing.get(filePath)) continue;
      insert.run(filePath, path.basename(filePath) || filePath, text, now, now);
    }
  });
  write();
}

export function finishRewrap(db: Database.Database, id: number, status: "done" | "failed", message: string | null) {
  const text =
    message && message.trim() ? message.trim().slice(0, 1000) : status === "failed" ? "Rewrap failed with no further detail from ffmpeg." : null;
  db.prepare(`UPDATE rewrap_jobs SET status = ?, message = ?, progress = NULL, finished_at = ? WHERE id = ?`).run(status, text, new Date().toISOString(), id);
}

export function retryFailedRewrap(db: Database.Database, id: number): "retried" | "missing" | "already" {
  const row = db.prepare(`SELECT path, status FROM rewrap_jobs WHERE id = ?`).get(id) as { path: string; status: string } | undefined;
  if (!row || row.status !== "failed") return "missing";
  const busy = db.prepare(`SELECT 1 AS ok FROM rewrap_jobs WHERE path = ? AND status IN ('pending', 'running') AND id != ?`).get(row.path, id);
  if (busy) {
    db.prepare(`DELETE FROM rewrap_jobs WHERE id = ? AND status = 'failed'`).run(id);
    return "already";
  }
  const changed = db
    .prepare(`UPDATE rewrap_jobs SET status = 'pending', message = NULL, progress = NULL, started_at = NULL, finished_at = NULL WHERE id = ? AND status = 'failed'`)
    .run(id);
  return changed.changes === 1 ? "retried" : "missing";
}

/** One retry per file, from its latest failure; files already queued or converted stay as they are. */
export function retryAllFailedRewrap(db: Database.Database): number {
  return db.transaction(() => {
    db.prepare(
      `DELETE FROM rewrap_jobs
       WHERE status = 'failed'
         AND EXISTS (SELECT 1 FROM rewrap_jobs AS other WHERE other.path = rewrap_jobs.path AND other.status IN ('pending', 'running'))`,
    ).run();
    return db
      .prepare(
        `UPDATE rewrap_jobs
         SET status = 'pending', message = NULL, progress = NULL, started_at = NULL, finished_at = NULL
         WHERE id IN (SELECT MAX(id) FROM rewrap_jobs WHERE status = 'failed' GROUP BY path)
           AND NOT EXISTS (
             SELECT 1 FROM rewrap_jobs AS other
             WHERE other.path = rewrap_jobs.path
               AND other.status IN ('pending', 'running', 'done')
           )`,
      )
      .run().changes;
  })();
}

export function releaseRunningRewrap(db: Database.Database) {
  db.prepare(`UPDATE rewrap_jobs SET status = 'pending', started_at = NULL, progress = NULL WHERE status = 'running'`).run();
}

export function rewrapIsRunning(db: Database.Database): boolean {
  return Boolean(db.prepare(`SELECT 1 AS ok FROM rewrap_jobs WHERE status = 'running' LIMIT 1`).get());
}

export function rewrapTotals(db: Database.Database): RewrapTotals {
  const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM rewrap_jobs GROUP BY status`).all() as Array<{ status: string; count: number }>;
  const totals = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in totals) totals[row.status as keyof typeof totals] = row.count;
  }
  return totals;
}

export function clearRewrapJobs(db: Database.Database, status: RewrapJobStatus): number {
  return db.prepare(`DELETE FROM rewrap_jobs WHERE status = ?`).run(status).changes;
}

/** Drop one waiting or failed MKV rewrap. Running and finished jobs stay. */
export function removeRewrapJob(db: Database.Database, id: number): boolean {
  return db.prepare(`DELETE FROM rewrap_jobs WHERE id = ? AND status IN ('pending', 'failed')`).run(id).changes === 1;
}

export function finishedRewrapPaths(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT path FROM rewrap_jobs WHERE status = 'done' AND (message IS NULL OR message NOT LIKE 'Dry run:%')`)
    .all() as Array<{ path: string }>;
  return new Set(rows.map((row) => row.path));
}

export function activeRewrap(db: Database.Database): { label: string; progress: number | null; message: string | null } | null {
  const row = db.prepare(`SELECT label, progress, message FROM rewrap_jobs WHERE status = 'running' ORDER BY id LIMIT 1`).get() as
    | { label: string; progress: number | null; message: string | null }
    | undefined;
  return row ?? null;
}

export function latestRewrap(db: Database.Database): { label: string; status: "done" | "failed"; message: string | null } | null {
  const row = db
    .prepare(`SELECT label, status, message FROM rewrap_jobs WHERE status IN ('done', 'failed') ORDER BY finished_at DESC, id DESC LIMIT 1`)
    .get() as { label: string; status: string; message: string | null } | undefined;
  if (!row || (row.status !== "done" && row.status !== "failed")) return null;
  return { label: row.label, status: row.status, message: row.message };
}

function mapView(row: JobRow): RewrapJobView {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    status: row.status as RewrapJobStatus,
    message: row.message,
    progress: row.progress,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function listRewrapJobs(
  db: Database.Database,
  query: { status?: RewrapJobStatus | null; page: number; pageSize: number },
): { jobs: RewrapJobView[]; total: number } {
  const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize) || 50));
  const page = Math.max(1, Math.trunc(query.page) || 1);
  const offset = (page - 1) * pageSize;
  if (!query.status) {
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM rewrap_jobs`).get() as { count: number }).count;
    const rows = db
      .prepare(
        `SELECT * FROM rewrap_jobs
         ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
           COALESCE(finished_at, started_at, created_at) DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(pageSize, offset) as JobRow[];
    return { jobs: rows.map(mapView), total };
  }
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM rewrap_jobs WHERE status = ?`).get(query.status) as { count: number }).count;
  const sql =
    query.status === "pending"
      ? `SELECT * FROM rewrap_jobs WHERE status = ? ORDER BY immediate DESC, id ASC LIMIT ? OFFSET ?`
      : `SELECT * FROM rewrap_jobs WHERE status = ? ORDER BY COALESCE(finished_at, started_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(query.status, pageSize, offset) as JobRow[];
  return { jobs: rows.map(mapView), total };
}
