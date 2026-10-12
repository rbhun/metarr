import path from "node:path";
import type Database from "better-sqlite3";
import type { TimingStatus } from "@/lib/subtitle-timing";

export const TIMING_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS subtitle_timing (
    video_path TEXT NOT NULL,
    name TEXT NOT NULL,
    sub_size INTEGER,
    sub_mtime REAL,
    video_size INTEGER,
    status TEXT NOT NULL,
    preset TEXT,
    message TEXT,
    video_seconds REAL,
    fps REAL,
    last_end REAL,
    retimed INTEGER NOT NULL DEFAULT 0,
    auto_fixed_at TEXT,
    checked_at TEXT NOT NULL,
    pass TEXT,
    PRIMARY KEY (video_path, name)
  );
  CREATE INDEX IF NOT EXISTS idx_subtitle_timing_status ON subtitle_timing(status);
`;

export type TimingCheck = {
  /** The video path as the library stores it. */
  videoPath: string;
  /** The subtitle file, relative to the video's folder. */
  name: string;
  subSize: number | null;
  subMtime: number | null;
  videoSize: number | null;
  status: TimingStatus;
  preset: string | null;
  message: string;
  videoSeconds: number | null;
  fps: number | null;
  lastEnd: number | null;
  retimed: boolean;
  autoFixedAt: string | null;
};

export type TrackTiming = { status: TimingStatus; message: string; retimed: boolean; autoFixed: boolean };

type Row = {
  video_path: string;
  name: string;
  sub_size: number | null;
  sub_mtime: number | null;
  video_size: number | null;
  status: string;
  preset: string | null;
  message: string | null;
  video_seconds: number | null;
  fps: number | null;
  last_end: number | null;
  retimed: number;
  auto_fixed_at: string | null;
};

function status(value: string): TimingStatus {
  return value === "fits" || value === "longer" || value === "shorter" ? value : "unknown";
}

function fromRow(row: Row): TimingCheck {
  return {
    videoPath: row.video_path,
    name: row.name,
    subSize: row.sub_size,
    subMtime: row.sub_mtime,
    videoSize: row.video_size,
    status: status(row.status),
    preset: row.preset,
    message: row.message ?? "",
    videoSeconds: row.video_seconds,
    fps: row.fps,
    lastEnd: row.last_end,
    retimed: row.retimed === 1,
    autoFixedAt: row.auto_fixed_at,
  };
}

export function readTimingCheck(db: Database.Database, videoPath: string, name: string): TimingCheck | null {
  const row = db.prepare(`SELECT * FROM subtitle_timing WHERE video_path = ? AND name = ?`).get(videoPath, name) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function saveTimingCheck(db: Database.Database, check: TimingCheck, pass: string | null): void {
  db.prepare(
    `INSERT INTO subtitle_timing (video_path, name, sub_size, sub_mtime, video_size, status, preset, message, video_seconds, fps, last_end, retimed, auto_fixed_at, checked_at, pass)
     VALUES (@videoPath, @name, @subSize, @subMtime, @videoSize, @status, @preset, @message, @videoSeconds, @fps, @lastEnd, @retimed, @autoFixedAt, @checkedAt, @pass)
     ON CONFLICT(video_path, name) DO UPDATE SET
       sub_size = excluded.sub_size, sub_mtime = excluded.sub_mtime, video_size = excluded.video_size, status = excluded.status,
       preset = excluded.preset, message = excluded.message, video_seconds = excluded.video_seconds, fps = excluded.fps,
       last_end = excluded.last_end, retimed = excluded.retimed,
       auto_fixed_at = COALESCE(excluded.auto_fixed_at, subtitle_timing.auto_fixed_at),
       checked_at = excluded.checked_at, pass = COALESCE(excluded.pass, subtitle_timing.pass)`,
  ).run({ ...check, retimed: check.retimed ? 1 : 0, checkedAt: new Date().toISOString(), pass });
}

export function touchTimingCheck(db: Database.Database, videoPath: string, name: string, pass: string): void {
  db.prepare(`UPDATE subtitle_timing SET pass = ? WHERE video_path = ? AND name = ?`).run(pass, videoPath, name);
}

/** After a full pass, a row the pass did not reach is a subtitle or video that is gone. */
export function pruneTimingChecks(db: Database.Database, pass: string): number {
  return db.prepare(`DELETE FROM subtitle_timing WHERE pass IS NULL OR pass != ?`).run(pass).changes;
}

export function timingKey(videoPath: string, subtitleFile: string): string {
  return `${videoPath}\0${path.relative(path.dirname(videoPath), subtitleFile)}`;
}

export function timingMap(db: Database.Database): Map<string, TrackTiming> {
  const rows = db.prepare(`SELECT video_path, name, status, message, retimed, auto_fixed_at FROM subtitle_timing`).all() as Array<
    Pick<Row, "video_path" | "name" | "status" | "message" | "retimed" | "auto_fixed_at">
  >;
  const map = new Map<string, TrackTiming>();
  for (const row of rows) {
    map.set(`${row.video_path}\0${row.name}`, {
      status: status(row.status),
      message: row.message ?? "",
      retimed: row.retimed === 1,
      autoFixed: row.auto_fixed_at != null,
    });
  }
  return map;
}

export type TimingCounts = { checked: number; longer: number; shorter: number; retimed: number; autoFixed: number };

export function timingCounts(db: Database.Database): TimingCounts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS checked,
        SUM(status = 'longer') AS longer,
        SUM(status = 'shorter') AS shorter,
        SUM(retimed = 1) AS retimed,
        SUM(auto_fixed_at IS NOT NULL) AS autoFixed
       FROM subtitle_timing`,
    )
    .get() as Record<keyof TimingCounts, number | null>;
  return {
    checked: row.checked ?? 0,
    longer: row.longer ?? 0,
    shorter: row.shorter ?? 0,
    retimed: row.retimed ?? 0,
    autoFixed: row.autoFixed ?? 0,
  };
}

