import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { announceFolder } from "@/lib/announce";
import { deliverFile } from "@/lib/deliver";
import { filesForSelection } from "@/lib/detect/files";
import { resolveMediaPath } from "@/lib/detect/paths";
import { decodeSubtitleBytes } from "@/lib/detect/encoding";
import { readSidecarNames, sidecarsIn } from "@/lib/detect/sidecars";
import { readDetectSettings } from "@/lib/detect/store";
import { readTimingCheck, saveTimingCheck } from "@/lib/subtitle-check/store";
import { dryRun } from "@/lib/dry-run";
import { probeMediaTiming } from "@/lib/merge/compare";
import {
  cueSpan,
  formatClock,
  isIdentity,
  judgeTiming,
  minutesText,
  retime,
  timingFormat,
  timingMapProblem,
  type CueSpan,
  type TimingMap,
  type TimingStatus,
  type TimingVerdict,
} from "@/lib/subtitle-timing";

export type SubtitleTimingRow = {
  file: string;
  name: string;
  videoName: string;
  videoSeconds: number | null;
  /** `probe` is the exact length from ffprobe; `runtime` is the stored runtime, rounded to minutes. */
  videoSource: "probe" | "runtime" | null;
  fps: number | null;
  cues: number;
  firstStart: number | null;
  firstText: string;
  lastEnd: number | null;
  lastText: string;
  status: TimingStatus;
  message: string;
  preset: string | null;
  hasOriginal: boolean;
};

const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;

/** The first time Metarr retimes a subtitle, the file as it was is kept beside it under this name. */
export function originalPath(file: string): string {
  return `${file}.metarr-orig`;
}

type TextBytes = { text: string; encode: (text: string) => Buffer };

/**
 * UTF-16 is decoded and encoded again. Anything else is read one byte per character, so the
 * ASCII timestamps can change while UTF-8, Windows-1250 or any other text stays byte for byte.
 */
export function subtitleText(bytes: Buffer): TextBytes {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: bytes.toString("utf16le"), encode: (text) => Buffer.from(text, "utf16le") };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      text: Buffer.from(bytes).swap16().toString("utf16le"),
      encode: (text) => Buffer.from(text, "utf16le").swap16(),
    };
  }
  return { text: bytes.toString("latin1"), encode: (text) => Buffer.from(text, "latin1") };
}

function readableText(bytes: Buffer): string {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return subtitleText(bytes).text;
  return decodeSubtitleBytes(bytes);
}

function readSubtitle(file: string): Buffer {
  const size = fs.statSync(file).size;
  if (size > MAX_SUBTITLE_BYTES) throw new Error(`${path.basename(file)} is larger than a text subtitle should be.`);
  return fs.readFileSync(file);
}

export type Video = { stored: string; local: string; runtimeMinutes: number | null };

export function existingFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function selectionVideos(db: Database.Database, catalogId: number, episodeId: number | null): Video[] {
  const kind = db.prepare(`SELECT kind FROM catalog_titles WHERE id = ?`).get(catalogId) as { kind: string } | undefined;
  if (!kind) throw new Error("Unknown title.");
  if (kind.kind === "series" && episodeId == null) throw new Error("Open one episode to check its subtitle timing.");
  const maps = readDetectSettings(db).pathMaps;
  const files = filesForSelection(db, episodeId == null ? [catalogId] : [], episodeId == null ? [] : [episodeId]);
  const videos: Video[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const entries = [
      { path: file.path, minutes: file.versions[0]?.durationMinutes ?? null },
      ...file.versions.map((version) => ({ path: version.path, minutes: version.durationMinutes })),
    ];
    for (const entry of entries) {
      if (!entry.path) continue;
      const local = resolveMediaPath(entry.path, maps, existingFile);
      if (!local || seen.has(local)) continue;
      seen.add(local);
      videos.push({ stored: entry.path, local, runtimeMinutes: entry.minutes });
    }
  }
  return videos;
}

export function textSidecars(video: Video): string[] {
  return sidecarsIn(video.local, readSidecarNames(video.local))
    .map((sidecar) => sidecar.file)
    .filter((file) => timingFormat(file) != null);
}

export type VideoLength = { seconds: number | null; source: SubtitleTimingRow["videoSource"]; fps: number | null };

