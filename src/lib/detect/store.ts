import type Database from "better-sqlite3";
import type { PathMap } from "@/lib/detect/paths";
import { parsePathMaps } from "@/lib/detect/paths";
import { clampHour } from "@/lib/detect/schedule";
import type { DetectTarget } from "@/lib/detect/targets";

export type DetectPriority = "immediate" | "window";
export type DetectJobStatus = "pending" | "running" | "done" | "failed" | "skipped";

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
    `SELECT 1 AS ok FROM detect_jobs WHERE path = ? AND kind = ? AND ordinal = ? AND status IN ('pending', 'running')`,
  );
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
      if (existing.get(target.path, target.kind, target.ordinal)) {
        already += 1;
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

export function finishJob(db: Database.Database, id: number, status: "done" | "failed" | "skipped", message: string | null) {
  db.prepare(`UPDATE detect_jobs SET status = ?, message = ?, finished_at = ? WHERE id = ?`).run(status, message, new Date().toISOString(), id);
}

export function saveDetection(
  db: Database.Database,
  job: DetectJob,
  result: { language: string | null; role: "commentary" | null; confidence: number; message: string | null },
) {
  db.prepare(
    `INSERT INTO detect_results (path, kind, ordinal, language, role, confidence, message, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path, kind, ordinal) DO UPDATE SET
       language = excluded.language,
       role = excluded.role,
       confidence = excluded.confidence,
       message = excluded.message,
       scanned_at = excluded.scanned_at`,
  ).run(job.path, job.kind, job.ordinal, result.language, result.role, result.confidence, result.message, new Date().toISOString());
}

export function releaseRunningJobs(db: Database.Database) {
  db.prepare(`UPDATE detect_jobs SET status = 'failed', message = ?, finished_at = ? WHERE status = 'running'`).run(
    "Stopped because Metarr restarted. On a small machine this usually means it ran out of memory.",
    new Date().toISOString(),
  );
}

export function clearPendingJobs(db: Database.Database): number {
  return db.prepare(`DELETE FROM detect_jobs WHERE status = 'pending'`).run().changes;
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

export function listJobs(db: Database.Database): DetectJob[] {
  const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM detect_jobs
       WHERE status = 'running' OR (status IN ('done', 'failed', 'skipped') AND finished_at >= ?)
       ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, finished_at DESC
       LIMIT 40`,
    )
    .all(since) as JobRow[];
  return rows.map(mapJob);
}

export function activeJob(db: Database.Database): { label: string; kind: "audio" | "subtitle" } | null {
  const row = db.prepare(`SELECT label, kind FROM detect_jobs WHERE status = 'running' ORDER BY id LIMIT 1`).get() as
    | { label: string; kind: string }
    | undefined;
  if (!row) return null;
  return { label: row.label, kind: row.kind === "subtitle" ? "subtitle" : "audio" };
}

export type StoredDetection = { language: string | null; role: "commentary" | null };

export function detectionMap(db: Database.Database): Map<string, StoredDetection> {
  const rows = db.prepare(`SELECT path, kind, ordinal, language, role FROM detect_results`).all() as Array<{
    path: string;
    kind: string;
    ordinal: number;
    language: string | null;
    role: string | null;
  }>;
  const map = new Map<string, StoredDetection>();
  for (const row of rows) {
    map.set(`${row.path}\0${row.kind}\0${row.ordinal}`, {
      language: row.language,
      role: row.role === "commentary" ? "commentary" : null,
    });
  }
  return map;
}
