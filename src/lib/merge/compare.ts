import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { idle } from "@/lib/idle";

const FRAME_WIDTH = 160;
const FRAME_HEIGHT = 90;
const MATCH_THRESHOLD = 28;
const PROBE_TIMEOUT_MS = 60_000;
const FRAME_TIMEOUT_MS = 120_000;

/** Default catalog tolerance when Settings has not overridden it. */
export const DEFAULT_MAX_DURATION_DELTA_MINUTES = 1;
/** Default number of grayscale samples Check frames takes from each file. */
export const DEFAULT_FRAME_SAMPLE_COUNT = 12;
export const MIN_FRAME_SAMPLE_COUNT = 4;
export const MAX_FRAME_SAMPLE_COUNT = 24;

export type DurationCheck = {
  ok: boolean;
  leftSeconds: number | null;
  rightSeconds: number | null;
  deltaSeconds: number | null;
  /** Allowed absolute difference in seconds. */
  toleranceSeconds: number;
};

export type FrameSample = {
  index: number;
  offsetSeconds: number;
  rightOffsetSeconds: number;
  meanDiff: number | null;
  matched: boolean;
};

export type RuntimeKind = "same" | "framerate" | "edition" | "titles";

export type FrameCheck = {
  ok: boolean;
  samples: FrameSample[];
  matched: number;
  required: number;
  percent: number;
  kind: RuntimeKind;
  leftFps: number | null;
  rightFps: number | null;
  durationDeltaSeconds: number | null;
  message: string;
};

export function parseFrameSampleCount(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isInteger(numeric) || numeric < MIN_FRAME_SAMPLE_COUNT || numeric > MAX_FRAME_SAMPLE_COUNT) return null;
  return numeric;
}

/** Need about 80% of the samples (10 of 12 by default). */
export function requiredFrameMatches(count: number): number {
  const n = Math.max(1, Math.round(count));
  return Math.max(1, Math.ceil((n * 10) / 12));
}

export function parseFrameRate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 120) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text === "0/0") return null;
  if (text.includes("/")) {
    const [numerator, denominator] = text.split("/");
    const top = Number(numerator);
    const bottom = Number(denominator);
    if (!bottom || !Number.isFinite(top) || !Number.isFinite(bottom)) return null;
    const fps = top / bottom;
    return fps > 0 && fps < 120 ? fps : null;
  }
  const fps = Number(text);
  return Number.isFinite(fps) && fps > 0 && fps < 120 ? fps : null;
}

export function fpsFamily(fps: number | null): "film" | "pal" | "ntsc" | null {
  if (fps == null || !Number.isFinite(fps) || fps <= 0) return null;
  if (fps >= 23.5 && fps < 24.5) return "film";
  if (fps >= 24.5 && fps < 25.5) return "pal";
  if (fps >= 29.5 && fps < 30.5) return "ntsc";
  return null;
}

