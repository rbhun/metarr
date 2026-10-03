import path from "node:path";
import type Database from "better-sqlite3";

export type MergeSettings = {
  /** When off, the Merge page stays hidden and new jobs are refused. Manual only — never scheduled. */
  enabled: boolean;
};

export type MergeItem = {
  leftPath: string;
  rightPath: string;
  videoPath: string;
  label?: string;
  skipFrameCheck?: boolean;
};

export type MergeJob = {
  id: number;
  leftPath: string;
  rightPath: string;
  videoPath: string;
  label: string;
  skipFrameCheck: boolean;
};

export type MergeJobStatus = "pending" | "running" | "done" | "failed";

export type MergeJobView = {
  id: number;
  leftPath: string;
  rightPath: string;
  videoPath: string;
  label: string;
  status: MergeJobStatus;
  message: string | null;
  progress: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type MergeTotals = { pending: number; running: number; done: number; failed: number };

export type MergePause = "plex" | "detect" | "remux" | "rewrap" | "off";

type JobRow = {
  id: number;
  left_path: string;
  right_path: string;
  video_path: string;
  label: string;
  skip_frame_check: number;
  status: string;
  message: string | null;
  progress: number | null;
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

export function readMergeSettings(db: Database.Database): MergeSettings {
  // Beta default: on, so the page is reachable without a trip through Settings first.
  return { enabled: meta(db, "merge_enabled") !== "0" };
}

export function writeMergeSettings(db: Database.Database, settings: { enabled?: boolean }) {
  if (settings.enabled != null) setMetaValue(db, "merge_enabled", settings.enabled ? "1" : "0");
}

export function readMergePause(db: Database.Database): MergePause | null {
  const value = meta(db, "merge_pause");
  if (value === "plex" || value === "detect" || value === "remux" || value === "rewrap" || value === "off") return value;
  return null;
}

export function writeMergePause(db: Database.Database, pause: MergePause | null) {
  if (!pause) {
    db.prepare(`DELETE FROM app_meta WHERE key = ?`).run("merge_pause");
    return;
  }
  setMetaValue(db, "merge_pause", pause);
}

export type MergeEnqueueResult = { added: number; already: number };

function pairKey(left: string, right: string): string {
  return [left, right].sort().join("\0");
}

export function enqueueMerges(db: Database.Database, items: MergeItem[]): MergeEnqueueResult {
  const existing = db.prepare(
    `SELECT status FROM merge_jobs
     WHERE status IN ('pending', 'running')
       AND ((left_path = ? AND right_path = ?) OR (left_path = ? AND right_path = ?))
     ORDER BY id LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO merge_jobs (left_path, right_path, video_path, label, skip_frame_check, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  );
  const now = new Date().toISOString();
  let added = 0;
  let already = 0;
  const seen = new Set<string>();
  const write = db.transaction(() => {
    for (const item of items) {
      const leftPath = item.leftPath.trim();
      const rightPath = item.rightPath.trim();
      const videoPath = item.videoPath.trim();
      if (!leftPath || !rightPath || !videoPath || leftPath === rightPath) continue;
      if (videoPath !== leftPath && videoPath !== rightPath) continue;
      const key = pairKey(leftPath, rightPath);
      if (seen.has(key)) {
        already += 1;
        continue;
      }
      seen.add(key);
      const row = existing.get(leftPath, rightPath, rightPath, leftPath) as { status: string } | undefined;
      if (row) {
        already += 1;
        continue;
      }
      const label = item.label?.trim() || path.basename(videoPath) || videoPath;
      insert.run(leftPath, rightPath, videoPath, label, item.skipFrameCheck ? 1 : 0, now);
      added += 1;
    }
  });
  write();
  return { added, already };
}

export function claimNextMerge(db: Database.Database): MergeJob | null {
  const row = db.prepare(`SELECT * FROM merge_jobs WHERE status = 'pending' ORDER BY id LIMIT 1`).get() as JobRow | undefined;
  if (!row) return null;
  const changed = db
    .prepare(`UPDATE merge_jobs SET status = 'running', started_at = ?, message = 'Waiting to start', progress = 0 WHERE id = ? AND status = 'pending'`)
    .run(new Date().toISOString(), row.id);
  if (changed.changes !== 1) return null;
  return {
    id: row.id,
    leftPath: row.left_path,
    rightPath: row.right_path,
    videoPath: row.video_path,
    label: row.label,
    skipFrameCheck: row.skip_frame_check === 1,
  };
}

export function updateMergeProgress(db: Database.Database, id: number, progress: number, message: string) {
  db.prepare(`UPDATE merge_jobs SET progress = ?, message = ? WHERE id = ? AND status = 'running'`).run(progress, message.slice(0, 500), id);
}

export function finishMerge(db: Database.Database, id: number, status: "done" | "failed", message: string | null) {
  const text =
    message && message.trim() ? message.trim().slice(0, 1000) : status === "failed" ? "Version merge failed with no further detail from ffmpeg." : null;
  db.prepare(`UPDATE merge_jobs SET status = ?, message = ?, progress = NULL, finished_at = ? WHERE id = ?`).run(status, text, new Date().toISOString(), id);
}

export function retryFailedMerge(db: Database.Database, id: number): "retried" | "missing" | "already" {
  const row = db.prepare(`SELECT left_path, right_path, status FROM merge_jobs WHERE id = ?`).get(id) as
    | { left_path: string; right_path: string; status: string }
    | undefined;
  if (!row || row.status !== "failed") return "missing";
  const busy = db
    .prepare(
      `SELECT 1 AS ok FROM merge_jobs
       WHERE status IN ('pending', 'running') AND id != ?
         AND ((left_path = ? AND right_path = ?) OR (left_path = ? AND right_path = ?))`,
    )
    .get(id, row.left_path, row.right_path, row.right_path, row.left_path);
  if (busy) {
    db.prepare(`DELETE FROM merge_jobs WHERE id = ? AND status = 'failed'`).run(id);
    return "already";
  }
  const changed = db
    .prepare(`UPDATE merge_jobs SET status = 'pending', message = NULL, progress = NULL, started_at = NULL, finished_at = NULL WHERE id = ? AND status = 'failed'`)
    .run(id);
  return changed.changes === 1 ? "retried" : "missing";
}

export function retryAllFailedMerge(db: Database.Database): number {
  return db.transaction(() => {
    db.prepare(
      `DELETE FROM merge_jobs
       WHERE status = 'failed'
         AND EXISTS (
           SELECT 1 FROM merge_jobs AS other
           WHERE other.status IN ('pending', 'running')
             AND ((other.left_path = merge_jobs.left_path AND other.right_path = merge_jobs.right_path)
               OR (other.left_path = merge_jobs.right_path AND other.right_path = merge_jobs.left_path))
         )`,
    ).run();
    return db
      .prepare(
        `UPDATE merge_jobs
         SET status = 'pending', message = NULL, progress = NULL, started_at = NULL, finished_at = NULL
         WHERE id IN (
           SELECT MAX(id) FROM merge_jobs WHERE status = 'failed'
           GROUP BY CASE WHEN left_path < right_path THEN left_path || char(0) || right_path ELSE right_path || char(0) || left_path END
         )
           AND NOT EXISTS (
             SELECT 1 FROM merge_jobs AS other
             WHERE other.status IN ('pending', 'running', 'done')
               AND ((other.left_path = merge_jobs.left_path AND other.right_path = merge_jobs.right_path)
                 OR (other.left_path = merge_jobs.right_path AND other.right_path = merge_jobs.left_path))
           )`,
      )
      .run().changes;
  })();
}

export function releaseRunningMerge(db: Database.Database) {
  db.prepare(`UPDATE merge_jobs SET status = 'pending', started_at = NULL, progress = NULL WHERE status = 'running'`).run();
}

export function mergeIsRunning(db: Database.Database): boolean {
  return Boolean(db.prepare(`SELECT 1 AS ok FROM merge_jobs WHERE status = 'running' LIMIT 1`).get());
}

export function mergeTotals(db: Database.Database): MergeTotals {
  const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM merge_jobs GROUP BY status`).all() as Array<{ status: string; count: number }>;
  const totals = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in totals) totals[row.status as keyof typeof totals] = row.count;
  }
  return totals;
}

