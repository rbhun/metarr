import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { idle } from "@/lib/idle";

const FRAME_COUNT = 12;
const FRAME_WIDTH = 160;
const FRAME_HEIGHT = 90;
const MATCH_THRESHOLD = 28;
const REQUIRED_MATCHES = 10;
const PROBE_TIMEOUT_MS = 60_000;
const FRAME_TIMEOUT_MS = 120_000;

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
  meanDiff: number | null;
  matched: boolean;
};

export type FrameCheck = {
  ok: boolean;
  samples: FrameSample[];
  matched: number;
  required: number;
  message: string;
};

/** Catalog duration is in whole minutes, so allow one minute of drift unless the runtimes are tiny. */
export function durationToleranceMinutes(left: number, right: number): number {
  const longer = Math.max(left, right);
  if (longer < 5) return 0.5;
  return Math.max(1, longer * 0.01);
}

export function durationsCloseMinutes(left: number | null, right: number | null): DurationCheck {
  if (left == null || right == null || left <= 0 || right <= 0) {
    return { ok: false, leftSeconds: left == null ? null : left * 60, rightSeconds: right == null ? null : right * 60, deltaSeconds: null, toleranceSeconds: 60 };
  }
  const tolerance = durationToleranceMinutes(left, right);
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

/** Evenly spaced offsets between 5% and 95% of the shorter runtime. */
export function sampleOffsets(durationSeconds: number, count = FRAME_COUNT): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 10) return [];
  const start = durationSeconds * 0.05;
  const end = durationSeconds * 0.95;
  if (end <= start) return [Math.max(0, durationSeconds / 2)];
  return Array.from({ length: count }, (_, index) => start + ((end - start) * index) / Math.max(1, count - 1));
}

/** Mean absolute difference of 8-bit grayscale bytes; 0 is identical. */
export function meanAbsoluteDiff(left: Buffer, right: Buffer): number | null {
  if (left.length === 0 || left.length !== right.length) return null;
  let sum = 0;
  for (let i = 0; i < left.length; i += 1) sum += Math.abs(left[i]! - right[i]!);
  return sum / left.length;
}

export function framesMatch(diffs: Array<number | null>, required = REQUIRED_MATCHES, threshold = MATCH_THRESHOLD): boolean {
  const matched = diffs.filter((diff) => diff != null && diff <= threshold).length;
  return matched >= required;
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

export async function probeDurationSeconds(file: string): Promise<number | null> {
  const output = await runTool(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", file],
    PROBE_TIMEOUT_MS,
  );
  const value = JSON.parse(output.toString("utf8")) as { format?: { duration?: string } };
  const duration = Number(value.format?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
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
 * Same edit → most samples look alike; theatrical vs extended usually fails several points.
 */
export async function compareFrames(
  leftPath: string,
  rightPath: string,
  options: { durationSeconds?: number | null; workDir?: string; onProgress?: (done: number, total: number) => void } = {},
): Promise<FrameCheck> {
  const leftDuration = options.durationSeconds ?? (await probeDurationSeconds(leftPath));
  const rightDuration = await probeDurationSeconds(rightPath);
  const durationCheck = durationsCloseSeconds(leftDuration, rightDuration);
  if (!durationCheck.ok) {
    return {
      ok: false,
      samples: [],
      matched: 0,
      required: REQUIRED_MATCHES,
      message:
        durationCheck.deltaSeconds == null
          ? "Could not read both runtimes, so the edit check did not run."
          : `Runtimes differ by ${Math.round(durationCheck.deltaSeconds)} s (allowed ${Math.round(durationCheck.toleranceSeconds)} s), so these are probably different edits.`,
    };
  }
  const shorter = Math.min(leftDuration!, rightDuration!);
  const offsets = sampleOffsets(shorter);
  if (offsets.length < REQUIRED_MATCHES) {
    return { ok: false, samples: [], matched: 0, required: REQUIRED_MATCHES, message: "The files are too short to compare frames." };
  }
  const workDir = options.workDir;
  if (workDir) fs.mkdirSync(workDir, { recursive: true });
  const samples: FrameSample[] = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index]!;
    options.onProgress?.(index, offsets.length);
    try {
      const [left, right] = await Promise.all([grayscaleFrame(leftPath, offset), grayscaleFrame(rightPath, offset)]);
      if (workDir) {
        fs.writeFileSync(path.join(workDir, `left-${index}.raw`), left);
        fs.writeFileSync(path.join(workDir, `right-${index}.raw`), right);
      }
      const meanDiff = meanAbsoluteDiff(left, right);
      samples.push({ index, offsetSeconds: offset, meanDiff, matched: meanDiff != null && meanDiff <= MATCH_THRESHOLD });
    } catch {
      samples.push({ index, offsetSeconds: offset, meanDiff: null, matched: false });
    }
  }
  options.onProgress?.(offsets.length, offsets.length);
  const matched = samples.filter((sample) => sample.matched).length;
  const ok = matched >= REQUIRED_MATCHES;
  return {
    ok,
    samples,
    matched,
    required: REQUIRED_MATCHES,
    message: ok
      ? `${matched} of ${samples.length} frame samples look the same, so these are likely the same edit.`
      : `Only ${matched} of ${samples.length} frame samples matched (need ${REQUIRED_MATCHES}). These may be different cuts.`,
  };
}
