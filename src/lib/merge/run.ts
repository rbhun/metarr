import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { compareFrames } from "@/lib/merge/compare";
import { mergeTarget } from "@/lib/merge/source";
import { deliverFile } from "@/lib/deliver";
import { idle } from "@/lib/idle";
import { languageCode } from "@/lib/media";

const MERGE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60_000;
const MKV_SUBTITLES = new Set(["subrip", "srt", "ass", "ssa", "dvd_subtitle", "text", "hdmv_pgs_subtitle", "dvb_subtitle"]);
const LOSSLESS_AUDIO: Record<string, string> = { pcm_bluray: "flac", pcm_dvd: "flac" };

export type ProbeStream = {
  index: number;
  codecType: string;
  codecName: string | null;
  language: string | null;
};

export type Probe = { streams: ProbeStream[]; duration: number | null };

export function parseMergeProbe(json: string): Probe {
  const value = JSON.parse(json) as {
    streams?: Array<{ index?: number; codec_type?: string; codec_name?: string; tags?: { language?: string } }>;
    format?: { duration?: string };
  };
  const streams = (value.streams ?? [])
    .filter((stream) => typeof stream.index === "number" && typeof stream.codec_type === "string")
    .map((stream) => ({
      index: stream.index as number,
      codecType: stream.codec_type as string,
      codecName: stream.codec_name ?? null,
      language: stream.tags?.language ?? null,
    }));
  const duration = Number(value.format?.duration);
  return { streams, duration: Number.isFinite(duration) && duration > 0 ? duration : null };
}

/**
 * Video from input 0; every audio and Matroska-compatible subtitle from both inputs.
 * PCM that Matroska cannot hold is stored as lossless FLAC.
 */
export function mergeArgs(
  videoPath: string,
  otherPath: string,
  output: string,
  videoProbe: Probe,
  otherProbe: Probe,
  startOffsetSeconds = 0,
): { args: string[]; video: number; audio: number; subtitles: number; converted: number } {
  const video = videoProbe.streams.filter((stream) => stream.codecType === "video");
  if (video.length === 0) throw new Error("The higher-quality file has no video stream.");
  const audio0 = videoProbe.streams.filter((stream) => stream.codecType === "audio");
  const audio1 = otherProbe.streams.filter((stream) => stream.codecType === "audio");
  const subs0 = videoProbe.streams.filter((stream) => stream.codecType === "subtitle" && MKV_SUBTITLES.has(stream.codecName ?? ""));
  const subs1 = otherProbe.streams.filter((stream) => stream.codecType === "subtitle" && MKV_SUBTITLES.has(stream.codecName ?? ""));
  const audio = [...audio0.map((stream) => ({ input: 0, stream })), ...audio1.map((stream) => ({ input: 1, stream }))];
  const subtitles = [...subs0.map((stream) => ({ input: 0, stream })), ...subs1.map((stream) => ({ input: 1, stream }))];
  if (audio.length === 0) throw new Error("Neither file has an audio stream to keep.");

  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-i", videoPath];
  const shift = Number.isFinite(startOffsetSeconds) ? Math.round(startOffsetSeconds) : 0;
  if (shift > 0) args.push("-ss", String(shift));
  else if (shift < 0) args.push("-itsoffset", String(-shift));
  args.push("-i", otherPath);
  args.push("-map", `0:${video[0]!.index}`);
  for (const item of audio) args.push("-map", `${item.input}:${item.stream.index}`);
  for (const item of subtitles) args.push("-map", `${item.input}:${item.stream.index}`);
  args.push("-c", "copy", "-map_metadata", "0", "-max_interleave_delta", "0");

  let converted = 0;
  audio.forEach((item, position) => {
    const lossless = LOSSLESS_AUDIO[item.stream.codecName ?? ""];
    if (lossless) {
      args.push(`-c:a:${position}`, lossless);
      converted += 1;
    }
    const code = item.stream.language ? languageCode(item.stream.language) : null;
    if (code) args.push(`-metadata:s:a:${position}`, `language=${code}`);
    args.push(`-disposition:a:${position}`, position === 0 ? "default" : "0");
  });
  subtitles.forEach((item, position) => {
    const code = item.stream.language ? languageCode(item.stream.language) : null;
    if (code) args.push(`-metadata:s:s:${position}`, `language=${code}`);
  });
  args.push("-progress", "pipe:1", "-nostats", "-f", "matroska", output);
  return { args, video: 1, audio: audio.length, subtitles: subtitles.length, converted };
}