export async function videoLength(video: Video): Promise<VideoLength> {
  try {
    const timing = await probeMediaTiming(video.local);
    if (timing.durationSeconds != null) return { seconds: timing.durationSeconds, source: "probe", fps: timing.fps };
  } catch {
    // Fall back to the stored runtime below.
  }
  if (video.runtimeMinutes != null && video.runtimeMinutes > 0) return { seconds: video.runtimeMinutes * 60, source: "runtime", fps: null };
  return { seconds: null, source: null, fps: null };
}

/**
 * Once Metarr has retimed a file, an early last line is the credits, not another 25 fps file,
 * so no preset is offered again: applying the same stretch twice would undo the fix.
 */
export function retimedVerdict(verdict: TimingVerdict, retimed: boolean, span: CueSpan, videoSeconds: number | null): TimingVerdict {
  if (!retimed || verdict.status === "unknown") return verdict;
  const note = "Metarr already changed this file's timing. Restore original puts it back.";
  if (verdict.status === "shorter" && verdict.preset && videoSeconds != null) {
    const gap = videoSeconds - span.lastEnd;
    return { status: "fits", message: `The last line is ${minutesText(Math.max(0, gap))} before the video ends. ${note}`, preset: null };
  }
  return { ...verdict, message: `${verdict.message} ${note}`, preset: null };
}

export function inspectFile(file: string, video: Video, length: VideoLength): SubtitleTimingRow {
  const format = timingFormat(file)!;
  const base = {
    file,
    name: path.relative(path.dirname(video.local), file),
    videoName: path.basename(video.local),
    videoSeconds: length.seconds,
    videoSource: length.source,
    fps: length.fps,
    hasOriginal: fs.existsSync(originalPath(file)),
  };
  let span: ReturnType<typeof cueSpan> = null;
  try {
    span = cueSpan(readableText(readSubtitle(file)), format);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "The file could not be read.";
    return { ...base, cues: 0, firstStart: null, firstText: "", lastEnd: null, lastText: "", status: "unknown", message, preset: null };
  }
  if (!span) {
    return { ...base, cues: 0, firstStart: null, firstText: "", lastEnd: null, lastText: "", status: "unknown", message: "No timed lines were found in this file.", preset: null };
  }
  const verdict = retimedVerdict(judgeTiming(span, length.seconds, length.fps), base.hasOriginal, span, length.seconds);
  const rounded = length.source === "runtime" && verdict.status !== "unknown" ? " The video length is the stored runtime, rounded to the minute." : "";
  return { ...base, ...span, status: verdict.status, message: `${verdict.message}${rounded}`, preset: verdict.preset };
}

/** Every SRT, VTT, ASS and SSA file beside the title's videos, compared with the length of the video it belongs to. */
export async function inspectSubtitleTiming(db: Database.Database, catalogId: number, episodeId: number | null): Promise<SubtitleTimingRow[]> {
  const rows: SubtitleTimingRow[] = [];
  for (const video of selectionVideos(db, catalogId, episodeId)) {
    const files = textSidecars(video);
    if (!files.length) continue;
    const length = await videoLength(video);
    for (const file of files) {
      const row = inspectFile(file, video, length);
      recordInspection(db, video, row, null);
      rows.push(row);
    }
  }
  return rows;
}

function sizeOf(file: string): { size: number | null; mtime: number | null } {
  try {
    const stat = fs.statSync(file);
    return { size: stat.size, mtime: stat.mtimeMs };
  } catch {
    return { size: null, mtime: null };
  }
}

/** Keep what this check found, so the library list and its filter can show it. */
export function recordInspection(db: Database.Database, video: Video, row: SubtitleTimingRow, pass: string | null, autoFixedAt: string | null = null): void {
  const subtitle = sizeOf(row.file);
  saveTimingCheck(
    db,
    {
      videoPath: video.stored,
      name: path.relative(path.dirname(video.local), row.file),
      subSize: subtitle.size,
      subMtime: subtitle.mtime,
      videoSize: sizeOf(video.local).size,
      status: row.status,
      preset: row.preset,
      message: row.message,
      videoSeconds: row.videoSeconds,
      fps: row.fps,
      lastEnd: row.lastEnd,
      retimed: row.hasOriginal,
      autoFixedAt,
    },
    pass,
  );
}

