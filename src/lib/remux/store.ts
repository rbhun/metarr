import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ScanFile } from "@/lib/detect/targets";
import { clampHour } from "@/lib/detect/schedule";
import { discsFromFile } from "@/lib/remux/discs";

export const KEEP_ALL_SELECTION = "+sel:all,-sel:mvcvideo";

export type RemuxPause = "window" | "plex" | "detect";

export type RemuxSettings = {
  startHour: number;
  endHour: number;
  binary: string;
  licenseKey: string | null;
};

export type RemuxJob = {
  id: number;
  path: string;
  label: string;
  extras: boolean;
  message: string | null;
  progress: number | null;
};

export type RemuxCounts = { waiting: number; running: number };

type JobRow = {
  id: number;
  path: string;
  label: string;
  extras: number;
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

export function parseBinary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const binary = value.trim();
  if (!binary || binary.length > 300 || /[\0\n\r]/.test(binary)) return null;
  return binary;
}

export function parseLicenseKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.length > 400 || /["\0\n\r]/.test(key)) return null;
  return key;
}

export function readRemuxSettings(db: Database.Database): RemuxSettings {
  return {
    startHour: clampHour(meta(db, "remux_schedule_start"), 1),
    endHour: clampHour(meta(db, "remux_schedule_end"), 7),
    binary: meta(db, "remux_binary") || "makemkvcon",
    licenseKey: meta(db, "remux_license_key"),
  };
}

export function writeRemuxSettings(
  db: Database.Database,
  settings: { startHour: number; endHour: number; binary: string; licenseKey?: string | null; clearKey?: boolean },
) {
  setMetaValue(db, "remux_schedule_start", String(settings.startHour));
  setMetaValue(db, "remux_schedule_end", String(settings.endHour));
  setMetaValue(db, "remux_binary", settings.binary);
  if (settings.licenseKey) setMetaValue(db, "remux_license_key", settings.licenseKey);
  else if (settings.clearKey) {
    db.prepare(`DELETE FROM app_meta WHERE key = ?`).run("remux_license_key");
  }
}

export function readRemuxPause(db: Database.Database): RemuxPause | null {
  const value = meta(db, "remux_pause");
  if (value === "window" || value === "plex" || value === "detect") return value;
  return null;
}

export function writeRemuxPause(db: Database.Database, pause: RemuxPause | null) {
  if (!pause) {
    db.prepare(`DELETE FROM app_meta WHERE key = ?`).run("remux_pause");
    return;
  }
  setMetaValue(db, "remux_pause", pause);
}

export function enqueueDiscs(db: Database.Database, files: ScanFile[], extras: boolean): { added: number; skipped: number; already: number } {
  const existing = db.prepare(`SELECT 1 AS ok FROM remux_jobs WHERE path = ? AND status IN ('pending', 'running')`);
  const insert = db.prepare(
    `INSERT INTO remux_jobs (path, label, extras, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
  );
  const now = new Date().toISOString();
  let added = 0;
  let skipped = 0;
  let already = 0;
  const write = db.transaction(() => {
    for (const file of files) {
      const discs = discsFromFile(file);
      if (discs.length === 0) {
        skipped += 1;
        continue;
      }
      for (const disc of discs) {
        if (existing.get(disc.path)) {
          already += 1;
          continue;
        }
        insert.run(disc.path, disc.label, extras ? 1 : 0, now);
        added += 1;
      }
    }
  });
  write();
  return { added, skipped, already };
}

function mapJob(row: JobRow): RemuxJob {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    extras: row.extras === 1,
    message: row.message,
    progress: row.progress,
  };
}

export function claimNextRemux(db: Database.Database): RemuxJob | null {
  const row = db.prepare(`SELECT * FROM remux_jobs WHERE status = 'pending' ORDER BY id LIMIT 1`).get() as JobRow | undefined;
  if (!row) return null;
  const changed = db
    .prepare(`UPDATE remux_jobs SET status = 'running', started_at = ?, message = 'Waiting to start', progress = 0 WHERE id = ? AND status = 'pending'`)
    .run(new Date().toISOString(), row.id);
  if (changed.changes !== 1) return null;
  return mapJob({ ...row, status: "running", message: "Waiting to start", progress: 0 });
}

export function updateRemuxProgress(db: Database.Database, id: number, progress: number, message: string) {
  db.prepare(`UPDATE remux_jobs SET progress = ?, message = ? WHERE id = ? AND status = 'running'`).run(progress, message.slice(0, 500), id);
}

export function finishRemux(db: Database.Database, id: number, status: "done" | "failed", message: string | null) {
  db.prepare(`UPDATE remux_jobs SET status = ?, message = ?, progress = NULL, finished_at = ? WHERE id = ?`).run(
    status,
    message ? message.slice(0, 500) : null,
    new Date().toISOString(),
    id,
  );
}

export function releaseRunningRemux(db: Database.Database) {
  db.prepare(`UPDATE remux_jobs SET status = 'pending', started_at = NULL, progress = NULL WHERE status = 'running'`).run();
}

export function remuxCounts(db: Database.Database): RemuxCounts {
  const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM remux_jobs WHERE status IN ('pending', 'running') GROUP BY status`).all() as Array<{
    status: string;
    count: number;
  }>;
  const counts = { waiting: 0, running: 0 };
  for (const row of rows) {
    if (row.status === "running") counts.running += row.count;
    else counts.waiting += row.count;
  }
  return counts;
}

