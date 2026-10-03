import fs from "node:fs";
import path from "node:path";
import { applyTimeZone } from "@/lib/clock";
import { applyNextSaved, confirmNextSaved, writeFinding } from "@/lib/detect/apply";
import { hasFormatRefresh, refreshNextFormat } from "@/lib/detect/format-refresh";
import { filesForLibrary } from "@/lib/detect/files";
import { listSiblingSubtitles, mediaPathCandidates, resolveMediaPath, siblingSubtitlePath, unresolvedMediaMessage } from "@/lib/detect/paths";
import { plexIsBusy } from "@/lib/detect/plex";
import { notifyPlayers } from "@/lib/detect/publish";
import { detectTrack } from "@/lib/detect/run";
import { inDetectWindow, windowKey } from "@/lib/detect/schedule";
import { languageFromSubtitleName } from "@/lib/detect/sidecars";
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
  writeDetectPause,
  writeWindowId,
} from "@/lib/detect/store";
import { targetsFromFiles } from "@/lib/detect/targets";
import { remuxIsRunning } from "@/lib/remux/store";
import { rewrapIsRunning } from "@/lib/rewrap/store";
import { mergeIsRunning } from "@/lib/merge/store";
import { getDb } from "@/lib/db";

const globalForDetect = globalThis as { __metarrDetect?: { timer: NodeJS.Timeout | null; working: boolean } };

export function finishedStatus(outcome: { language: string | null; message?: string | null }): "done" | "failed" | "skipped" {
  if (outcome.language) return "done";
  if (outcome.message?.startsWith("Plex did not name this subtitle file")) return "skipped";
  return "failed";
}

function state() {
  if (!globalForDetect.__metarrDetect) globalForDetect.__metarrDetect = { timer: null, working: false };
  return globalForDetect.__metarrDetect;
}

async function runFollowUps(db: ReturnType<typeof getDb>, pathMaps: ReturnType<typeof readDetectSettings>["pathMaps"]): Promise<boolean> {
  if (await applyNextSaved(db, pathMaps)) return true;
  if (await confirmNextSaved(db, pathMaps)) return true;
  if (await refreshNextFormat(db)) return true;
  return false;
}

async function step() {
  const db = getDb();
  applyTimeZone(db);
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
  const urgent = counts.immediate > 0;
  /** Overnight (and click-now) checks must not wait behind a backlog of file tag writes. */
  const detectReady = urgent || (settings.enabled && open && counts.window > 0);

  if (!urgent) {
    if (!settings.enabled) {
      writeDetectPause(db, counts.window > 0 ? "off" : null);
      if (!detectReady) {
        if (await runFollowUps(db, settings.pathMaps)) {
          if (counts.window > 0) writeDetectPause(db, "off");
          return;
        }
        return;
      }
    } else if (!open) {
      writeDetectPause(db, counts.window > 0 ? "window" : null);
      if (await runFollowUps(db, settings.pathMaps)) {
        if (counts.window > 0) writeDetectPause(db, "window");
        return;
      }
      return;
    } else if (await plexIsBusy(db)) {
      writeDetectPause(db, "plex");
      return;
    } else if (remuxIsRunning(db) || rewrapIsRunning(db)) {
      writeDetectPause(db, "remux");
      return;
    } else if (mergeIsRunning(db)) {
      writeDetectPause(db, "merge");
      return;
    } else if (!detectReady) {
      if (await runFollowUps(db, settings.pathMaps)) {
        writeDetectPause(db, "write");
        return;
      }
      writeDetectPause(db, null);
      return;
    }
  }

  const job = claimNextJob(db, Boolean(settings.enabled && open));
  if (!job) {
    if (await runFollowUps(db, settings.pathMaps)) {
      writeDetectPause(db, "write");
      return;
    }
    writeDetectPause(db, null);
    return;
  }
  writeDetectPause(db, null);
  try {
    const exists = (candidate: string) => {
      try {
        return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    };
    let local = resolveMediaPath(job.path, settings.pathMaps, exists);
    if (!local && job.kind === "subtitle" && job.placement === "external") {
      let namedOnly = false;
      for (const candidate of mediaPathCandidates(job.path, settings.pathMaps)) {
        const sibling = siblingSubtitlePath(candidate);
        if (sibling && exists(sibling)) {
          local = sibling;
          break;
        }
        const siblings = listSiblingSubtitles(candidate);
        if (siblings.length > 1 && siblings.every((file) => languageFromSubtitleName(path.basename(file)))) {
          namedOnly = true;
        }
      }
      if (!local && namedOnly) {
        finishJob(db, job.id, "skipped", "The folder already has language-tagged subtitle files for this title.");
        return;
      }
    }
    if (!local) {
      finishJob(db, job.id, "failed", unresolvedMediaMessage(job.path, settings.pathMaps));
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
  const delay = counts.immediate > 0 || counts.window > 0 || counts.running > 0 || hasUnwritten(getDb()) || hasUncheckedTags(getDb()) || hasFormatRefresh(getDb()) ? 1_000 : 15_000;
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
