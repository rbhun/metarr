import fs from "node:fs";
import path from "node:path";
import { announceFolder } from "@/lib/announce";
import { getDb } from "@/lib/db";
import { pathOnPlex, resolveMediaPath } from "@/lib/detect/paths";
import { plexLibraryBusy } from "@/lib/detect/plex";
import { inDetectWindow } from "@/lib/detect/schedule";
import { detectCounts, moveDetections, readDetectSettings } from "@/lib/detect/store";
import { convertDolbyVision } from "@/lib/dovi/run";
import { dryRun } from "@/lib/dry-run";
import { assertWritableDiscFolder, discFolderProblem, friendlyFsError } from "@/lib/remux/access";
import { remuxIsRunning } from "@/lib/remux/store";
import { mergeIsRunning } from "@/lib/merge/store";
import { recognizedAudioLanguages } from "@/lib/detect/plex-copy";
import { libraryAvis } from "@/lib/rewrap/candidates";
import { oldCopiesBeside, removeOldFiles } from "@/lib/rewrap/old-files";
import { framesJumpBack, rewrapAvi, tagMkvLanguages } from "@/lib/rewrap/run";
import { canRewrap, isAvi, joinedTarget, rewrapTarget, sourceKind, splitSources } from "@/lib/rewrap/source";
import {
  claimNextRewrap,
  enqueueRewraps,
  finishRewrap,
  finishedRewrapPaths,
  hasImmediateRewrap,
  readRewrapSettings,
  releaseRunningRewrap,
  rewrapTotals,
  settleSplitRewraps,
  updateRewrapProgress,
  writeRewrapPause,
} from "@/lib/rewrap/store";
import { scratchRoot } from "@/lib/scratch";
import { removeWorkDir, stuckTools } from "@/lib/stuck";
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
  __metarrRewrap?: { timer: NodeJS.Timeout | null; working: boolean; syncTimer: NodeJS.Timeout | null; scanned: boolean };
};

