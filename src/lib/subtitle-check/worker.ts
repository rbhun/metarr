import path from "node:path";
import type Database from "better-sqlite3";
import { applyTimeZone } from "@/lib/clock";
import { getDb, parseVersions } from "@/lib/db";
import { resolveMediaPath } from "@/lib/detect/paths";
import { plexIsBusy } from "@/lib/detect/plex";
import { inDetectWindow, windowKey } from "@/lib/detect/schedule";
import { readDetectSettings } from "@/lib/detect/store";
import { mergeIsRunning } from "@/lib/merge/store";
import { remuxIsRunning } from "@/lib/remux/store";
import { rewrapIsRunning } from "@/lib/rewrap/store";
import {
  pruneTimingChecks,
  readTimingCheck,
  readTimingProgress,
  readTimingSettings,
  readTimingWindow,
  requestTimingPass,
  touchTimingCheck,
  writeTimingProgress,
  writeTimingWindow,
  type TimingPause,
} from "@/lib/subtitle-check/store";
import {
  checkIsCurrent,
  existingFile,
  inspectFile,
  recordInspection,
  retimeFile,
  tellApps,
  textSidecars,
  videoLength,
  type Video,
} from "@/lib/subtitle-fix";
import { isClearFix, presetScale } from "@/lib/subtitle-timing";

export type StoredVideo = { stored: string; runtimeMinutes: number | null };

type Pass = { id: string; queue: StoredVideo[]; total: number; startedAt: string; requested: boolean };

const globalForTiming = globalThis as { __metarrTiming?: { timer: NodeJS.Timeout | null; working: boolean; pass: Pass | null } };

function state() {
  if (!globalForTiming.__metarrTiming) globalForTiming.__metarrTiming = { timer: null, working: false, pass: null };
  return globalForTiming.__metarrTiming;
}

/** Every movie and episode file in the library, once each. */
export function libraryVideos(db: Database.Database): StoredVideo[] {
  const rows = [
    ...(db.prepare(`SELECT path, versions_json, runtime_minutes FROM catalog_titles WHERE kind = 'movie'`).all() as Row[]),
    ...(db.prepare(`SELECT path, versions_json, runtime_minutes FROM catalog_episodes`).all() as Row[]),
  ];
  const seen = new Set<string>();
  const videos: StoredVideo[] = [];
  for (const row of rows) {
    const versions = parseVersions(row.versions_json);
    const entries = versions.length
      ? versions.map((version) => ({ path: version.path, minutes: version.durationMinutes ?? row.runtime_minutes }))
      : [{ path: row.path, minutes: row.runtime_minutes }];
    for (const entry of entries) {
      if (!entry.path || seen.has(entry.path)) continue;
      seen.add(entry.path);
      videos.push({ stored: entry.path, runtimeMinutes: entry.minutes ?? null });
    }
  }
  return videos;
}

type Row = { path: string | null; versions_json: string | null; runtime_minutes: number | null };

function progress(db: Database.Database, pass: Pass | null, pause: TimingPause, finishedAt: string | null = null) {
  const previous = readTimingProgress(db);
  writeTimingProgress(db, {
    running: pass != null,
    pause,
    done: pass ? pass.total - pass.queue.length : previous.done,
    total: pass ? pass.total : previous.total,
    startedAt: pass ? pass.startedAt : previous.startedAt,
    finishedAt: finishedAt ?? previous.finishedAt,
  });
}