export function formatFps(fps: number | null): string {
  if (fps == null || !Number.isFinite(fps)) return "unknown";
  if (Math.abs(fps - 23.976) < 0.05) return "23.976";
  if (Math.abs(fps - 29.97) < 0.05) return "29.97";
  const rounded = Math.round(fps * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** PAL 25 fps is ~4% shorter than 24 / 23.976 film. */
export function isPalSpeedDuration(leftSeconds: number, rightSeconds: number): boolean {
  const longer = Math.max(leftSeconds, rightSeconds);
  const shorter = Math.min(leftSeconds, rightSeconds);
  if (longer <= 0) return false;
  const ratio = shorter / longer;
  return ratio >= 0.948 && ratio <= 0.972;
}

export function isPalFilmPair(leftFps: number | null, rightFps: number | null): boolean {
  const left = fpsFamily(leftFps);
  const right = fpsFamily(rightFps);
  return (left === "film" && right === "pal") || (left === "pal" && right === "film");
}

export function classifyRuntime(input: {
  leftSeconds: number | null;
  rightSeconds: number | null;
  leftFps: number | null;
  rightFps: number | null;
  framesOk: boolean | null;
}): RuntimeKind {
  const { leftSeconds, rightSeconds, leftFps, rightFps, framesOk } = input;
  if (leftSeconds == null || rightSeconds == null || leftSeconds <= 0 || rightSeconds <= 0) return "same";
  if (durationsCloseSeconds(leftSeconds, rightSeconds).ok) return "same";
  const palDuration = isPalSpeedDuration(leftSeconds, rightSeconds);
  const palFps = isPalFilmPair(leftFps, rightFps);
  const fpsUnknown = fpsFamily(leftFps) == null && fpsFamily(rightFps) == null;
  if (palDuration && (palFps || fpsUnknown)) return "framerate";
  if (framesOk) return "titles";
  return "edition";
}

export function explainFrameCheck(input: {
  matched: number;
  total: number;
  required: number;
  ok: boolean;
  leftSeconds: number | null;
  rightSeconds: number | null;
  leftFps: number | null;
  rightFps: number | null;
}): { kind: RuntimeKind; percent: number; message: string } {
  const percent = input.total > 0 ? Math.round((input.matched / input.total) * 100) : 0;
  const kind = classifyRuntime({ ...input, framesOk: input.ok });
  const delta =
    input.leftSeconds != null && input.rightSeconds != null ? Math.abs(input.leftSeconds - input.rightSeconds) : null;
  const fpsBit =
    input.leftFps != null || input.rightFps != null ? `${formatFps(input.leftFps)} fps vs ${formatFps(input.rightFps)} fps` : null;
  const matchBit = input.ok
    ? `${input.matched} of ${input.total} frames matched (${percent}%)`
    : `${input.matched} of ${input.total} frames matched (${percent}%; need ${input.required})`;
  if (input.ok) {
    if (kind === "framerate") {
      return {
        kind,
        percent,
        message: `${matchBit}. Different frame rates (${fpsBit ?? "about 24 vs 25 fps"}); the ${Math.round(delta ?? 0)} s runtime gap is the PAL speed change, not a different cut.`,
      };
    }
    if (kind === "titles") {
      return {
        kind,
        percent,
        message: `${matchBit}. Runtimes differ by ${Math.round(delta ?? 0)} s${fpsBit ? ` (${fpsBit})` : ""}; extra time is likely titles or credits, not a different cut.`,
      };
    }
    return { kind, percent, message: `${matchBit}. Same edit.` };
  }
  if (kind === "framerate") {
    return {
      kind,
      percent,
      message: `${matchBit}. Frame rates differ (${fpsBit ?? "about 24 vs 25 fps"}) and the pictures do not line up, so this may still be a different cut.`,
    };
  }
  if (kind === "edition") {
    return {
      kind,
      percent,
      message: `${matchBit}. Runtimes differ by ${Math.round(delta ?? 0)} s${fpsBit ? ` (${fpsBit})` : ""} — likely different editions.`,
    };
  }
  return { kind, percent, message: `${matchBit}. These may be different cuts.` };
}

/**
 * Catalog duration is in whole minutes.
 * When `maxDeltaMinutes` is set (Settings), that absolute allowance is used.
 * Otherwise: half a minute for tiny runtimes, else at least one minute or 1%.
 */
export function durationToleranceMinutes(left: number, right: number, maxDeltaMinutes?: number | null): number {
  if (maxDeltaMinutes != null && Number.isFinite(maxDeltaMinutes) && maxDeltaMinutes >= 0) {
    return maxDeltaMinutes;
  }
  const longer = Math.max(left, right);
  if (longer < 5) return 0.5;
  return Math.max(DEFAULT_MAX_DURATION_DELTA_MINUTES, longer * 0.01);
}

export function durationsCloseMinutes(
  left: number | null,
  right: number | null,
  maxDeltaMinutes?: number | null,
): DurationCheck {
  if (left == null || right == null || left <= 0 || right <= 0) {
    const fallback = maxDeltaMinutes != null && Number.isFinite(maxDeltaMinutes) ? maxDeltaMinutes * 60 : 60;
    return { ok: false, leftSeconds: left == null ? null : left * 60, rightSeconds: right == null ? null : right * 60, deltaSeconds: null, toleranceSeconds: fallback };
  }
  const tolerance = durationToleranceMinutes(left, right, maxDeltaMinutes);
  const delta = Math.abs(left - right);
  return {
    ok: delta <= tolerance,
    leftSeconds: left * 60,
    rightSeconds: right * 60,
    deltaSeconds: delta * 60,
    toleranceSeconds: tolerance * 60,
  };
}

/** Probe durations in seconds; allow 2% or 5 seconds, whichever is larger. */
export function durationsCloseSeconds(left: number | null, right: number | null): DurationCheck {
  if (left == null || right == null || left <= 0 || right <= 0) {
    return { ok: false, leftSeconds: left, rightSeconds: right, deltaSeconds: null, toleranceSeconds: 5 };
  }
  const tolerance = Math.max(5, Math.max(left, right) * 0.02);
  const delta = Math.abs(left - right);
  return { ok: delta <= tolerance, leftSeconds: left, rightSeconds: right, deltaSeconds: delta, toleranceSeconds: tolerance };
}

/** Evenly spaced offsets between 5% and 95% of the runtime. */
export function sampleOffsets(durationSeconds: number, count = DEFAULT_FRAME_SAMPLE_COUNT): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 10) return [];
  const n = Math.max(1, Math.round(count));
  const start = durationSeconds * 0.05;
  const end = durationSeconds * 0.95;
  if (n === 1 || end <= start) return [Math.max(0, durationSeconds / 2)];
  return Array.from({ length: n }, (_, index) => start + ((end - start) * index) / (n - 1));
}

