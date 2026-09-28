import fs from "node:fs";
import path from "node:path";
import { detectCounts, readDetectSettings } from "@/lib/detect/store";
import { resolveMediaPath } from "@/lib/detect/paths";
import { plexLibraryBusy } from "@/lib/detect/plex";
import { inDetectWindow } from "@/lib/detect/schedule";
import { announceFolder } from "@/lib/announce";
import { dryRun } from "@/lib/dry-run";
import { assertWritableDiscFolder, discFolderProblem, friendlyFsError, remuxWorkDirectory } from "@/lib/remux/access";
import { safeBaseName } from "@/lib/remux/place";
import { outputDirectory, makemkvSource } from "@/lib/remux/source";
import { ripDisc } from "@/lib/remux/run";
import {
  claimNextRemux,
  finishRemux,
  readRemuxSettings,
  releaseRunningRemux,
  remuxCounts,
  updateRemuxProgress,
  writeMakeMkvHome,
  writeRemuxPause,
} from "@/lib/remux/store";
import { getDb } from "@/lib/db";
import { startSync } from "@/lib/sync";

/** Plex and Radarr/Sonarr rescan the folder first; the library sync then reads the new MKV. */
const SYNC_AFTER_MS = 2 * 60 * 1000;

const globalForRemux = globalThis as {
  __metarrRemux?: { timer: NodeJS.Timeout | null; working: boolean; syncTimer: NodeJS.Timeout | null };
};

function state() {
  if (!globalForRemux.__metarrRemux) globalForRemux.__metarrRemux = { timer: null, working: false, syncTimer: null };
  return globalForRemux.__metarrRemux;
}

/** One library sync shortly after the latest finished remux; retried while another sync is running. */
function syncSoon(delay = SYNC_AFTER_MS) {
  const current = state();
  if (current.syncTimer) clearTimeout(current.syncTimer);
  current.syncTimer = setTimeout(() => {
    current.syncTimer = null;
    if (!startSync().started) syncSoon(60_000);
  }, delay);
}

function existsMedia(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

async function step() {
  const db = getDb();
  const settings = readRemuxSettings(db);
  if (!settings.enabled) {
    writeRemuxPause(db, remuxCounts(db).waiting > 0 ? "off" : null);
    return;
  }
  const open = inDetectWindow(new Date().getHours(), settings.startHour, settings.endHour);
  if (!open) {
    writeRemuxPause(db, remuxCounts(db).waiting > 0 ? "window" : null);
    return;
  }
  if (await plexLibraryBusy(db)) {
    writeRemuxPause(db, "plex");
    return;
  }
  if (detectCounts(db).running > 0) {
    writeRemuxPause(db, "detect");
    return;
  }
  const job = claimNextRemux(db);
  if (!job) {
    writeRemuxPause(db, null);
    return;
  }
  writeRemuxPause(db, null);
  const workDir = { current: "" };
  try {
    const local = resolveMediaPath(job.path, readDetectSettings(db).pathMaps, existsMedia);
    if (!local) {
      finishRemux(db, job.id, "failed", `Cannot open ${job.path}. Add a path mapping in Settings if Plex uses a different path.`);
      return;
    }
    const source = makemkvSource(local);
    const directory = outputDirectory(local);
    if (!source || !directory) {
      finishRemux(db, job.id, "failed", "This path is not a disc image MakeMKV can open.");
      return;
    }
    const rehearsal = dryRun();
    if (rehearsal) {
      const problem = discFolderProblem(directory);
      if (problem) {
        finishRemux(db, job.id, "failed", `Dry run: ${problem}`);
        return;
      }
    } else {
      assertWritableDiscFolder(directory);
    }
    const mainName = `${safeBaseName(job.label)}.mkv`;
    if (fs.existsSync(path.join(directory, mainName))) {
      finishRemux(db, job.id, "failed", `${mainName} already exists next to the disc.`);
      return;
    }
    workDir.current = remuxWorkDirectory(db.name, job.id);
    const home = writeMakeMkvHome(path.join(path.dirname(db.name), "makemkv-home"), settings.licenseKey);
    const message = await ripDisc({
      binary: settings.binary,
      source,
      outputDir: directory,
      workDir: workDir.current,
      label: job.label,
      extras: job.extras,
      home,
      dryRun: rehearsal,
      onProgress: (percent, text) => updateRemuxProgress(db, job.id, percent, text),
    });
    let told = "";
    if (!rehearsal) {
      try {
        told = await announceFolder(db, [outputDirectory(job.path) ?? "", directory]);
      } catch {
        told = "Plex and the *arr apps could not be asked to rescan.";
      }
    }
    finishRemux(db, job.id, "done", [message, told].filter(Boolean).join(" "));
    if (!rehearsal) syncSoon();
  } catch (caught) {
    if (workDir.current) fs.rmSync(workDir.current, { recursive: true, force: true });
    finishRemux(db, job.id, "failed", friendlyFsError(caught, "Remux failed."));
  }
}

async function loop() {
  const current = state();
  if (current.working) return;
  current.working = true;
  try {
    await step();
  } catch (caught) {
    console.error("Disc remux stopped on one item.", caught);
  } finally {
    current.working = false;
  }
  const delay = 15_000;
  current.timer = setTimeout(() => {
    void loop();
  }, delay);
}

export function startRemuxWorker() {
  const current = state();
  if (current.timer) return;
  releaseRunningRemux(getDb());
  current.timer = setTimeout(() => {
    void loop();
  }, 1_000);
}

export function kickRemuxWorker() {
  startRemuxWorker();
  const current = state();
  if (current.working) return;
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    void loop();
  }, 50);
}