export type RemuxJobStatus = "pending" | "running" | "done" | "failed";

export type RemuxJobView = {
  id: number;
  path: string;
  label: string;
  extras: boolean;
  status: RemuxJobStatus;
  message: string | null;
  progress: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export function remuxTotals(db: Database.Database): { pending: number; running: number; done: number; failed: number } {
  const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM remux_jobs GROUP BY status`).all() as Array<{ status: string; count: number }>;
  const totals = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const row of rows) {
    if (row.status in totals) totals[row.status as keyof typeof totals] = row.count;
  }
  return totals;
}

export function clearPendingRemux(db: Database.Database): number {
  return db.prepare(`DELETE FROM remux_jobs WHERE status = 'pending'`).run().changes;
}

export function listRemuxJobs(
  db: Database.Database,
  query: { status: RemuxJobStatus; page: number; pageSize: number },
): { jobs: RemuxJobView[]; total: number } {
  const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize) || 50));
  const page = Math.max(1, Math.trunc(query.page) || 1);
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM remux_jobs WHERE status = ?`).get(query.status) as { count: number }).count;
  const sql =
    query.status === "pending"
      ? `SELECT * FROM remux_jobs WHERE status = ? ORDER BY id ASC LIMIT ? OFFSET ?`
      : `SELECT * FROM remux_jobs WHERE status = ? ORDER BY COALESCE(finished_at, started_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(query.status, pageSize, (page - 1) * pageSize) as JobRow[];
  return {
    jobs: rows.map((row) => ({
      id: row.id,
      path: row.path,
      label: row.label,
      extras: row.extras === 1,
      status: row.status as RemuxJobStatus,
      message: row.message,
      progress: row.progress,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    })),
    total,
  };
}

export function enqueuePaths(
  db: Database.Database,
  paths: Array<{ path: string; label?: string }>,
  extras: boolean,
): { added: number; skipped: number; already: number } {
  const files: ScanFile[] = paths.map((item) => {
    const filePath = item.path.trim();
    return {
      label: item.label?.trim() || path.basename(filePath) || filePath,
      path: filePath,
      container: path.extname(filePath).replace(/^\./, "") || null,
      playableLabel: "iso",
      audioTracks: [],
      subtitleTracks: [],
      versions: [],
    };
  });
  return enqueueDiscs(db, files, extras);
}

export function remuxIsRunning(db: Database.Database): boolean {
  return Boolean(db.prepare(`SELECT 1 AS ok FROM remux_jobs WHERE status = 'running' LIMIT 1`).get());
}

export function activeRemux(db: Database.Database): { label: string; progress: number | null; message: string | null } | null {
  const row = db.prepare(`SELECT label, progress, message FROM remux_jobs WHERE status = 'running' ORDER BY id LIMIT 1`).get() as
    | { label: string; progress: number | null; message: string | null }
    | undefined;
  return row ?? null;
}

export function latestRemux(db: Database.Database): { label: string; status: "done" | "failed"; message: string | null } | null {
  const row = db.prepare(`SELECT label, status, message FROM remux_jobs WHERE status IN ('done', 'failed') ORDER BY finished_at DESC, id DESC LIMIT 1`).get() as
    | { label: string; status: string; message: string | null }
    | undefined;
  if (!row || (row.status !== "done" && row.status !== "failed")) return null;
  return { label: row.label, status: row.status, message: row.message };
}

/** Private MakeMKV home so the queue keeps every audio and subtitle track. */
export function writeMakeMkvHome(directory: string, licenseKey: string | null): string {
  const configDir = path.join(directory, ".MakeMKV");
  fs.mkdirSync(configDir, { recursive: true });
  const lines = [`app_DefaultSelectionString = "${KEEP_ALL_SELECTION}"`, `app_MinimumTitleLength = "0"`];
  if (licenseKey) lines.push(`app_Key = "${licenseKey}"`);
  fs.writeFileSync(path.join(configDir, "settings.conf"), `${lines.join("\n")}\n`, { mode: 0o600 });
  return directory;
}