/** Mean absolute difference of 8-bit grayscale bytes; 0 is identical. */
export function meanAbsoluteDiff(left: Buffer, right: Buffer): number | null {
  if (left.length === 0 || left.length !== right.length) return null;
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) sum += Math.abs(left[i]! - right[i]!);
  return sum / left.length;
}

export function framesMatch(diffs: Array<number | null>, required?: number, threshold = MATCH_THRESHOLD): boolean {
  const need = required ?? requiredFrameMatches(diffs.length);
  const matched = diffs.filter((diff) => diff != null && diff <= threshold).length;
  return matched >= need;
}

function runTool(command: string, args: string[], timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const wrapped = idle(command, args);
    const child = spawn(wrapped.command, wrapped.args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`${command} timed out while comparing frames.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.on("error", (error) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      fail(new Error(missing ? `${command} is not installed where Metarr runs.` : error.message));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(chunks));
        return;
      }
      const lines = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      reject(new Error(lines.slice(-2).join(" ") || `${command} exited with code ${code}.`));
    });
  });
}

export type MediaTiming = { durationSeconds: number | null; fps: number | null };

export async function probeMediaTiming(file: string): Promise<MediaTiming> {
  const output = await runTool(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=avg_frame_rate,r_frame_rate",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      file,
    ],
    PROBE_TIMEOUT_MS,
  );
  const value = JSON.parse(output.toString("utf8")) as {
    streams?: Array<{ avg_frame_rate?: string; r_frame_rate?: string }>;
    format?: { duration?: string };
  };
  const stream = value.streams?.[0];
  const fps = parseFrameRate(stream?.avg_frame_rate) ?? parseFrameRate(stream?.r_frame_rate);
  const duration = Number(value.format?.duration);
  return { durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null, fps };
}

export async function probeDurationSeconds(file: string): Promise<number | null> {
  return (await probeMediaTiming(file)).durationSeconds;
}

async function grayscaleFrame(file: string, offsetSeconds: number): Promise<Buffer> {
  return runTool(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(Math.max(0, offsetSeconds)),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=decrease,pad=${FRAME_WIDTH}:${FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=gray`,
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    FRAME_TIMEOUT_MS,
  );
}