function meta(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMetaValue(db: Database.Database, key: string, value: string | null): void {
  if (value == null) {
    db.prepare(`DELETE FROM app_meta WHERE key = ?`).run(key);
    return;
  }
  db.prepare(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export type TimingSettings = {
  /** Check every subtitle file during the language detection hours. */
  enabled: boolean;
  /** Apply a frame rate fix without asking when the video's frame rate and length leave no doubt. */
  autoFix: boolean;
};

export function readTimingSettings(db: Database.Database): TimingSettings {
  return {
    enabled: meta(db, "subtitle_timing_enabled") !== "0",
    autoFix: meta(db, "subtitle_timing_autofix") === "1",
  };
}

export function writeTimingSettings(db: Database.Database, settings: TimingSettings): void {
  setMetaValue(db, "subtitle_timing_enabled", settings.enabled ? "1" : "0");
  setMetaValue(db, "subtitle_timing_autofix", settings.autoFix ? "1" : "0");
}

export type TimingPause = "off" | "window" | "plex" | "remux" | "merge" | null;

export type TimingProgress = {
  running: boolean;
  pause: TimingPause;
  done: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  requested: boolean;
};

const PROGRESS_KEY = "subtitle_timing_progress";

export function readTimingProgress(db: Database.Database): TimingProgress {
  const fallback: TimingProgress = { running: false, pause: null, done: 0, total: 0, startedAt: null, finishedAt: null, requested: false };
  try {
    const parsed = JSON.parse(meta(db, PROGRESS_KEY) ?? "null") as Partial<TimingProgress> | null;
    return { ...fallback, ...(parsed ?? {}), requested: meta(db, "subtitle_timing_requested") === "1" };
  } catch {
    return { ...fallback, requested: meta(db, "subtitle_timing_requested") === "1" };
  }
}

export function writeTimingProgress(db: Database.Database, progress: Omit<TimingProgress, "requested">): void {
  setMetaValue(db, PROGRESS_KEY, JSON.stringify(progress));
}

export function requestTimingPass(db: Database.Database, requested: boolean): void {
  setMetaValue(db, "subtitle_timing_requested", requested ? "1" : null);
}

export function readTimingWindow(db: Database.Database): string | null {
  return meta(db, "subtitle_timing_window");
}

export function writeTimingWindow(db: Database.Database, key: string): void {
  setMetaValue(db, "subtitle_timing_window", key);
}
