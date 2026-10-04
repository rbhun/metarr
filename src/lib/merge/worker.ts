import fs from "node:fs";
import path from "node:path";
import { announceFolder } from "@/lib/announce";
import { getDb } from "@/lib/db";
import { resolveMediaPath } from "@/lib/detect/paths";
import { plexLibraryBusy } from "@/lib/detect/plex";
import { detectCounts, readDetectSettings } from "@/lib/detect/store";
import { dryRun } from "@/lib/dry-run";
import { mergeVersions } from "@/lib/merge/run";
import {
  claimNextMerge,
  finishMerge,
  mergeTotals,
  readMergeSettings,
  releaseRunningMerge,
  updateMergeProgress,
  writeMergePause,
} from "@/lib/merge/store";
import { assertWritableDiscFolder, discFolderProblem, friendlyFsError } from "@/lib/remux/access";
import { remuxIsRunning } from "@/lib/remux/store";
import { rewrapIsRunning } from "@/lib/rewrap/store";
import { scratchRoot } from "@/lib/scratch";
import { startSync } from "@/lib/sync";

const SYNC_AFTER_MS = 2 * 60 * 1000;

const globalForMerge = globalThis as {
  __metarrMerge?: { timer: NodeJS.Timeout | null; working: boolean; syncTimer: NodeJS.Timeout | null };
};

function state() {
  if (!globalForMerge.__metarrMerge) globalForMerge.__metarrMerge = { timer: null, working: false, syncTimer: null };
  return globalForMerge.__metarrMerge;
}

function syncSoon(delay = SYNC_AFTER_MS) {
  const current = state();
  if (current.syncTimer) clearTimeout(current.syncTimer);
  current.syncTimer = setTimeout(() => {
    current.syncTimer = null;
    if (!startSync().started) syncSoon(60_000);
  }, delay);
}

export function mergeWorkDirectory(databasePath: string, jobId: number): string {
  return path.join(scratchRoot(databasePath), "merge-work", `job-${jobId}`);
}

function existsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function roomFor(files: string[], directories: string[]): boolean {
  try {
    const needed = files.reduce((sum, file) => sum + fs.statSync(file).size, 0) + 512 * 1024 * 1024;
    return directories.every((directory) => {
      fs.mkdirSync(directory, { recursive: true });
      const space = fs.statfsSync(directory);
      return Number(space.bavail) * Number(space.bsize) > needed;
    });
  } catch {
    return true;
  }
}

function waiting(db: ReturnType<typeof getDb>): boolean {
  return mergeTotals(db).pending > 0;
}

async function step() {
  const db = getDb();
  const settings = readMergeSettings(db);
  if (!settings.enabled) {
    writeMergePause(db, waiting(db) ? "off" : null);
    return;
  }
  if (!waiting(db)) {
    writeMergePause(db, null);
    return;
  }
  if (remuxIsRunning(db)) {
    writeMergePause(db, "remux");
    return;
  }
  if (rewrapIsRunning(db)) {
    writeMergePause(db, "rewrap");
    return;
  }
  if (await plexLibraryBusy(db)) {
    writeMergePause(db, "plex");
    return;
  }
  if (detectCounts(db).running > 0) {
    writeMergePause(db, "detect");
    return;
  }
  const job = claimNextMerge(db);
  if (!job) {
    writeMergePause(db, null);
    return;
  }
  writeMergePause(db, null);
  const workDir = mergeWorkDirectory(db.name, job.id);
  try {
    const maps = readDetectSettings(db).pathMaps;
    const left = resolveMediaPath(job.leftPath, maps, existsFile);
    const right = resolveMediaPath(job.rightPath, maps, existsFile);
    if (!left || !right) {
      finishMerge(db, job.id, "failed", `Cannot open both files. Add a path mapping in Settings if Plex uses a different path.`);
      return;
    }
    const videoLocal = job.videoPath === job.leftPath ? left : job.videoPath === job.rightPath ? right : null;
    if (!videoLocal) {
      finishMerge(db, job.id, "failed", "The video source must be one of the two files being merged.");
      return;
    }
    const otherLocal = videoLocal === left ? right : left;
    const directory = path.dirname(videoLocal);
    const rehearsal = dryRun();
    if (rehearsal) {
      const problem = discFolderProblem(directory);
      if (problem) {
        finishMerge(db, job.id, "failed", `Dry run: ${problem}`);
        return;
      }
    } else {
      assertWritableDiscFolder(directory);
      if (!roomFor([left, right], [path.dirname(workDir), directory])) {
        finishMerge(db, job.id, "failed", "There is not enough free space for a combined copy, so nothing was written.");
        return;
      }
    }
    const message = await mergeVersions({
      videoPath: videoLocal,
      otherPath: otherLocal,
      workDir,
      skipFrameCheck: job.skipFrameCheck,
      frameCount: settings.frameSampleCount,
      dryRun: rehearsal,
      onProgress: (percent, text) => updateMergeProgress(db, job.id, percent, text),
    });
    let told = "";
    if (!rehearsal) {
      try {
        told = await announceFolder(db, [path.dirname(job.videoPath), directory]);
      } catch {
        told = "Plex and the *arr apps could not be asked to rescan.";
      }
    }
    finishMerge(db, job.id, "done", [message, told].filter(Boolean).join(" "));
    if (!rehearsal) syncSoon();
  } catch (caught) {
    fs.rmSync(workDir, { recursive: true, force: true });
    finishMerge(db, job.id, "failed", friendlyFsError(caught, "Version merge failed."));
  }
}

async function loop() {
  const current = state();
  if (current.working) return;
  current.working = true;
  try {
    await step();
  } catch (caught) {
    console.error("Version merge stopped on one item.", caught);
  } finally {
    current.working = false;
  }
  current.timer = setTimeout(() => {
    void loop();
  }, 15_000);
}

export function startMergeWorker() {
  const current = state();
  if (current.timer) return;
  releaseRunningMerge(getDb());
  current.timer = setTimeout(() => {
    void loop();
  }, 1_000);
}

export function kickMergeWorker() {
  startMergeWorker();
  const current = state();
  if (current.working) return;
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    void loop();
  }, 50);
}