function state() {
  if (!globalForRewrap.__metarrRewrap) globalForRewrap.__metarrRewrap = { timer: null, working: false, syncTimer: null, scanned: false };
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

function mergeLanguages(primary: Array<string | null>, extra: Array<string | null>): Array<string | null> {
  const length = Math.max(primary.length, extra.length);
  return Array.from({ length }, (_, index) => primary[index] || extra[index] || null);
}

/** Languages recognized after the job was queued are written too. A blank catalog track keeps the heard language. */
function currentLanguages(db: ReturnType<typeof getDb>, filePath: string): { languages: Array<string | null>; subtitleLanguages: Array<string | null> } | null {
  const recognized = recognizedAudioLanguages(db, filePath);
  try {
    const item = libraryAvis(db).get(filePath);
    if (!item && recognized.length === 0) return null;
    return {
      languages: mergeLanguages(item?.languages ?? [], recognized),
      subtitleLanguages: item?.subtitleLanguages ?? [],
    };
  } catch {
    return recognized.length ? { languages: recognized, subtitleLanguages: [] } : null;
  }
}

function alreadyKept(file: string): boolean {
  return file.toLowerCase().endsWith(".metarr-orig");
}

/** A probe that cannot be read is left as it is, so a language update still finishes. */
async function pictureJumps(file: string): Promise<boolean> {
  try {
    return await framesJumpBack(file);
  } catch {
    return false;
  }
}

/**
 * Queue finished AVI copies whose picture steps backwards in time. They run in the
 * rewrap hours, and the new MKV replaces the shaky one. A smooth copy is left alone.
 */
export async function queueShakyRewraps(db: ReturnType<typeof getDb>): Promise<number> {
  if (dryRun()) return 0;
  const maps = readDetectSettings(db).pathMaps;
  const items: Array<{ path: string; label: string }> = [];
  for (const filePath of finishedRewrapPaths(db)) {
    if (!isAvi(null, filePath)) continue;
    const mkv = resolveMediaPath(rewrapTarget(filePath), maps, existsFile);
    const source = resolveMediaPath(filePath, maps, existsFile) ?? resolveMediaPath(`${filePath}.metarr-orig`, maps, existsFile);
    if (!mkv || !source || !(await pictureJumps(mkv))) continue;
    items.push({ path: filePath, label: path.basename(filePath) });
  }
  if (!items.length) return 0;
  return enqueueRewraps(db, items).added;
}

/** Keep the original beside the MKV under a name Plex does not play. */
function retireSource(file: string): string {
  const kept = `${file}.metarr-orig`;
  if (!fs.existsSync(file)) return "";
  if (fs.existsSync(kept)) return `The original was already kept as ${path.basename(kept)}.`;
  fs.renameSync(file, kept);
  return `The original was kept as ${path.basename(kept)} so Plex plays the MKV.`;
}

/** The language check stays on the file Plex plays after the original is set aside or removed. */
function keepLogOnCopy(db: ReturnType<typeof getDb>, libraryPath: string, kept: string) {
  if (!kept.startsWith("The original was kept") && !kept.startsWith("The original was already kept") && !kept.startsWith("Removed the original ")) return;
  moveDetections(db, libraryPath, rewrapTarget(libraryPath));
}

/** Delete the original when that setting is on. Otherwise a language copy is renamed so Plex plays the MKV. */
function putOriginalsAway(sources: string[], output: string | null, drop: boolean, rename: boolean): string {
  if (drop) return removeOldFiles(oldCopiesBeside(sources, output, existsFile));
  if (!rename || sources.length !== 1 || alreadyKept(sources[0] ?? "")) return "";
  try {
    return retireSource(sources[0]);
  } catch {
    return "The original could not be moved aside, so Plex will list both files.";
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

/** The picture is written to scratch once as a bare stream, then muxed there with the audio. */
async function convertDovi(db: ReturnType<typeof getDb>, id: number, libraryPath: string, local: string, workDir: string) {
  const directory = path.dirname(local);
  const rehearsal = dryRun();
  if (rehearsal) {
    const problem = discFolderProblem(directory);
    if (problem) {
      finishRewrap(db, id, "failed", `Dry run: ${sourceText(problem, "file")}`);
      return;
    }
  } else {
    assertWritableDiscFolder(directory);
    const bytes = fs.statSync(local).size;
    if (!roomFor(bytes * 2, [path.dirname(workDir)]) || !roomFor(bytes, [directory])) {
      finishRewrap(db, id, "failed", "There is not enough free space for a converted copy of this file, so nothing was written.");
      return;
    }
  }
  const message = await convertDolbyVision({
    source: local,
    workDir,
    dryRun: rehearsal,
    onProgress: (percent, text) => updateRewrapProgress(db, id, percent, text),
  });
  const wrote = !rehearsal && message.startsWith("Saved ");
  let told = "";
  if (wrote) {
    try {
      told = await announceFolder(db, [path.dirname(libraryPath), directory]);
    } catch {
      told = "Plex and the *arr apps could not be asked to rescan.";
    }
  }
  finishRewrap(db, id, "done", [message, told].filter(Boolean).join(" "));
  if (wrote) syncSoon();
}

async function step() {
  if (stuckTools().length) return;
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
    const maps = readDetectSettings(db).pathMaps;
    let local = resolveMediaPath(job.path, maps, existsFile);
    if (!local) {
      const mkv = resolveMediaPath(rewrapTarget(job.path), maps, existsFile);
      const kept = resolveMediaPath(`${job.path}.metarr-orig`, maps, existsFile);
      if (kept && mkv && !dryRun() && (await pictureJumps(mkv))) {
        local = kept;
      } else {
        if (!mkv) {
          finishRewrap(db, job.id, "failed", `Cannot open ${job.path}. Add a path mapping in Settings if Plex uses a different path.`);
          return;
        }
        const known = currentLanguages(db, job.path);
        if (!dryRun()) {
          await tagMkvLanguages(mkv, known?.languages ?? job.languages);
          moveDetections(db, job.path, rewrapTarget(job.path));
        }
        const aside = !dryRun() && settings.deleteOld && kept ? removeOldFiles(oldCopiesBeside([kept], mkv, existsFile)) : "";
        let told = "";
        if (!dryRun()) {
          try {
            told = await announceFolder(db, [path.dirname(job.path), path.dirname(mkv)]);
          } catch {
            told = "Plex and the *arr apps could not be asked to rescan.";
          }
        }
        finishRewrap(db, job.id, "done", [`Updated the languages on ${path.basename(mkv)}.`, aside, told].filter(Boolean).join(" "));
        syncSoon();
        return;
      }
    }
    if (job.mode === "dovi") {
      await convertDovi(db, job.id, job.path, local, workDir);
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
    const languages = known?.languages ?? job.languages;
    const subtitleLanguages = known?.subtitleLanguages ?? job.subtitleLanguages;
    const singleTarget = sources.length === 1 ? rewrapTarget(local) : null;
    let replacePicture = false;
    if (singleTarget && fs.existsSync(singleTarget)) {
      replacePicture = !rehearsal && (await pictureJumps(singleTarget));
      if (!replacePicture) {
        if (!rehearsal) await tagMkvLanguages(singleTarget, languages);
        const kept = putOriginalsAway([local], singleTarget, !rehearsal && settings.deleteOld, !rehearsal && job.replaceSource);
        let told = "";
        if (!rehearsal) {
          try {
            told = await announceFolder(db, [path.dirname(job.path), directory, outputDir]);
          } catch {
            told = "Plex and the *arr apps could not be asked to rescan.";
          }
        }
        keepLogOnCopy(db, job.path, kept);
        finishRewrap(db, job.id, "done", [`Updated the languages on ${path.basename(singleTarget)}.`, kept, told].filter(Boolean).join(" "));
        if (!rehearsal) syncSoon();
        return;
      }
    }
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
      languages,
      subtitleLanguages,
      firstLanguage: settings.firstLanguage,
      dryRun: rehearsal,
      replace: replacePicture,
      onProgress: (percent, text) => updateRewrapProgress(db, job.id, percent, text),
    });
    const output = sources.length > 1 ? (joinedTarget(local) ?? rewrapTarget(local)) : rewrapTarget(local);
    const kept = putOriginalsAway(sources, output, !rehearsal && settings.deleteOld, !rehearsal && job.replaceSource);
    if (!rehearsal && sources.length > 1) {
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
    keepLogOnCopy(db, job.path, kept);
    finishRewrap(db, job.id, "done", [message, kept, told].filter(Boolean).join(" "));
    if (!rehearsal) syncSoon();
  } catch (caught) {
    removeWorkDir(workDir);
    const fallback = job.mode === "dovi" ? "Dolby Vision conversion failed." : "Rewrap failed.";
    finishRewrap(db, job.id, "failed", sourceText(friendlyFsError(caught, fallback), job.mode === "dovi" ? "file" : sourceKind(job.path)));
  }
}

async function loop() {
  const current = state();
  if (current.working) return;
  current.working = true;
  try {
    if (!current.scanned) {
      current.scanned = true;
      try {
        const queued = await queueShakyRewraps(getDb());
        if (queued > 0) console.log(`Queued ${queued} rewrap${queued === 1 ? "" : "s"} whose picture plays out of order.`);
      } catch (caught) {
        console.error("Could not look for rewraps whose picture plays out of order.", caught);
      }
    }
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