/** Whether the stored check still describes these files, so the video does not need probing again. */
export function checkIsCurrent(db: Database.Database, video: Video, file: string): boolean {
  const stored = readTimingCheck(db, video.stored, path.relative(path.dirname(video.local), file));
  if (!stored || stored.status === "unknown") return false;
  const subtitle = sizeOf(file);
  return stored.subSize === subtitle.size && stored.subMtime === subtitle.mtime && stored.videoSize === sizeOf(video.local).size;
}

function ownedSubtitle(db: Database.Database, catalogId: number, episodeId: number | null, file: string): Video {
  for (const video of selectionVideos(db, catalogId, episodeId)) {
    if (textSidecars(video).includes(file)) return video;
  }
  throw new Error("That subtitle file is not beside this title's video any more. Rescan the title and try again.");
}

function writeInPlace(file: string, bytes: Buffer): void {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-subtitle-"));
  try {
    const temp = path.join(scratch, path.basename(file));
    fs.writeFileSync(temp, bytes);
    deliverFile(temp, file, { replace: true, mode: fs.statSync(file).mode & 0o777 });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function tellApps(db: Database.Database, video: Video): Promise<string> {
  try {
    return await announceFolder(db, [path.dirname(video.stored)]);
  } catch {
    return "";
  }
}

function describe(map: TimingMap): string {
  const parts: string[] = [];
  if (Math.abs(map.scale - 1) >= 1e-6) parts.push(`${map.scale > 1 ? "stretched" : "shrunk"} by ${(Math.abs(map.scale - 1) * 100).toFixed(2)}%`);
  if (Math.abs(map.offset) >= 0.0005) parts.push(`shifted ${map.offset > 0 ? "later" : "earlier"} by ${Math.abs(map.offset).toFixed(3)} s`);
  return parts.join(" and ");
}

/** Rewrite the cue times of one subtitle file, keeping the first version beside it. */
export function retimeFile(file: string, map: TimingMap): { message: string; written: boolean } {
  const problem = timingMapProblem(map);
  if (problem) throw new Error(problem);
  if (isIdentity(map)) throw new Error("Those times are the same as the file's, so there is nothing to change.");
  const format = timingFormat(file);
  if (!format) throw new Error("Only SRT, VTT, ASS and SSA files can be retimed.");
  const source = subtitleText(readSubtitle(file));
  const next = retime(source.text, format, map);
  if (next === source.text) throw new Error("No cue times were found to change, so the file was left as it was.");
  const span = cueSpan(readableText(source.encode(next)), format);
  const ends = span ? ` The last line now ends at ${formatClock(span.lastEnd)}.` : "";
  const name = path.basename(file);
  if (dryRun()) return { message: `Dry run: ${name} would be ${describe(map)}.${ends} Nothing was written.`, written: false };
  const backup = originalPath(file);
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  writeInPlace(file, source.encode(next));
  return { message: `${name} was ${describe(map)}.${ends} The file as it was is kept as ${path.basename(backup)}.`, written: true };
}

async function recheck(db: Database.Database, video: Video, file: string): Promise<void> {
  try {
    recordInspection(db, video, inspectFile(file, video, await videoLength(video)), null);
  } catch {
    // The next timing pass checks this file again.
  }
}

export async function fixSubtitleTiming(
  db: Database.Database,
  catalogId: number,
  episodeId: number | null,
  file: string,
  map: TimingMap,
): Promise<{ message: string }> {
  const video = ownedSubtitle(db, catalogId, episodeId, file);
  const result = retimeFile(file, map);
  if (!result.written) return { message: result.message };
  await recheck(db, video, file);
  const apps = await tellApps(db, video);
  return { message: `${result.message}${apps ? ` ${apps}` : ""}` };
}

export async function restoreSubtitleTiming(db: Database.Database, catalogId: number, episodeId: number | null, file: string): Promise<{ message: string }> {
  const video = ownedSubtitle(db, catalogId, episodeId, file);
  const backup = originalPath(file);
  if (!fs.existsSync(backup)) throw new Error("Metarr has not changed this subtitle, so there is no original to put back.");
  const name = path.basename(file);
  if (dryRun()) return { message: `Dry run: ${name} would go back to the original timing. Nothing was written.` };
  fs.renameSync(backup, file);
  await recheck(db, video, file);
  const apps = await tellApps(db, video);
  return { message: `${name} has its original timing again.${apps ? ` ${apps}` : ""}` };
}
