import type Database from "better-sqlite3";
import type { PathMap } from "@/lib/detect/paths";
import { parsePathMaps } from "@/lib/detect/paths";
import { clampHour } from "@/lib/detect/schedule";
import type { DetectTarget } from "@/lib/detect/targets";

export type DetectPriority = "immediate" | "window";
export type DetectJobStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type DetectPause = "window" | "plex" | "remux" | "off" | "write";

export type DetectJob = {
  id: number;
  path: string;
  kind: "audio" | "subtitle";
  ordinal: number;
  priority: DetectPriority;
  status: DetectJobStatus;
  label: string;
  format: string | null;
  placement: string | null;
  streamLabel: string | null;
  message: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type DetectSettings = {
  enabled: boolean;
  startHour: number;
  endHour: number;
  pathMaps: PathMap[];
};

type JobRow = {
  id: number;
  path: string;
  kind: string;
  ordinal: number;
  priority: string;
  status: string;
  label: string;
  format: string | null;
  placement: string | null;
  stream_label: string | null;
  message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

function meta(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMetaValue(db: Database.Database, key: string, value: string) {
  db.prepare(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export function readDetectSettings(db: Database.Database): DetectSettings {
  let pathMaps: PathMap[] = [];
  try {
    pathMaps = parsePathMaps(JSON.parse(meta(db, "detect_path_maps") || "[]") as unknown);
  } catch {
    pathMaps = [];
  }
  return {
    enabled: meta(db, "detect_schedule_enabled") === "1",
    startHour: clampHour(meta(db, "detect_schedule_start"), 1),
    endHour: clampHour(meta(db, "detect_schedule_end"), 6),
    pathMaps,
  };
}

export function writeDetectSettings(db: Database.Database, settings: DetectSettings) {
  setMetaValue(db, "detect_schedule_enabled", settings.enabled ? "1" : "0");
  setMetaValue(db, "detect_schedule_start", String(settings.startHour));
  setMetaValue(db, "detect_schedule_end", String(settings.endHour));
  setMetaValue(db, "detect_path_maps", JSON.stringify(settings.pathMaps));
}

export function readDetectPause(db: Database.Database): DetectPause | null {
  const value = meta(db, "detect_pause");
  if (value === "window" || value === "plex" || value === "remux" || value === "off" || value === "write") return value;
  return null;
}

export function writeDetectPause(db: Database.Database, pause: DetectPause | null) {
  if (!pause) {
    db.prepare(`DELETE FROM app_meta WHERE key = ?`).run("detect_pause");
    return;
  }
  setMetaValue(db, "detect_pause", pause);
}

export function readWindowId(db: Database.Database): string | null {
  return meta(db, "detect_window_id");
}

export function writeWindowId(db: Database.Database, id: string) {
  setMetaValue(db, "detect_window_id", id);
}

export function scannedKeys(db: Database.Database): Set<string> {
  const rows = db.prepare(`SELECT path, kind, ordinal FROM detect_results`).all() as Array<{ path: string; kind: string; ordinal: number }>;
  return new Set(rows.map((row) => `${row.path}\0${row.kind}\0${row.ordinal}`));
}

export function enqueueTargets(db: Database.Database, targets: DetectTarget[], priority: DetectPriority): { added: number; already: number } {
  const existing = db.prepare(
    `SELECT id, priority, status FROM detect_jobs WHERE path = ? AND kind = ? AND ordinal = ? AND status IN ('pending', 'running')`,
  );
  const promote = db.prepare(`UPDATE detect_jobs SET priority = 'immediate' WHERE id = ?`);
  const insert = db.prepare(
    `INSERT INTO detect_jobs (
      path, kind, ordinal, priority, status, label, format, placement, stream_label, created_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  let added = 0;
  let already = 0;
  const write = db.transaction(() => {
    for (const target of targets) {
      const row = existing.get(target.path, target.kind, target.ordinal) as { id: number; priority: string; status: string } | undefined;
      if (row) {
        if (priority === "immediate" && row.status === "pending" && row.priority !== "immediate") {
          promote.run(row.id);
          added += 1;
        } else already += 1;
        continue;
      }
      insert.run(target.path, target.kind, target.ordinal, priority, target.label, target.format, target.placement, target.streamLabel, now);
      added += 1;
    }
  });
  write();
  return { added, already };
}

function mapJob(row: JobRow): DetectJob {
  return {
    id: row.id,
    path: row.path,
    kind: row.kind === "subtitle" ? "subtitle" : "audio",
    ordinal: row.ordinal,
    priority: row.priority === "window" ? "window" : "immediate",
    status: row.status as DetectJobStatus,
    label: row.label,
    format: row.format,
    placement: row.placement,
    streamLabel: row.stream_label,
    message: row.message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function claimNextJob(db: Database.Database, allowWindow: boolean): DetectJob | null {
  const row = db
    .prepare(
      `SELECT * FROM detect_jobs
       WHERE status = 'pending' AND (priority = 'immediate' OR (? = 1 AND priority = 'window'))
       ORDER BY CASE priority WHEN 'immediate' THEN 0 ELSE 1 END, id
       LIMIT 1`,
    )
    .get(allowWindow ? 1 : 0) as JobRow | undefined;
  if (!row) return null;
  const now = new Date().toISOString();
  const changed = db
    .prepare(`UPDATE detect_jobs SET status = 'running', started_at = ?, message = NULL WHERE id = ? AND status = 'pending'`)
    .run(now, row.id);
  if (changed.changes !== 1) return null;
  return mapJob({ ...row, status: "running", message: null });
}

export function retryFailedJob(db: Database.Database, id: number): "retried" | "missing" | "already" {
  const row = db.prepare(`SELECT path, kind, ordinal, status FROM detect_jobs WHERE id = ?`).get(id) as
    | { path: string; kind: string; ordinal: number; status: string }
    | undefined;
  if (!row || row.status !== "failed") return "missing";
  const busy = db
    .prepare(`SELECT 1 AS ok FROM detect_jobs WHERE path = ? AND kind = ? AND ordinal = ? AND status IN ('pending', 'running') AND id != ?`)
    .get(row.path, row.kind, row.ordinal, id);
  if (busy) return "already";
  const changed = db
    .prepare(
      `UPDATE detect_jobs
       SET status = 'pending', priority = 'immediate', message = NULL, started_at = NULL, finished_at = NULL
       WHERE id = ? AND status = 'failed'`,
    )
    .run(id);
  return changed.changes === 1 ? "retried" : "missing";
}

/** Put every failed language check back on the overnight queue. */
export function retryAllFailedJobs(db: Database.Database): number {
  return db
    .prepare(
      `UPDATE detect_jobs
       SET status = 'pending', priority = 'window', message = NULL, started_at = NULL, finished_at = NULL
       WHERE status = 'failed'
         AND NOT EXISTS (
           SELECT 1 FROM detect_jobs AS other
           WHERE other.path = detect_jobs.path
             AND other.kind = detect_jobs.kind
             AND other.ordinal = detect_jobs.ordinal
             AND other.status IN ('pending', 'running')
             AND other.id != detect_jobs.id
         )`,
    )
    .run().changes;
}

export function finishJob(db: Database.Database, id: number, status: "done" | "failed" | "skipped", message: string | null) {
  db.prepare(`UPDATE detect_jobs SET status = ?, message = ?, finished_at = ? WHERE id = ?`).run(status, message, new Date().toISOString(), id);
}

export function saveDetection(
  db: Database.Database,
  job: DetectJob,
  result: { language: string | null; role: "commentary" | "forced" | "short" | null; confidence: number; message: string | null; source?: "file" | null },
) {
  db.prepare(
    `INSERT INTO detect_results (path, kind, ordinal, language, role, confidence, message, source, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path, kind, ordinal) DO UPDATE SET
       language = excluded.language,
       role = excluded.role,
       confidence = excluded.confidence,
       message = excluded.message,
       source = excluded.source,
       scanned_at = excluded.scanned_at`,
  ).run(job.path, job.kind, job.ordinal, result.language, result.role, result.confidence, result.message, result.source === "file" ? "file" : null, new Date().toISOString());
}

export function markWritten(db: Database.Database, from: { path: string; kind: string; ordinal: number }, storedPath: string) {
  const now = new Date().toISOString();
  if (from.path !== storedPath) {
    db.prepare(`DELETE FROM detect_results WHERE path = ? AND kind = ? AND ordinal = ?`).run(storedPath, from.kind, from.ordinal);
    db.prepare(`UPDATE detect_results SET path = ?, written_at = ? WHERE path = ? AND kind = ? AND ordinal = ?`).run(storedPath, now, from.path, from.kind, from.ordinal);
    return;
  }
  db.prepare(`UPDATE detect_results SET written_at = ? WHERE path = ? AND kind = ? AND ordinal = ?`).run(now, from.path, from.kind, from.ordinal);
}

export function hasUnwritten(db: Database.Database): boolean {
  const row = db.prepare(`SELECT 1 AS ok FROM detect_results WHERE language IS NOT NULL AND written_at IS NULL LIMIT 1`).get() as { ok: number } | undefined;
  return Boolean(row);
}

/** Recognized earlier, and not yet compared with the language stored in the file. */
export function hasUncheckedTags(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM detect_results
       WHERE language IS NOT NULL AND IFNULL(source, '') != 'file' AND written_at IS NOT NULL AND tag_checked_at IS NULL
       LIMIT 1`,
    )
    .get() as { ok: number } | undefined;
  return Boolean(row);
}

export function markTagChecked(db: Database.Database, row: { path: string; kind: string; ordinal: number }) {
  db.prepare(`UPDATE detect_results SET tag_checked_at = ? WHERE path = ? AND kind = ? AND ordinal = ?`).run(
    new Date().toISOString(),
    row.path,
    row.kind,
    row.ordinal,
  );
}

export function reopenForWrite(db: Database.Database, row: { path: string; kind: string; ordinal: number }) {
  db.prepare(`UPDATE detect_results SET written_at = NULL WHERE path = ? AND kind = ? AND ordinal = ?`).run(row.path, row.kind, row.ordinal);
}

export function releaseRunningJobs(db: Database.Database) {
  db.prepare(`UPDATE detect_jobs SET status = 'failed', message = ?, finished_at = ? WHERE status = 'running'`).run(
    "Stopped because Metarr restarted. On a small machine this usually means it ran out of memory.",
    new Date().toISOString(),
  );
}

export function clearJobs(db: Database.Database, status: DetectJobStatus): number {
  return db.prepare(`DELETE FROM detect_jobs WHERE status = ?`).run(status).changes;
}

export function clearPendingJobs(db: Database.Database): number {
  return clearJobs(db, "pending");
}

export function jobTotals(db: Database.Database): { pending: number; running: number; done: number; failed: number; skipped: number } {
  const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM detect_jobs GROUP BY status`).all() as Array<{ status: string; count: number }>;
  const totals = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    if (row.status in totals) totals[row.status as keyof typeof totals] = row.count;
  }
  return totals;
}

export function detectCounts(db: Database.Database): { immediate: number; window: number; running: number } {
  const rows = db.prepare(`SELECT priority, status, COUNT(*) AS count FROM detect_jobs WHERE status IN ('pending', 'running') GROUP BY priority, status`).all() as Array<{
    priority: string;
    status: string;
    count: number;
  }>;
  const counts = { immediate: 0, window: 0, running: 0 };
  for (const row of rows) {
    if (row.status === "running") counts.running += row.count;
    else if (row.priority === "window") counts.window += row.count;
    else counts.immediate += row.count;
  }
  return counts;
}

export function listJobs(
  db: Database.Database,
  query: { status?: DetectJobStatus | null; page: number; pageSize: number },
): { jobs: DetectJob[]; total: number } {
  const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize) || 50));
  const page = Math.max(1, Math.trunc(query.page) || 1);
  const offset = (page - 1) * pageSize;
  if (!query.status) {
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM detect_jobs`).get() as { count: number }).count;
    const rows = db
      .prepare(
        `SELECT * FROM detect_jobs
         ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,
           COALESCE(finished_at, started_at, created_at) DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(pageSize, offset) as JobRow[];
    return { jobs: rows.map(mapJob), total };
  }
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM detect_jobs WHERE status = ?`).get(query.status) as { count: number }).count;
  const sql =
    query.status === "pending"
      ? `SELECT * FROM detect_jobs WHERE status = ? ORDER BY id ASC LIMIT ? OFFSET ?`
      : `SELECT * FROM detect_jobs WHERE status = ? ORDER BY COALESCE(finished_at, started_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(query.status, pageSize, offset) as JobRow[];
  return { jobs: rows.map(mapJob), total };
}

export function activeJob(db: Database.Database): { label: string; kind: "audio" | "subtitle" } | null {
  const row = db.prepare(`SELECT label, kind FROM detect_jobs WHERE status = 'running' ORDER BY id LIMIT 1`).get() as
    | { label: string; kind: string }
    | undefined;
  if (!row) return null;
  return { label: row.label, kind: row.kind === "subtitle" ? "subtitle" : "audio" };
}

export type StoredDetection = { language: string | null; role: "commentary" | "forced" | "short" | null; source?: "file" | null };

export function detectionMap(db: Database.Database): Map<string, StoredDetection> {
  const rows = db.prepare(`SELECT path, kind, ordinal, language, role, source FROM detect_results`).all() as Array<{
    path: string;
    kind: string;
    ordinal: number;
    language: string | null;
    role: string | null;
    source: string | null;
  }>;
  const map = new Map<string, StoredDetection>();
  for (const row of rows) {
    map.set(`${row.path}\0${row.kind}\0${row.ordinal}`, {
      language: row.language,
      role: row.role === "commentary" || row.role === "forced" || row.role === "short" ? row.role : null,
      source: row.source === "file" ? "file" : null,
    });
  }
  return map;
}
