import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { announceFolder } from "@/lib/announce";
import { stampLanguage } from "@/lib/detect/stamp";
import { planTag, retargetPath, type TagPlan } from "@/lib/detect/tag";
import { deliverFile } from "@/lib/deliver";
import { dryRun } from "@/lib/dry-run";
import { idle } from "@/lib/idle";
import { scratchRoot } from "@/lib/scratch";
import { isSubtitleFile } from "@/lib/detect/sidecars";
import { resolveMediaPath, type PathMap } from "@/lib/detect/paths";
import { notifyPlayers } from "@/lib/detect/publish";
import { markWritten } from "@/lib/detect/store";
import { languageName } from "@/lib/media";
import type Database from "better-sqlite3";

export type WriteResult = {
  storedPath: string;
  sentence: string;
  changed: boolean;
  settled: boolean;
  videoPaths: string[];
};

type WriteJob = {
  path: string;
  kind: "audio" | "subtitle";
  ordinal: number;
  placement: string | null;
  streamLabel: string | null;
};

function runTool(command: string, args: string[], timeout: number, allowWarning = false): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const low = idle(command, args);
    execFile(low.command, low.args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = stdout?.toString() ?? "";
      const err = stderr?.toString() ?? "";
      const code = error ? (error as { code?: string | number }).code : undefined;
      if (!error || (allowWarning && code === 1)) {
        resolve({ stdout: out, stderr: err });
        return;
      }
      const missing = code === "ENOENT" || /No such file or directory|not found/i.test(`${err}\n${error?.message ?? ""}`);
      const timedOut = Boolean(error && "killed" in error && error.killed);
      const detail = err
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("_STATISTICS_"))
        .slice(-3)
        .join(" ");
      if (missing) reject(new Error(`${command} is not installed, so the file was left unchanged.`));
      else if (timedOut) reject(new Error(`${command} timed out, so the file was left unchanged.`));
      else reject(new Error(detail || `${command} could not change the file.`));
    });
  });
}

function skipSentence(reason: "unknown-language" | "container" | "already-named"): string {
  if (reason === "unknown-language") return "This language has no tag a media file can store, so the file was left unchanged.";
  if (reason === "already-named") return "The subtitle file name already includes a language, so it was left unchanged.";
  return "This container cannot store a track language, so the file was left unchanged.";
}

async function existingLanguage(file: string, kind: "audio" | "subtitle", ordinal: number): Promise<string | null> {
  try {
    const spec = kind === "audio" ? `a:${ordinal}` : `s:${ordinal}`;
    const { stdout } = await runTool(
      "ffprobe",
      ["-v", "error", "-select_streams", spec, "-show_entries", "stream_tags=language", "-of", "json", file],
      30_000,
    );
    const body = JSON.parse(stdout) as { streams?: Array<{ tags?: { language?: unknown } }> };
    const code = body.streams?.[0]?.tags?.language;
    return typeof code === "string" ? languageName(code) : null;
  } catch {
    return null;
  }
}

function roomForCopy(file: string, scratch: string): boolean {
  try {
    const needed = fs.statSync(file).size + 512 * 1024 * 1024;
    fs.mkdirSync(scratch, { recursive: true });
    return [path.dirname(file), scratch].every((directory) => {
      const space = fs.statfsSync(directory);
      return Number(space.bavail) * Number(space.bsize) > needed;
    });
  } catch {
    return true;
  }
}

function retagScratch(db: Database.Database): string {
  return path.join(scratchRoot(db.name), "retag-work");
}

function dryRunSentence(plan: Exclude<TagPlan, { action: "skip" }>, kind: "audio" | "subtitle", localFile: string): string {
  if (plan.action === "rename") return `Dry run: would rename ${path.basename(localFile)} to ${path.basename(plan.to)}. Nothing was written.`;
  if (plan.action === "remux") return `Dry run: would copy this into ${path.basename(plan.to)} and tag the ${kind} track as ${plan.language}. Nothing was written.`;
  const how = plan.action === "matroska" ? "set it in place with mkvpropedit" : "write a retagged copy and swap it in";
  return `Dry run: would tag the ${kind} track as ${plan.language} (${how}). Nothing was written.`;
}

function videoPathsFor(job: WriteJob, stamped: string[]): string[] {
  const paths = job.placement === "external" ? stamped : [...stamped, job.path];
  return [...new Set(paths.filter(Boolean))];
}