/** Check one video's subtitle files, and fix the clear cases when that is switched on. */
export async function checkVideo(db: Database.Database, item: StoredVideo, passId: string, autoFix: boolean): Promise<void> {
  const maps = readDetectSettings(db).pathMaps;
  const local = resolveMediaPath(item.stored, maps, existingFile);
  if (!local) return;
  const video: Video = { stored: item.stored, local, runtimeMinutes: item.runtimeMinutes };
  const files = textSidecars(video).filter(existingFile);
  let length: Awaited<ReturnType<typeof videoLength>> | null = null;
  let fixed = false;
  for (const file of files) {
    const name = path.relative(path.dirname(video.local), file);
    const stored = readTimingCheck(db, video.stored, name);
    const fixable = autoFix && stored?.status === "longer" && stored.preset != null && !stored.retimed;
    if (!fixable && checkIsCurrent(db, video, file)) {
      touchTimingCheck(db, video.stored, name, passId);
      continue;
    }
    length ??= await videoLength(video);
    let row = inspectFile(file, video, length);
    let autoFixedAt: string | null = null;
    const scale = presetScale(row.preset);
    const clear =
      autoFix &&
      scale != null &&
      isClearFix({
        status: row.status,
        preset: row.preset,
        lastEnd: row.lastEnd,
        videoSeconds: row.videoSeconds,
        fps: row.fps,
        measured: row.videoSource === "probe",
        retimed: row.hasOriginal,
      });
    if (clear && scale != null) {
      try {
        const result = retimeFile(file, { scale, offset: 0 });
        if (result.written) {
          autoFixedAt = new Date().toISOString();
          fixed = true;
          row = inspectFile(file, video, length);
          row = { ...row, message: `Fixed automatically: ${result.message} ${row.message}` };
        }
      } catch (caught) {
        const why = caught instanceof Error ? caught.message : "the file could not be written";
        row = { ...row, message: `${row.message} The automatic fix did not work: ${why}` };
      }
    }
    recordInspection(db, video, row, passId, autoFixedAt);
  }
  if (fixed) await tellApps(db, video);
}

async function waitReason(db: Database.Database, pass: Pass): Promise<TimingPause> {
  const detect = readDetectSettings(db);
  if (!pass.requested && !inDetectWindow(new Date().getHours(), detect.startHour, detect.endHour)) return "window";
  if (await plexIsBusy(db)) return "plex";
  if (remuxIsRunning(db) || rewrapIsRunning(db)) return "remux";
  if (mergeIsRunning(db)) return "merge";
  return null;
}

function startPass(db: Database.Database, requested: boolean): Pass {
  const queue = libraryVideos(db);
  const pass = { id: `pass-${Date.now()}`, queue, total: queue.length, startedAt: new Date().toISOString(), requested };
  state().pass = pass;
  return pass;
}

async function step(): Promise<boolean> {
  const db = getDb();
  applyTimeZone(db);
  const settings = readTimingSettings(db);
  const current = state();
  if (!settings.enabled) {
    current.pass = null;
    requestTimingPass(db, false);
    progress(db, null, "off");
    return false;
  }
  const requested = readTimingProgress(db).requested;
  let pass = current.pass;
  if (pass && requested && !pass.requested) pass.requested = true;
  if (!pass) {
    const detect = readDetectSettings(db);
    const key = windowKey(new Date(), detect.startHour, detect.endHour);
    if (requested) {
      pass = startPass(db, true);
    } else if (key && readTimingWindow(db) !== key) {
      writeTimingWindow(db, key);
      pass = startPass(db, false);
    } else {
      progress(db, null, null);
      return false;
    }
  }
  const pause = await waitReason(db, pass);
  if (pause) {
    progress(db, pass, pause);
    return false;
  }
  const item = pass.queue.shift();
  if (item) {
    try {
      await checkVideo(db, item, pass.id, settings.autoFix);
    } catch (caught) {
      console.error("Subtitle timing check stopped on one video.", caught);
    }
  }
  if (pass.queue.length === 0) {
    pruneTimingChecks(db, pass.id);
    current.pass = null;
    requestTimingPass(db, false);
    progress(db, null, null, new Date().toISOString());
    return false;
  }
  progress(db, pass, null);
  return true;
}

async function loop() {
  const current = state();
  if (current.working) return;
  current.working = true;
  let busy = false;
  try {
    busy = await step();
  } catch (caught) {
    console.error("Subtitle timing check failed.", caught);
  } finally {
    current.working = false;
  }
  current.timer = setTimeout(() => {
    void loop();
  }, busy ? 200 : 30_000);
}

export function startTimingWorker() {
  const current = state();
  if (current.timer) return;
  current.timer = setTimeout(() => {
    void loop();
  }, 5_000);
}

export function kickTimingWorker() {
  startTimingWorker();
  const current = state();
  if (current.working) return;
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    void loop();
  }, 50);
}
