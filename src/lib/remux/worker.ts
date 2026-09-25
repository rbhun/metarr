import fs from "node:fs";
import path from "node:path";
import { detectCounts, readDetectSettings } from "@/lib/detect/store";
import { resolveMediaPath } from "@/lib/detect/paths";
import { plexLibraryBusy } from "@/lib/detect/plex";
import { inDetectWindow } from "@/lib/detect/schedule";
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

const globalForRemux = globalThis as { __metarrRemux?: { timer: NodeJS.Timeout | null; working: boolean } };

function state() {
  if (!globalForRemux.__metarrRemux) globalForRemux.__metarrRemux = { timer: null, working: false };
  return globalForRemux.__metarrRemux;
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
    const mainName = `${safeBaseName(job.label)}.mkv`;
    if (fs.existsSync(path.join(directory, mainName))) {
      finishRemux(db, job.id, "failed", `${mainName} already exists next to the disc.`);
      return;
    }
    workDir.current = path.join(directory, `.metarr-remux-${job.id}`);
    const home = writeMakeMkvHome(path.join(path.dirname(db.name), "makemkv-home"), settings.licenseKey);
    const message = await ripDisc({
      binary: settings.binary,
      source,
      outputDir: directory,
      workDir: workDir.current,
      label: job.label,
      extras: job.extras,
      home,
      onProgress: (percent, text) => updateRemuxProgress(db, job.id, percent, text),
    });
    finishRemux(db, job.id, "done", message);
  } catch (caught) {
    if (workDir.current) fs.rmSync(workDir.current, { recursive: true, force: true });
    const message = caught instanceof Error ? caught.message : "Remux failed.";
    finishRemux(db, job.id, "failed", message);
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
