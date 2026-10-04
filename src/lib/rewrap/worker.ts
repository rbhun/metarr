import fs from "node:fs";
import path from "node:path";
import { announceFolder } from "@/lib/announce";
import { getDb } from "@/lib/db";
import { pathOnPlex, resolveMediaPath } from "@/lib/detect/paths";
import { plexLibraryBusy } from "@/lib/detect/plex";
import { inDetectWindow } from "@/lib/detect/schedule";
import { detectCounts, readDetectSettings } from "@/lib/detect/store";
import { dryRun } from "@/lib/dry-run";
import { assertWritableDiscFolder, discFolderProblem, friendlyFsError } from "@/lib/remux/access";
import { remuxIsRunning } from "@/lib/remux/store";
import { mergeIsRunning } from "@/lib/merge/store";
import { libraryAvis } from "@/lib/rewrap/candidates";
import { rewrapAvi } from "@/lib/rewrap/run";
import { canRewrap, joinedTarget, sourceKind, splitSources } from "@/lib/rewrap/source";
import {
  claimNextRewrap,
  finishRewrap,
  hasImmediateRewrap,
  readRewrapSettings,
  releaseRunningRewrap,
  rewrapTotals,
  settleSplitRewraps,
  updateRewrapProgress,
  writeRewrapPause,
} from "@/lib/rewrap/store";
import { scratchRoot } from "@/lib/scratch";
import { startSync } from "@/lib/sync";

const SYNC_AFTER_MS = 2 * 60 * 1000;

/** Parts beside this file when the folder can be read. */
function splitSourcesOnDisk(filePath: string): string[] | null {
  return splitSources(filePath, (directory) => {
    if (!directory) return null;
    try {
      if (!fs.statSync(directory).isDirectory()) return null;
      return fs.readdirSync(directory);
    } catch {
      return null;
    }
  });
}

const globalForRewrap = globalThis as {
  __metarrRewrap?: { timer: NodeJS.Timeout | null; working: boolean; syncTimer: NodeJS.Timeout | null };
};

function state() {
  if (!globalForRewrap.__metarrRewrap) globalForRewrap.__metarrRewrap = { timer: null, working: false, syncTimer: null };
  return globalForRewrap.__metarrRewrap;
}

function syncSoon(delay = SYNC_AFTER_MS) {
  const current = state();
  if (current.syncTimer) clearTimeout(current.syncTimer);
  current.syncTimer = setTimeout(() => {
    current.syncTimer = null;
    if (!startSync().started) syncSoon(60_000);
  }, delay);
}

export function rewrapWorkDirectory(databasePath: string, jobId: number): string {
  return path.join(scratchRoot(databasePath), "rewrap-work", `job-${jobId}`);
}

function sourceText(message: string, kind: string): string {
  return message.replace(/next to the disc|beside the disc/g, `next to the ${kind}`);
}

/** Languages recognized after the job was queued are written too. */
function currentLanguages(db: ReturnType<typeof getDb>, filePath: string): { languages: Array<string | null>; subtitleLanguages: Array<string | null> } | null {
  try {
    const item = libraryAvis(db).get(filePath);
    return item ? { languages: item.languages ?? [], subtitleLanguages: item.subtitleLanguages ?? [] } : null;
  } catch {
    return null;
  }
}

function existsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** The copy is about as large as the sources, in scratch and then in the movie folder. */
function roomFor(bytes: number, directories: string[]): boolean {
  try {
    const needed = bytes + 512 * 1024 * 1024;
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
  return rewrapTotals(db).pending > 0;
}

async function step() {
  const db = getDb();
  const settings = readRewrapSettings(db);
  const urgent = hasImmediateRewrap(db);
  if (!urgent) {
    if (!settings.enabled) {
      writeRewrapPause(db, waiting(db) ? "off" : null);
      return;
    }
    if (!inDetectWindow(new Date().getHours(), settings.startHour, settings.endHour)) {
      writeRewrapPause(db, waiting(db) ? "window" : null);
      return;
    }
    if (!waiting(db)) {
      writeRewrapPause(db, null);
      return;
    }
    if (remuxIsRunning(db)) {
      writeRewrapPause(db, "remux");
      return;
    }
    if (mergeIsRunning(db)) {
      writeRewrapPause(db, "merge");
      return;
    }
    if (await plexLibraryBusy(db)) {
      writeRewrapPause(db, "plex");
      return;
    }
    if (detectCounts(db).running > 0) {
      writeRewrapPause(db, "detect");
      return;
    }
  }
  const job = claimNextRewrap(db, urgent);
  if (!job) {
    writeRewrapPause(db, null);
    return;
  }
  writeRewrapPause(db, null);
  const workDir = rewrapWorkDirectory(db.name, job.id);
  try {
    const local = resolveMediaPath(job.path, readDetectSettings(db).pathMaps, existsFile);
    if (!local) {
      finishRewrap(db, job.id, "failed", `Cannot open ${job.path}. Add a path mapping in Settings if Plex uses a different path.`);
      return;
    }
    const sources = splitSourcesOnDisk(local) ?? [local];
    if (!canRewrap(null, local) && sources.length < 2) {
      finishRewrap(db, job.id, "failed", "This file is not an AVI or a loose M2TS or TS file, and it is not a complete multi-part film.");
      return;
    }
    const kind = sourceKind(local);
    const known = currentLanguages(db, job.path);
    const directory = path.dirname(local);
    const rehearsal = dryRun();
    const outputDir = sources.length > 1 ? path.dirname(joinedTarget(local) ?? local) : directory;
    if (rehearsal) {
      const problem = discFolderProblem(outputDir);
      if (problem) {
        finishRewrap(db, job.id, "failed", `Dry run: ${sourceText(problem, kind)}`);
        return;
      }
    } else {
      assertWritableDiscFolder(outputDir);
      let bytes = 0;
      try {
        for (const file of sources) bytes += fs.statSync(file).size;
      } catch {
        bytes = 0;
      }
      if (bytes > 0 && !roomFor(bytes, [path.dirname(workDir), outputDir])) {
        const space = sources.length > 1 ? "to join these parts" : `for a copy of this ${kind}`;
        finishRewrap(db, job.id, "failed", `There is not enough free space ${space}, so nothing was written.`);
        return;
      }
    }
    const message = await rewrapAvi({
      source: local,
      sources,
      workDir,
      languages: known?.languages ?? job.languages,
      subtitleLanguages: known?.subtitleLanguages ?? job.subtitleLanguages,
      firstLanguage: settings.firstLanguage,
      dryRun: rehearsal,
      onProgress: (percent, text) => updateRewrapProgress(db, job.id, percent, text),
    });
    if (!rehearsal && sources.length > 1) {
      const maps = readDetectSettings(db).pathMaps;
      const partners = new Set<string>(sources);
      for (const file of sources) partners.add(pathOnPlex(file, maps));
      for (const [libraryPath] of libraryAvis(db)) {
        const resolved = resolveMediaPath(libraryPath, maps, existsFile);
        if (resolved && sources.some((file) => file.toLowerCase() === resolved.toLowerCase())) partners.add(libraryPath);
      }
      settleSplitRewraps(db, [...partners], message, job.id);
    }
    let told = "";
    if (!rehearsal) {
      try {
        told = await announceFolder(db, [path.dirname(job.path), directory, outputDir]);
      } catch {
        told = "Plex and the *arr apps could not be asked to rescan.";
      }
    }
    finishRewrap(db, job.id, "done", [message, told].filter(Boolean).join(" "));
    if (!rehearsal) syncSoon();
  } catch (caught) {
    fs.rmSync(workDir, { recursive: true, force: true });
    finishRewrap(db, job.id, "failed", sourceText(friendlyFsError(caught, "Rewrap failed."), sourceKind(job.path)));
  }
}

async function loop() {
  const current = state();
  if (current.working) return;
  current.working = true;
  try {
    await step();
  } catch (caught) {
    console.error("Rewrap stopped on one item.", caught);
  } finally {
    current.working = false;
  }
  current.timer = setTimeout(() => {
    void loop();
  }, 15_000);
}

export function startRewrapWorker() {
  const current = state();
  if (current.timer) return;
  releaseRunningRewrap(getDb());
  current.timer = setTimeout(() => {
    void loop();
  }, 1_000);
}

export function kickRewrapWorker() {
  startRewrapWorker();
  const current = state();
  if (current.working) return;
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    void loop();
  }, 50);
}