export function clearMergeJobs(db: Database.Database, status: MergeJobStatus): number {
  return db.prepare(`DELETE FROM merge_jobs WHERE status = ?`).run(status).changes;
}

export function activeMerge(db: Database.Database): { label: string; progress: number | null; message: string | null } | null {
  const row = db.prepare(`SELECT label, progress, message FROM merge_jobs WHERE status = 'running' ORDER BY id LIMIT 1`).get() as
    | { label: string; progress: number | null; message: string | null }
    | undefined;
  return row ?? null;
}

export function latestMerge(db: Database.Database): { label: string; status: "done" | "failed"; message: string | null } | null {
  const row = db
    .prepare(`SELECT label, status, message FROM merge_jobs WHERE status IN ('done', 'failed') ORDER BY finished_at DESC, id DESC LIMIT 1`)
    .get() as { label: string; status: string; message: string | null } | undefined;
  if (!row || (row.status !== "done" && row.status !== "failed")) return null;
  return { label: row.label, status: row.status, message: row.message };
}

function mapView(row: JobRow): MergeJobView {
  return {
    id: row.id,
    leftPath: row.left_path,
    rightPath: row.right_path,
    videoPath: row.video_path,
    label: row.label,
    status: row.status as MergeJobStatus,
    message: row.message,
    progress: row.progress,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function listMergeJobs(
  db: Database.Database,
  query: { status?: MergeJobStatus | null; page: number; pageSize: number },
): { jobs: MergeJobView[]; total: number } {
  const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize) || 50));
  const page = Math.max(1, Math.trunc(query.page) || 1);
  const offset = (page - 1) * pageSize;
  if (!query.status) {
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM merge_jobs`).get() as { count: number }).count;
    const rows = db
      .prepare(
        `SELECT * FROM merge_jobs
         ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
           COALESCE(finished_at, started_at, created_at) DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(pageSize, offset) as JobRow[];
    return { jobs: rows.map(mapView), total };
  }
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM merge_jobs WHERE status = ?`).get(query.status) as { count: number }).count;
  const sql =
    query.status === "pending"
      ? `SELECT * FROM merge_jobs WHERE status = ? ORDER BY id ASC LIMIT ? OFFSET ?`
      : `SELECT * FROM merge_jobs WHERE status = ? ORDER BY COALESCE(finished_at, started_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(query.status, pageSize, offset) as JobRow[];
  return { jobs: rows.map(mapView), total };
}