/**
 * Grab the same relative moments from both files and compare low-res grayscale frames.
 * Duration is not a stop: titles, credits, or PAL speed can change length; the pictures decide.
 */
export async function compareFrames(
  leftPath: string,
  rightPath: string,
  options: { frameCount?: number; workDir?: string; onProgress?: (done: number, total: number) => void } = {},
): Promise<FrameCheck> {
  const frameCount = parseFrameSampleCount(options.frameCount) ?? DEFAULT_FRAME_SAMPLE_COUNT;
  const required = requiredFrameMatches(frameCount);
  const empty = (message: string, left: MediaTiming | null, right: MediaTiming | null): FrameCheck => ({
    ok: false,
    samples: [],
    matched: 0,
    required,
    percent: 0,
    kind: "same",
    leftFps: left?.fps ?? null,
    rightFps: right?.fps ?? null,
    durationDeltaSeconds:
      left?.durationSeconds != null && right?.durationSeconds != null
        ? Math.abs(left.durationSeconds - right.durationSeconds)
        : null,
    message,
  });

  const [left, right] = await Promise.all([probeMediaTiming(leftPath), probeMediaTiming(rightPath)]);
  if (left.durationSeconds == null || right.durationSeconds == null) {
    return empty("Could not read both runtimes, so the edit check did not run.", left, right);
  }
  const leftOffsets = sampleOffsets(left.durationSeconds, frameCount);
  const rightOffsets = sampleOffsets(right.durationSeconds, frameCount);
  if (leftOffsets.length < required || rightOffsets.length < required) {
    return empty("The files are too short to compare frames.", left, right);
  }
  const workDir = options.workDir;
  if (workDir) fs.mkdirSync(workDir, { recursive: true });
  const samples: FrameSample[] = [];
  for (let index = 0; index < leftOffsets.length; index += 1) {
    const leftOffset = leftOffsets[index]!;
    const rightOffset = rightOffsets[index]!;
    options.onProgress?.(index, leftOffsets.length);
    try {
      const [leftFrame, rightFrame] = await Promise.all([grayscaleFrame(leftPath, leftOffset), grayscaleFrame(rightPath, rightOffset)]);
      if (workDir) {
        fs.writeFileSync(path.join(workDir, `left-${index}.raw`), leftFrame);
        fs.writeFileSync(path.join(workDir, `right-${index}.raw`), rightFrame);
      }
      const meanDiff = meanAbsoluteDiff(leftFrame, rightFrame);
      samples.push({
        index,
        offsetSeconds: leftOffset,
        rightOffsetSeconds: rightOffset,
        meanDiff,
        matched: meanDiff != null && meanDiff <= MATCH_THRESHOLD,
      });
    } catch {
      samples.push({ index, offsetSeconds: leftOffset, rightOffsetSeconds: rightOffset, meanDiff: null, matched: false });
    }
  }
  options.onProgress?.(leftOffsets.length, leftOffsets.length);
  const matched = samples.filter((sample) => sample.matched).length;
  const ok = matched >= required;
  const explained = explainFrameCheck({
    matched,
    total: samples.length,
    required,
    ok,
    leftSeconds: left.durationSeconds,
    rightSeconds: right.durationSeconds,
    leftFps: left.fps,
    rightFps: right.fps,
  });
  return {
    ok,
    samples,
    matched,
    required,
    percent: explained.percent,
    kind: explained.kind,
    leftFps: left.fps,
    rightFps: right.fps,
    durationDeltaSeconds: Math.abs(left.durationSeconds - right.durationSeconds),
    message: explained.message,
  };
}
