import fs from "node:fs";
import { applyNextSaved, confirmNextSaved, writeFinding } from "@/lib/detect/apply";
import { hasFormatRefresh, refreshNextFormat } from "@/lib/detect/format-refresh";
import { filesForLibrary } from "@/lib/detect/files";
import { resolveMediaPath } from "@/lib/detect/paths";
import { plexIsBusy } from "@/lib/detect/plex";
import { notifyPlayers } from "@/lib/detect/publish";
import { detectTrack } from "@/lib/detect/run";
import { inDetectWindow, windowKey } from "@/lib/detect/schedule";
import {
  claimNextJob,
  detectCounts,
  enqueueTargets,
  finishJob,
  hasUncheckedTags,
  hasUnwritten,
  markWritten,
  readDetectSettings,
  readWindowId,
  releaseRunningJobs,
  saveDetection,
  scannedKeys,
  writeWindowId,
} from "@/lib/detect/store";
import { targetsFromFiles } from "@/lib/detect/targets";
import { remuxIsRunning } from "@/lib/remux/store";
import { getDb } from "@/lib/db";

const globalForDetect = globalThis as { __metarrDetect?: { timer: NodeJS.Timeout | null; working: boolean } };

export function finishedStatus(outcome: { language: string | null; message?: string | null }): "done" | "failed" {
  return outcome.language ? "done" : "failed";
}

function state() {
  if (!globalForDetect.__metarrDetect) globalForDetect.__metarrDetect = { timer: null, working: false };
  return globalForDetect.__metarrDetect;
}

async function step() {
  const db = getDb();
  const settings = readDetectSettings(db);
  const now = new Date();
  const open = inDetectWindow(now.getHours(), settings.startHour, settings.endHour);
  if (settings.enabled && open) {
    const key = windowKey(now, settings.startHour, settings.endHour);
    if (key && readWindowId(db) !== key) {
      const targets = targetsFromFiles(filesForLibrary(db), false, scannedKeys(db));
      enqueueTargets(db, targets, "window");
      writeWindowId(db, key);
    }
  }
  const counts = detectCounts(db);
  const waiting = counts.immediate > 0 || (open && counts.window > 0);
  if (!waiting && !hasUnwritten(db) && !hasUncheckedTags(db) && !hasFormatRefresh(db)) return;
  if (counts.immediate === 0) {
    if (await plexIsBusy(db)) return;
    if (remuxIsRunning(db)) return;
    if (await applyNextSaved(db, settings.pathMaps)) return;
    if (await confirmNextSaved(db, settings.pathMaps)) return;
    if (await refreshNextFormat(db)) return;
  }
  if (!waiting) return;
  const job = claimNextJob(db, open);
  if (!job) return;
  try {
    const local = resolveMediaPath(job.path, settings.pathMaps, (candidate) => {
      try {
        return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!local) {
      finishJob(db, job.id, "failed", `Cannot open ${job.path}. Add a path mapping in Settings if Plex uses a different path.`);
      return;
    }
    const outcome = await detectTrack(job, local);
    const named = job.placement === "named";
    const finding = named ? { ...outcome, source: null } : outcome;
    let stored = job;
    let note = finding.language ? [finding.language, finding.role].filter(Boolean).join(" ") : finding.message;
    let settled = false;
    if (finding.language && !named) {
      const written = await writeFinding(db, job, local, finding.language, finding.role);
      stored = { ...job, path: written.storedPath };
      settled = written.settled;
      let players = "";
      if (written.changed) {
        try {
          players = await notifyPlayers(db, written.videoPaths, job.kind === "subtitle");
        } catch {
          players = "The players could not be asked to re-read the file.";
        }
      }
      const name =
        finding.role === "commentary"
          ? `${finding.language} commentary.`
          : finding.role === "forced"
            ? `${finding.language} forced.`
            : finding.role === "short"
              ? `${finding.language} short.`
              : `${finding.language}.`;
      note = [name, written.sentence, players].filter(Boolean).join(" ");
    }
    if (named && finding.role !== "short") note = "Already named.";
    saveDetection(db, stored, finding);
    if (settled) markWritten(db, stored, stored.path);
    const status = named && finding.role !== "short" ? "skipped" : finishedStatus(finding);
    finishJob(db, job.id, status, note?.slice(0, 500) ?? null);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Detection failed.";
    finishJob(db, job.id, "failed", message.slice(0, 500));
  }
}

async function loop() {
  const current = state();
  if (current.working) return;
  current.working = true;
  try {
    await step();
  } catch (caught) {
    console.error("Language detection stopped on one item.", caught);
  } finally {
    current.working = false;
  }
  const counts = detectCounts(getDb());
  const delay = counts.immediate > 0 || counts.running > 0 || hasUnwritten(getDb()) || hasUncheckedTags(getDb()) || hasFormatRefresh(getDb()) ? 1_000 : 15_000;
  current.timer = setTimeout(() => {
    void loop();
  }, delay);
}

export function startDetectWorker() {
  const current = state();
  if (current.timer) return;
  releaseRunningJobs(getDb());
  current.timer = setTimeout(() => {
    void loop();
  }, 1_000);
}

export function kickDetectWorker() {
  startDetectWorker();
  const current = state();
  if (current.working) return;
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    void loop();
  }, 50);
}