function unchanged(job: WriteJob, sentence: string, settled = true): WriteResult {
  return { storedPath: job.path, sentence, changed: false, settled, videoPaths: [] };
}

/** ffmpeg writes to local scratch; the copy reaches the media folder as `<file>.partial` and is renamed into place. */
async function deliverCopy(source: string, target: string, scratchRoot: string, args: (output: string) => string[], removeSource: boolean) {
  const backup = `${source}.metarr-bak`;
  if (!fs.existsSync(source) && fs.existsSync(backup)) fs.renameSync(backup, source);
  fs.mkdirSync(scratchRoot, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(scratchRoot, "job-"));
  try {
    const temp = path.join(scratch, path.basename(target));
    await runTool("ffmpeg", args(temp), 3 * 60 * 60 * 1000);
    if (!fs.existsSync(temp) || fs.statSync(temp).size < 1024) {
      throw new Error("ffmpeg did not write a retagged file, so the original was left unchanged.");
    }
    deliverFile(temp, target, { replace: target === source, mode: (fs.statSync(source).mode & 0o777) | 0o660 });
    if (removeSource && target !== source) fs.rmSync(source, { force: true });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function writeFinding(
  db: Database.Database,
  job: WriteJob,
  localFile: string,
  language: string,
  role: "commentary" | "forced" | "short" | null,
): Promise<WriteResult> {
  const plan = planTag(localFile, job.kind, job.ordinal, language, role);
  if (plan.action === "skip") {
    if (plan.reason === "container") {
      const existing = await existingLanguage(localFile, job.kind, job.ordinal);
      if (existing && existing.toLowerCase() === language.toLowerCase()) {
        const stamped = stampLanguage(db, { path: job.path, kind: job.kind, ordinal: job.ordinal, language, role, renamedTo: null });
        return {
          storedPath: job.path,
          sentence: "The file already names this track.",
          changed: true,
          settled: true,
          videoPaths: videoPathsFor(job, stamped),
        };
      }
    }
    return unchanged(job, skipSentence(plan.reason));
  }

  try {
    if (plan.action === "matroska" || plan.action === "mp4") {
      const existing = await existingLanguage(localFile, job.kind, job.ordinal);
      if (existing && existing !== language) {
        return unchanged(job, `The file already names this track as ${existing}, so it was left unchanged.`);
      }
      if (existing) {
        const stamped = stampLanguage(db, { path: job.path, kind: job.kind, ordinal: job.ordinal, language, role, renamedTo: null });
        return {
          storedPath: job.path,
          sentence: "The file already names this track.",
          changed: true,
          settled: true,
          videoPaths: videoPathsFor(job, stamped),
        };
      }
    }

    if (dryRun()) return unchanged(job, dryRunSentence(plan, job.kind, localFile), false);

    if (plan.action === "matroska") {
      const args = [localFile, "--edit", plan.selector, "--set", `language=${plan.language}`];
      if (plan.commentary) args.push("--set", "flag-commentary=1");
      if (plan.forced) args.push("--set", "flag-forced=1");
      if (plan.commentary && !/commentary/i.test(job.streamLabel ?? "")) args.push("--set", "name=Commentary");
      await runTool("mkvpropedit", args, 60_000, true);
    } else if (plan.action === "mp4") {
      if (fs.statSync(localFile).nlink > 1) {
        return unchanged(job, "This file is linked from more than one folder, so retagging it would leave the other link unchanged.");
      }
      const scratch = retagScratch(db);
      if (!roomForCopy(localFile, scratch)) {
        return unchanged(job, "There is not enough free disk space to retag this file, so it was left unchanged.", false);
      }
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        localFile,
        "-map",
        "0",
        "-c",
        "copy",
        `-metadata:${plan.specifier}`,
        `language=${plan.language}`,
      ];
      if (plan.commentary && !/commentary/i.test(job.streamLabel ?? "")) args.push(`-metadata:${plan.specifier}`, "title=Commentary");
      if (plan.forced) args.push(`-disposition:s:${job.ordinal}`, "forced");
      await deliverCopy(localFile, localFile, scratch, (output) => [...args, output], false);
    } else if (plan.action === "remux") {
      if (fs.existsSync(plan.to)) {
        return unchanged(job, "An MKV with this name already exists, so the original was left unchanged.");
      }
      if (fs.statSync(localFile).nlink > 1) {
        return unchanged(job, "This file is linked from more than one folder, so replacing it would leave the other link unchanged.");
      }
      const scratch = retagScratch(db);
      if (!roomForCopy(localFile, scratch)) {
        return unchanged(job, "There is not enough free disk space to copy this into an MKV, so it was left unchanged.", false);
      }
      const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        localFile,
        "-map",
        "0",
        "-c",
        "copy",
        "-map_metadata",
        "0",
        `-metadata:${plan.specifier}`,
        `language=${plan.language}`,
      ];
      if (plan.commentary && !/commentary/i.test(job.streamLabel ?? "")) args.push(`-metadata:${plan.specifier}`, "title=Commentary");
      await deliverCopy(localFile, plan.to, scratch, (output) => [...args, output], true);
    } else {
      if (fs.existsSync(plan.to)) {
        return unchanged(job, "A subtitle file with that language in its name already exists, so this file was left unchanged.");
      }
      fs.renameSync(localFile, plan.to);
      if (plan.pairFrom && plan.pairTo && fs.existsSync(plan.pairFrom) && !fs.existsSync(plan.pairTo)) {
        try {
          fs.renameSync(plan.pairFrom, plan.pairTo);
        } catch {
          // The subtitle file itself already has the language in its name.
        }
      }
    }
  } catch (caught) {
    const sentence = caught instanceof Error ? caught.message : "The file could not be changed.";
    return unchanged(job, sentence.endsWith(".") ? sentence : `${sentence}.`, false);
  }

  const renamedTo = plan.action === "rename" || plan.action === "remux" ? retargetPath(job.path, localFile, plan.to) : null;
  const stamped = stampLanguage(db, { path: job.path, kind: job.kind, ordinal: job.ordinal, language, role, renamedTo });
  let told = "";
  if (plan.action === "remux") {
    try {
      told = await announceFolder(db, [path.dirname(plan.to)]);
    } catch {
      told = "";
    }
  }
  const sentence =
    plan.action === "rename"
      ? "The subtitle file was renamed so the language is in its name."
      : plan.action === "remux"
        ? ["Copied into an MKV, because this container cannot store a track language.", told].filter(Boolean).join(" ")
        : "Written into the file.";
  return {
    storedPath: renamedTo ?? job.path,
    sentence,
    changed: true,
    settled: true,
    videoPaths: videoPathsFor(job, stamped),
  };
}