function runTool(
  command: string,
  args: string[],
  timeoutMs: number,
  onLine: (line: string) => void = () => undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const wrapped = idle(command, args);
    const child = spawn(wrapped.command, wrapped.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
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
      fail(new Error(`${command} ran longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`));
    }, timeoutMs);
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      stdout = `${stdout}${line}\n`.slice(-500_000);
      onLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-20_000);
    });
    child.on("error", (error) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      fail(new Error(missing ? `${command} is not installed where Metarr runs. Rebuild the Docker image, which includes ffmpeg.` : error.message));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      if (code === 127) {
        reject(new Error(`${command} was not found where Metarr runs. Rebuild the Docker image, which includes ffmpeg.`));
        return;
      }
      const lines = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      reject(new Error(lines.slice(-3).join(" ") || `${command} exited with code ${code}.`));
    });
  });
}

async function probe(file: string): Promise<Probe> {
  const output = await runTool(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name:stream_tags=language:format=duration", "-of", "json", file],
    PROBE_TIMEOUT_MS,
  );
  return parseMergeProbe(output);
}

export function progressFromLine(line: string, duration: number | null): number | null {
  if (!duration) return null;
  const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
  if (!match) return null;
  const seconds = Number(match[1]) / 1_000_000;
  return Math.max(0, Math.min(99, Math.floor((seconds / duration) * 100)));
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function checkMerge(
  video: Probe,
  result: Probe,
  expected: { video: number; audio: number; subtitles: number },
): string | null {
  const count = (type: string) => result.streams.filter((stream) => stream.codecType === type).length;
  if (count("video") < expected.video || count("audio") < expected.audio || count("subtitle") < expected.subtitles) {
    return "The combined MKV is missing a stream, so it was not saved.";
  }
  if (video.duration && result.duration && Math.abs(video.duration - result.duration) > Math.max(5, video.duration * 0.02)) {
    return `The combined MKV runs ${Math.round(result.duration)} s but the video source runs ${Math.round(video.duration)} s, so it was not saved.`;
  }
  return null;
}

export async function mergeVersions(options: {
  videoPath: string;
  otherPath: string;
  workDir: string;
  skipFrameCheck?: boolean;
  frameCount?: number;
  dryRun?: boolean;
  onProgress: (percent: number, message: string) => void;
}): Promise<string> {
  const { videoPath, otherPath, workDir, onProgress } = options;
  const target = mergeTarget(videoPath);
  const name = path.basename(target);
  onProgress(0, "Reading both files");
  const [video, other] = await Promise.all([probe(videoPath), probe(otherPath)]);
  let startOffsetSeconds = 0;
  if (!options.skipFrameCheck) {
    onProgress(2, "Comparing frames");
    const frames = await compareFrames(videoPath, otherPath, {
      frameCount: options.frameCount,
      workDir: path.join(workDir, "frames"),
      onProgress: (done, total) => {
        const percent = 2 + Math.floor((done / Math.max(1, total)) * 8);
        onProgress(percent, `Comparing frames ${done}/${total}`);
      },
    });
    if (!frames.ok) throw new Error(frames.message);
    startOffsetSeconds = frames.startOffsetSeconds ?? 0;
  }
  const temp = path.join(workDir, name);
  const plan = mergeArgs(videoPath, otherPath, temp, video, other, startOffsetSeconds);
  const tracks = [plural(plan.video, "video stream"), plural(plan.audio, "audio track"), plan.subtitles ? plural(plan.subtitles, "subtitle") : null]
    .filter(Boolean)
    .join(", ");
  const flac = plan.converted ? ` ${plural(plan.converted, "PCM audio track")} ${plan.converted === 1 ? "is" : "are"} stored as lossless FLAC.` : "";
  const offsetBit =
    Math.abs(startOffsetSeconds) >= 2
      ? startOffsetSeconds > 0
        ? ` The other file's audio and subtitles are trimmed ${Math.round(startOffsetSeconds)} s to skip the extra open.`
        : ` The other file's audio and subtitles are delayed ${Math.round(Math.abs(startOffsetSeconds))} s to match the extra open.`
      : "";
  if (options.dryRun) return `Dry run: would keep video from ${path.basename(videoPath)} and copy ${tracks} into ${target}.${flac}${offsetBit} Nothing was written.`;
  if (fs.existsSync(target)) throw new Error(`${name} already exists next to the video source.`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  try {
    let lastWrite = 0;
    await runTool("ffmpeg", plan.args, MERGE_TIMEOUT_MS, (line) => {
      const percent = progressFromLine(line, video.duration);
      if (percent == null) return;
      const now = Date.now();
      if (now - lastWrite < 2_000) return;
      lastWrite = now;
      onProgress(Math.max(12, percent), `Combining ${Math.max(12, percent)}%`);
    });
    onProgress(99, "Checking the MKV");
    const problem = checkMerge(video, await probe(temp), plan);
    if (problem) throw new Error(problem);
    onProgress(100, "Saving the MKV");
    deliverFile(temp, target);
    return `Saved ${name} with ${tracks} (video from ${path.basename(videoPath)}).${flac}${offsetBit} Both originals were left in place.`;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
