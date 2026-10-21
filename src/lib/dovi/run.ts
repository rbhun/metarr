import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { deliverFile } from "@/lib/deliver";
import { idle } from "@/lib/idle";
import { doviProfileOf } from "@/lib/media";
import { removeWorkDir, watchStall } from "@/lib/stuck";

const PROBE_TIMEOUT_MS = 60_000;
const CONVERT_TIMEOUT_MS = 4 * 60 * 60 * 1000;
/** Audio may sit this far from where it sat against the picture in the source. */
const SYNC_TOLERANCE_S = 0.08;

export function doviTool(): string {
  return process.env.DOVI_TOOL?.trim() || "dovi_tool";
}

/** `Film.mkv` becomes `Film.DV8.mkv` beside it; the source stays. */
export function doviTarget(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  const stem = dot > slash ? filePath.slice(0, dot) : filePath;
  return `${stem.replace(/\.DV8$/i, "")}.DV8.mkv`;
}

export type DoviStream = {
  index: number;
  type: string;
  codec: string | null;
  start: number | null;
  frameRate: string | null;
  doviProfile: number | null;
};

export type DoviProbe = { duration: number | null; streams: DoviStream[] };

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseDoviProbe(text: string): DoviProbe {
  const body = JSON.parse(text) as { format?: { duration?: unknown }; streams?: unknown[] };
  const streams = (body.streams ?? []).flatMap((item) => {
    const stream = (item ?? {}) as Record<string, unknown>;
    const index = number(stream.index);
    if (index == null || typeof stream.codec_type !== "string") return [];
    const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
    const rate = typeof stream.r_frame_rate === "string" && /^\d+\/\d+$/.test(stream.r_frame_rate) && !stream.r_frame_rate.startsWith("0/") ? stream.r_frame_rate : null;
    return [
      {
        index,
        type: stream.codec_type,
        codec: typeof stream.codec_name === "string" ? stream.codec_name : null,
        start: number(stream.start_time),
        frameRate: rate,
        doviProfile: sideData.map((data) => doviProfileOf((data as { dv_profile?: unknown } | null)?.dv_profile)).find((profile) => profile != null) ?? null,
      },
    ];
  });
  return { duration: number(body.format?.duration), streams };
}

/**
 * The extracted video starts at zero. mkvmerge starts the source's other tracks from the earliest
 * stream in the file, so when audio started before the picture the video has to wait that long.
 */
export function videoDelayMs(probe: DoviProbe): number {
  const video = probe.streams.find((stream) => stream.type === "video");
  const starts = probe.streams.map((stream) => stream.start).filter((start): start is number => start != null);
  if (!video || video.start == null || !starts.length) return 0;
  return Math.max(0, Math.round((video.start - Math.min(...starts)) * 1000));
}

function audioLead(probe: DoviProbe): number | null {
  const video = probe.streams.find((stream) => stream.type === "video");
  const audio = probe.streams.find((stream) => stream.type === "audio");
  if (video?.start == null || audio?.start == null) return null;
  return audio.start - video.start;
}

/** The MKV must be Dolby Vision 8 with every audio track, the same length, and the audio where it was. */
export function checkDoviOutput(source: DoviProbe, output: DoviProbe): string | null {
  const video = output.streams.find((stream) => stream.type === "video");
  if (!video) return "The converted file has no video, so the original was left as the only copy.";
  if (video.doviProfile !== 8) {
    return video.doviProfile == null
      ? "The converted file carries no Dolby Vision, so the source probably had none to convert. The original was left as the only copy."
      : `The converted file is Dolby Vision ${video.doviProfile}, not 8, so the original was left as the only copy.`;
  }
  const count = (probe: DoviProbe, type: string) => probe.streams.filter((stream) => stream.type === type).length;
  if (count(output, "audio") < count(source, "audio")) {
    return `The converted file has ${count(output, "audio")} of the ${count(source, "audio")} audio tracks, so the original was left as the only copy.`;
  }
  if (source.duration && output.duration && Math.abs(source.duration - output.duration) > Math.max(2, source.duration * 0.01)) {
    return `The converted file runs ${Math.round(output.duration)} seconds instead of ${Math.round(source.duration)}, so the original was left as the only copy.`;
  }
  const before = audioLead(source);
  const after = audioLead(output);
  if (before != null && after != null && Math.abs(before - after) > SYNC_TOLERANCE_S) {
    return `The audio would move ${Math.round((after - before) * 1000)} ms against the picture, so the original was left as the only copy.`;
  }
  return null;
}

function lastLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^[a-z_]+=/.test(line))
    .slice(-3)
    .join(" ");
}

type Running = { child: ChildProcess; done: Promise<void> };

/** One tool at idle priority, watched for a NAS stall. Resolves on exit 0 (or 1 for mkvmerge warnings). */
function start(command: string, args: string[], options: { label: string; okCodes?: number[]; stdin?: boolean; stdout?: boolean; onLine?: (line: string) => void; timeoutMs?: number }): Running {
  const wrapped = idle(command, args);
  const child = spawn(wrapped.command, wrapped.args, { stdio: [options.stdin ? "pipe" : "ignore", options.stdout ? "pipe" : "ignore", "pipe"] });
  const done = new Promise<void>((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unwatch();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${options.label} ran longer than ${Math.round((options.timeoutMs ?? CONVERT_TIMEOUT_MS) / 60_000)} minutes and was stopped.`));
    }, options.timeoutMs ?? CONVERT_TIMEOUT_MS);
    const unwatch = watchStall(child.pid, options.label, (error) => {
      child.kill("SIGKILL");
      finish(error);
    });
    readline.createInterface({ input: child.stderr! }).on("line", (line) => {
      stderr = `${stderr}${line}\n`.slice(-20_000);
      options.onLine?.(line);
    });
    child.on("error", (error) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      finish(new Error(missing ? `${options.label} is not installed where Metarr runs. Rebuild the Docker image, which includes it.` : error.message));
    });
    child.on("close", (code, signal) => {
      if (code === 127) return finish(new Error(`${options.label} is not installed where Metarr runs. Rebuild the Docker image, which includes it.`));
      if (code != null && (code === 0 || options.okCodes?.includes(code))) return finish(null);
      const said = lastLines(stderr);
      const exit = code != null ? `exited with code ${code}` : `was stopped by ${signal ?? "a signal"}`;
      finish(new Error(said ? `${said} (${options.label} ${exit}.)` : `${options.label} ${exit}.`));
    });
  });
  return { child, done };
}

async function probe(file: string): Promise<DoviProbe> {
  const args = [
    "-v", "error",
    "-show_entries", "stream=index,codec_type,codec_name,start_time,r_frame_rate:stream_side_data=dv_profile:format=duration",
    "-of", "json", file,
  ];
  const wrapped = idle("ffprobe", args);
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(wrapped.command, wrapped.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffprobe took longer than a minute to read the file."));
    }, PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr = `${stderr}${chunk.toString()}`.slice(-4_000)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(lastLines(stderr) || `ffprobe exited with code ${code}.`));
    });
  });
  return parseDoviProbe(output);
}

/**
 * Rewrite Dolby Vision profile 7 (Blu-ray dual layer) as profile 8.1 in a new MKV beside the source.
 * The HDR10 picture is copied untouched; dovi_tool converts the Dolby Vision data and drops the
 * enhancement layer, which the Apple TV cannot use. Audio, subtitles, and chapters come from the source.
 */
export async function convertDolbyVision(options: {
  source: string;
  workDir: string;
  dryRun?: boolean;
  onProgress: (percent: number, message: string) => void;
}): Promise<string> {
  const { source, workDir, onProgress } = options;
  const target = doviTarget(source);
  const name = path.basename(target);
  const input = await probe(source);
  const videos = input.streams.filter((stream) => stream.type === "video");
  const main = videos[0];
  if (!main) throw new Error("This file has no video stream.");
  if (main.codec !== "hevc") throw new Error(`Dolby Vision conversion needs HEVC video; this file is ${main.codec ?? "an unknown codec"}.`);
  if (main.doviProfile != null && main.doviProfile !== 7) {
    return `Nothing to convert: this file is already Dolby Vision ${main.doviProfile}, which the Apple TV plays.`;
  }
  if (videos.length > 1 && videos.slice(1).some((stream) => stream.codec === "hevc")) {
    throw new Error("The Dolby Vision enhancement layer is a separate video track in this file. Metarr converts files with one video track; remux it with MakeMKV first, which joins the layers.");
  }
  if (fs.existsSync(target)) throw new Error(`${name} already exists next to the file.`);
  if (options.dryRun) {
    return `Dry run: would convert the Dolby Vision 7 video to 8.1 and save ${name} beside the file with every audio and subtitle track. Nothing was written.`;
  }

  removeWorkDir(workDir);
  fs.mkdirSync(workDir, { recursive: true });
  const video = path.join(workDir, "video.hevc");
  const muxed = path.join(workDir, name);
  try {
    onProgress(0, "Converting Dolby Vision");
    let lastWrite = 0;
    const extract = start(
      "ffmpeg",
      ["-hide_banner", "-v", "error", "-nostats", "-progress", "pipe:2", "-i", source, "-map", `0:${main.index}`, "-c:v", "copy", "-bsf:v", "hevc_mp4toannexb", "-f", "hevc", "pipe:1"],
      {
        label: "ffmpeg",
        stdout: true,
        onLine: (line) => {
          const match = /^out_time_us=(\d+)$/.exec(line.trim());
          if (!match || !input.duration) return;
          const now = Date.now();
          if (now - lastWrite < 2_000) return;
          lastWrite = now;
          const percent = Math.min(70, Math.floor((Number(match[1]) / 1_000_000 / input.duration) * 70));
          onProgress(percent, `Converting Dolby Vision ${Math.round((percent / 70) * 100)}%`);
        },
      },
    );
    const convert = start(doviTool(), ["-m", "2", "convert", "--discard", "-", "-o", video], { label: "dovi_tool", stdin: true });
    extract.child.stdout!.pipe(convert.child.stdin!);
    convert.child.stdin!.on("error", () => undefined);
    try {
      await Promise.all([extract.done, convert.done]);
    } catch (caught) {
      extract.child.kill("SIGKILL");
      convert.child.kill("SIGKILL");
      throw caught;
    }

    onProgress(70, "Saving the MKV");
    const delay = videoDelayMs(input);
    const mux = start(
      "mkvmerge",
      [
        "--gui-mode",
        "-o", muxed,
        ...(delay ? ["--sync", `0:${delay}`] : []),
        ...(main.frameRate ? ["--default-duration", `0:${main.frameRate}p`] : []),
        video,
        "--no-video", source,
      ],
      { label: "mkvmerge", okCodes: [1], stdout: true },
    );
    readline.createInterface({ input: mux.child.stdout! }).on("line", (line) => {
      const match = /^#GUI#progress (\d+)%/.exec(line.trim());
      if (match) onProgress(70 + Math.floor(Number(match[1]) * 0.25), `Saving the MKV ${match[1]}%`);
    });
    await mux.done;
    fs.rmSync(video, { force: true });

    onProgress(96, "Checking the MKV");
    const problem = checkDoviOutput(input, await probe(muxed));
    if (problem) throw new Error(problem);
    onProgress(99, "Moving the MKV beside the file");
    deliverFile(muxed, target);
    return `Saved ${name} with Dolby Vision 8.1 for the Apple TV. The HDR10 picture was copied untouched and every audio and subtitle track kept. The original was left in place.`;
  } finally {
    removeWorkDir(workDir);
  }
}
