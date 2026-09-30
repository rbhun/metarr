import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { deliverFile } from "@/lib/deliver";
import { idle } from "@/lib/idle";
import { languageCode } from "@/lib/media";
import { rewrapTarget, sourceKind } from "@/lib/rewrap/source";

const REWRAP_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60_000;
/** Subtitle formats Matroska can hold as they are. */
const MKV_SUBTITLES = new Set(["subrip", "srt", "ass", "ssa", "dvd_subtitle", "text", "hdmv_pgs_subtitle", "dvb_subtitle"]);
/** Blu-ray PCM has no Matroska mapping; FLAC keeps it lossless. */
const LOSSLESS_AUDIO: Record<string, string> = { pcm_bluray: "flac", pcm_dvd: "flac" };

export type ProbeStream = { index: number; codecType: string; codecName: string | null };
export type Probe = { streams: ProbeStream[]; duration: number | null };

export function parseProbe(json: string): Probe {
  const value = JSON.parse(json) as {
    streams?: Array<{ index?: number; codec_type?: string; codec_name?: string }>;
    format?: { duration?: string };
  };
  const streams = (value.streams ?? [])
    .filter((stream) => typeof stream.index === "number" && typeof stream.codec_type === "string")
    .map((stream) => ({ index: stream.index as number, codecType: stream.codec_type as string, codecName: stream.codec_name ?? null }));
  const duration = Number(value.format?.duration);
  return { streams, duration: Number.isFinite(duration) && duration > 0 ? duration : null };
}

/**
 * ffmpeg arguments that copy every video and audio stream (and subtitles Matroska can hold) into an MKV
 * without re-encoding. Audio in `firstLanguage` moves to the front and becomes the default track.
 */
export function rewrapArgs(
  input: string,
  output: string,
  probe: Probe,
  options: { languages: Array<string | null>; subtitleLanguages?: Array<string | null>; firstLanguage: string },
): { args: string[]; video: number; audio: number; subtitles: number; firstMoved: boolean; converted: number } {
  const video = probe.streams.filter((stream) => stream.codecType === "video");
  const audio = probe.streams
    .filter((stream) => stream.codecType === "audio")
    .map((stream, ordinal) => ({ stream, code: options.languages[ordinal] ? languageCode(options.languages[ordinal]!) : null }));
  const subtitleLanguages = options.subtitleLanguages ?? [];
  const subtitles = probe.streams
    .filter((stream) => stream.codecType === "subtitle")
    .map((stream, ordinal) => ({ stream, code: subtitleLanguages[ordinal] ? languageCode(subtitleLanguages[ordinal]!) : null }))
    .filter((item) => MKV_SUBTITLES.has(item.stream.codecName ?? ""));
  if (video.length === 0) throw new Error("ffprobe found no video stream in this file.");
  const first = options.firstLanguage ? languageCode(options.firstLanguage) : null;
  const ordered = first ? [...audio.filter((item) => item.code === first), ...audio.filter((item) => item.code !== first)] : audio;
  const firstMoved = ordered.length > 0 && ordered[0] !== audio[0];
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-i", input];
  for (const stream of video) args.push("-map", `0:${stream.index}`);
  for (const item of ordered) args.push("-map", `0:${item.stream.index}`);
  for (const item of subtitles) args.push("-map", `0:${item.stream.index}`);
  args.push("-c", "copy", "-map_metadata", "0", "-max_interleave_delta", "0");
  video.forEach((stream, position) => {
    // Xvid/DivX "packed B-frames" stutter in Matroska unless they are unpacked.
    if (stream.codecName === "mpeg4") args.push(`-bsf:v:${position}`, "mpeg4_unpack_bframes");
  });
  let converted = 0;
  ordered.forEach((item, position) => {
    const lossless = LOSSLESS_AUDIO[item.stream.codecName ?? ""];
    if (lossless) {
      args.push(`-c:a:${position}`, lossless);
      converted += 1;
    }
    if (item.code) args.push(`-metadata:s:a:${position}`, `language=${item.code}`);
    args.push(`-disposition:a:${position}`, position === 0 ? "default" : "0");
  });
  subtitles.forEach((item, position) => {
    if (item.code) args.push(`-metadata:s:s:${position}`, `language=${item.code}`);
  });
  args.push("-progress", "pipe:1", "-nostats", "-f", "matroska", output);
  return { args, video: video.length, audio: ordered.length, subtitles: subtitles.length, firstMoved, converted };
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
    ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name:format=duration", "-of", "json", file],
    PROBE_TIMEOUT_MS,
  );
  return parseProbe(output);
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

/** The copy must hold the same streams and nearly the same length, or the source stays the only file. */
export function checkRewrap(source: Probe, result: Probe, expected: { video: number; audio: number; subtitles: number }, kind = "AVI"): string | null {
  const count = (type: string) => result.streams.filter((stream) => stream.codecType === type).length;
  if (count("video") < expected.video || count("audio") < expected.audio || count("subtitle") < expected.subtitles) {
    return `The MKV is missing a stream from the ${kind}, so it was not saved.`;
  }
  if (source.duration && result.duration && Math.abs(source.duration - result.duration) > Math.max(5, source.duration * 0.02)) {
    return `The MKV runs ${Math.round(result.duration)} s but the ${kind} runs ${Math.round(source.duration)} s, so it was not saved.`;
  }
  return null;
}

export async function rewrapAvi(options: {
  source: string;
  workDir: string;
  languages: Array<string | null>;
  subtitleLanguages?: Array<string | null>;
  firstLanguage: string;
  dryRun?: boolean;
  onProgress: (percent: number, message: string) => void;
}): Promise<string> {
  const { source, workDir, onProgress } = options;
  const kind = sourceKind(source);
  const target = rewrapTarget(source);
  const name = path.basename(target);
  onProgress(0, `Reading the ${kind}`);
  const input = await probe(source);
  const temp = path.join(workDir, name);
  const plan = rewrapArgs(source, temp, input, {
    languages: options.languages,
    subtitleLanguages: options.subtitleLanguages,
    firstLanguage: options.firstLanguage,
  });
  const tracks = [plural(plan.video, "video stream"), plural(plan.audio, "audio track"), plan.subtitles ? plural(plan.subtitles, "subtitle") : null]
    .filter(Boolean)
    .join(", ");
  const moved = plan.firstMoved ? ` ${options.firstLanguage} audio goes first.` : "";
  const flac = plan.converted ? ` ${plural(plan.converted, "PCM audio track")} ${plan.converted === 1 ? "is" : "are"} stored as lossless FLAC.` : "";
  if (options.dryRun) return `Dry run: would copy ${tracks} into ${target} without re-encoding.${moved}${flac} Nothing was written.`;
  if (fs.existsSync(target)) throw new Error(`${name} already exists next to the ${kind}.`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  try {
    let lastWrite = 0;
    await runTool("ffmpeg", plan.args, REWRAP_TIMEOUT_MS, (line) => {
      const percent = progressFromLine(line, input.duration);
      if (percent == null) return;
      const now = Date.now();
      if (now - lastWrite < 2_000) return;
      lastWrite = now;
      onProgress(percent, `Rewrapping ${percent}%`);
    });
    onProgress(99, "Checking the MKV");
    const problem = checkRewrap(input, await probe(temp), plan, kind);
    if (problem) throw new Error(problem);
    onProgress(100, "Saving the MKV");
    deliverFile(temp, target);
    return `Saved ${name} with ${tracks}.${moved}${flac} The ${kind} was left in place.`;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