const deferredWrites = new Set<string>();

function savedKey(filePath: string, kind: string, ordinal: number): string {
  return `${filePath}\0${kind}\0${ordinal}`;
}

/** Write a language that was recognized earlier and never stored in the file. One file per call. */
export async function applyNextSaved(db: Database.Database, maps: PathMap[]): Promise<boolean> {
  const rows = db
    .prepare(
      `SELECT path, kind, ordinal, language, role FROM detect_results
       WHERE language IS NOT NULL AND written_at IS NULL
       ORDER BY scanned_at
       LIMIT 40`,
    )
    .all() as Array<{ path: string; kind: string; ordinal: number; language: string; role: string | null }>;
  const row = rows.find((item) => !deferredWrites.has(savedKey(item.path, item.kind, item.ordinal)));
  if (!row || !row.language) return false;
  const key = savedKey(row.path, row.kind, row.ordinal);
  const kind = row.kind === "subtitle" ? "subtitle" : "audio";
  const role = row.role === "commentary" || row.role === "forced" ? row.role : null;
  const local = resolveMediaPath(row.path, maps, (candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!local) {
    deferredWrites.add(key);
    return true;
  }
  const written = await writeFinding(
    db,
    {
      path: row.path,
      kind,
      ordinal: row.ordinal,
      placement: isSubtitleFile(local) ? "external" : null,
      streamLabel: role === "commentary" ? "Commentary" : null,
    },
    local,
    row.language,
    role,
  );
  if (!written.settled) {
    deferredWrites.add(key);
    return true;
  }
  markWritten(db, row, written.storedPath);
  if (written.changed) {
    try {
      await notifyPlayers(db, written.videoPaths, kind === "subtitle");
    } catch {
      // The file already has the language. The next sync can refresh a player that was down.
    }
  }
  return true;
}
