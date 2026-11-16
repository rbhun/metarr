import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { deliverFile } from "@/lib/deliver";
import { idle } from "@/lib/idle";
import { removeWorkDir, watchStall } from "@/lib/stuck";
import { languageCode } from "@/lib/media";
import { killTool } from "@/lib/stuck-tools";
import { joinedTarget, rewrapFamily, rewrapTarget, sourceKind } from "@/lib/rewrap/source";

const REWRAP_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60_000;
/**
 * How long ffmpeg may hold packets so the streams line up, in microseconds.
 * 0 turns the cap off. A Blu-ray subtitle that only appears every few minutes then
 * keeps the whole movie in memory, and a 50 GB file is killed. 10 seconds is ffmpeg's own default.
 */
const INTERLEAVE_US = 10_000_000;
/**
 * Broadcast recordings often hold a few packets with no timestamp at a cut, and Matroska refuses
 * them ("Can't write packet with unknown timestamp") after hours of copying. This fills a missing
 * timestamp from the packet before; packets that have one pass through unchanged.
 */
const FILL_DTS = "if(eq(DTS,NOPTS),if(eq(PREV_OUTDTS,NOPTS),NOPTS,PREV_OUTDTS+max(max(DURATION,PREV_OUTDURATION),0.001/TB)),DTS)";
const FILL_TIMESTAMPS = `setts=dts='${FILL_DTS}':pts='if(eq(PTS,NOPTS),${FILL_DTS},PTS)'`;
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

const USER_DATA = Buffer.from([0x00, 0x00, 0x01, 0xb2]);

/**
 * True when a buffer holds a DivX/Xvid user-data string ending in "p", which marks
 * a B-frame packed into the frame before it.
 */
export function packedMarker(buffer: Buffer): boolean {
  let from = 0;
  while (from < buffer.length) {
    const at = buffer.indexOf(USER_DATA, from);
    if (at < 0) return false;
    const text = buffer.subarray(at + USER_DATA.length, Math.min(buffer.length, at + USER_DATA.length + 255));
    const end = text.indexOf(0);
    if (end > 0 && text[end - 1] === 0x70) return true;
    from = at + USER_DATA.length;
  }
  return false;
}

/** The marker is in the codec header or the first frames, so the start of the file is enough. */
export function fileHasPackedFrames(file: string): boolean {
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(2 * 1024 * 1024);
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return packedMarker(buffer.subarray(0, read));
  } catch {
    return false;
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * ffmpeg arguments that copy every video and audio stream (and subtitles Matroska can hold) into an MKV
 * without re-encoding. Audio in `firstLanguage` moves to the front and becomes the default track.
 */
export function rewrapArgs(
  input: string,
  output: string,
  probe: Probe,
  options: {
    languages: Array<string | null>;
    subtitleLanguages?: Array<string | null>;
    firstLanguage: string;
    concat?: boolean;
    /** The source is an MPEG transport stream (.ts, .m2ts, .mts). */
    transport?: boolean;
  },
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
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-fflags", "+genpts"];
  if (options.concat) args.push("-f", "concat", "-safe", "0");
  args.push("-i", input);
  for (const stream of video) args.push("-map", `0:${stream.index}`);
  for (const item of ordered) args.push("-map", `0:${item.stream.index}`);
  for (const item of subtitles) args.push("-map", `0:${item.stream.index}`);
  args.push("-c", "copy", "-map_metadata", "0", "-max_interleave_delta", String(INTERLEAVE_US));
  if (options.transport) args.push("-bsf:v", FILL_TIMESTAMPS, "-bsf:a", FILL_TIMESTAMPS, "-bsf:s", FILL_TIMESTAMPS);
  video.forEach((stream, position) => {
    // A B-frame packed into the frame before it stutters in Matroska unless it is split out.
    // Splitting it here, in the same command that invents timestamps, gives that B-frame the
    // later frame's time, so a pan jumps ahead and then back. Packed files are split into an
    // AVI first; this filter then finds nothing left to split.
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

/**
 * Copy into an AVI with each packed B-frame in its own slot, and do not invent timestamps.
 * An AVI can hold those frames without a time on each one. The MKV copy then times them in order.
 */
export function unpackArgs(input: string, output: string, concat: boolean): string[] {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  if (concat) args.push("-f", "concat", "-safe", "0");
  args.push("-i", input, "-map", "0", "-c", "copy", "-bsf:v", "mpeg4_unpack_bframes", "-progress", "pipe:1", "-nostats", "-f", "avi", output);
  return args;
}

/**
 * Windows of the picture to check, in ffprobe interval form. A logo at the start has no
 * packed B-frames, so a later pan is checked too. A file shorter than a window skips it.
 */
export function jumpIntervals(duration: number | null): string {
  const windows = ["%+5"];
  for (const start of [45, 180, 600, 1800]) {
    if (duration == null || duration < start + 8) continue;
    windows.push(`${start}%+5`);
  }
  return windows.join(",");
}

/** True when decoded frames step backwards, which is a pan jumping back a frame. */
export async function framesJumpBack(file: string): Promise<boolean> {
  let duration: number | null = null;
  try {
    const header = await runTool("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], PROBE_TIMEOUT_MS);
    const parsed = Number(header.trim().split(/\r?\n/).find((line) => line.trim()) ?? "");
    duration = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    duration = null;
  }
  const output = await runTool(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-read_intervals", jumpIntervals(duration), "-show_frames", "-show_entries", "frame=pts_time", "-of", "csv=p=0", file],
    PROBE_TIMEOUT_MS,
  );
  let previous: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim();
    if (!/^-?\d+(\.\d+)?$/.test(text)) continue;
    const value = Number(text);
    if (previous != null && value < previous - 0.015) return true;
    previous = value;
  }
  return false;
}

function freeBytes(directory: string): number | null {
  try {
    const space = fs.statfsSync(directory);
    return Number(space.bavail) * Number(space.bsize);
  } catch {
    return null;
  }
}

/** The unpacked AVI and the MKV are on disk together, so both have to fit. */
function roomToSplit(sources: string[], directory: string) {
  let bytes = 0;
  try {
    for (const file of sources) bytes += fs.statSync(file).size;
  } catch {
    bytes = 0;
  }
  const free = freeBytes(directory);
  if (bytes > 0 && free != null && free < bytes * 2 + 512 * 1024 * 1024) {
    throw new Error("There is not enough free space to split the packed frames before copying, so nothing was written.");
  }
}

const OUT_OF_ORDER = "The MKV would play frames out of order, so it was not saved.";

/** What to say when ffmpeg or ffprobe does not exit 0. A signal kill has no exit code. */
export function rewrapStop(command: string, code: number | null, signal: NodeJS.Signals | null): string {
  if (code != null) return `${command} exited with code ${code}.`;
  if (signal === "SIGKILL") return `${command} was killed (SIGKILL), usually because the machine ran out of memory.`;
  if (signal) return `${command} was stopped by ${signal}.`;
  return `${command} stopped without an exit code.`;
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
      unwatch();
      reject(error);
    };
    const timer = setTimeout(() => {
      killTool(child, command, args);
      fail(new Error(`${command} ran longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`));
    }, timeoutMs);
    const unwatch = watchStall(child.pid, command, (error) => {
      child.kill("SIGKILL");
      fail(error);
    });
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
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unwatch();
      if (code === 0) {
        resolve(stdout);
        return;
      }
      if (code === 127) {
        reject(new Error(`${command} was not found where Metarr runs. Rebuild the Docker image, which includes ffmpeg.`));
        return;
      }
      const said = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join(" ");
      const exit = rewrapStop(command, code, signal);
      if (said && code != null) {
        reject(new Error(said));
        return;
      }
      reject(new Error(said ? `${said} (${exit})` : exit));
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
    const verb = kind === "parts" ? "run" : "runs";
    return `The MKV runs ${Math.round(result.duration)} s but the ${kind} ${verb} ${Math.round(source.duration)} s, so it was not saved.`;
  }
  return null;
}

function streamSignature(probe: Probe): string {
  return probe.streams.map((stream) => `${stream.codecType}:${stream.codecName ?? ""}`).join("|");
}

function concatList(files: string[]): string {
  return `${files.map((file) => `file '${file.replace(/'/g, `'\\''`)}'`).join("\n")}\n`;
}

/** Write recognized languages onto audio streams already stored in an MKV. Returns how many streams were tagged. */
export async function tagMkvLanguages(file: string, languages: Array<string | null>): Promise<number> {
  const args = [file];
  languages.forEach((language, ordinal) => {
    const code = language ? languageCode(language) : null;
    if (!code) return;
    args.push("--edit", `track:a${ordinal + 1}`, "--set", `language=${code}`);
  });
  if (args.length === 1) return 0;
  await runTool("mkvpropedit", args, 60_000);
  return languages.filter((language) => (language ? languageCode(language) : null)).length;
}

export async function rewrapAvi(options: {
  source: string;
  /** Ordered parts of one labeled split. A single source is copied under its own name. */
  sources?: string[];
  workDir: string;
  languages: Array<string | null>;
  subtitleLanguages?: Array<string | null>;
  firstLanguage: string;
  dryRun?: boolean;
  /** Write over an MKV that is already there. Used when that copy plays frames out of order. */
  replace?: boolean;
  onProgress: (percent: number, message: string) => void;
}): Promise<string> {
  const { source, workDir, onProgress } = options;
  const sources = options.sources && options.sources.length > 1 ? options.sources : [source];
  const joining = sources.length > 1;
  const kind = sourceKind(source);
  const target = (joining ? joinedTarget(sources[0] ?? source) : null) ?? rewrapTarget(source);
  const name = path.basename(target);
  onProgress(0, joining ? `Reading ${sources.length} parts` : `Reading the ${kind}`);
  const probed = [];
  for (const file of sources) probed.push(await probe(file));
  const first = probed[0];
  if (!first) throw new Error("ffprobe found no video stream in this file.");
  const signature = streamSignature(first);
  if (probed.some((item) => streamSignature(item) !== signature)) {
    throw new Error("The parts do not share the same video and audio, so they were not joined.");
  }
  const duration = probed.reduce((sum, item) => sum + (item.duration ?? 0), 0);
  const input: Probe = { streams: first.streams, duration: duration > 0 ? duration : null };
  const packed = rewrapFamily(source) === "avi" && sources.some((file) => fileHasPackedFrames(file));
  const listPath = path.join(workDir, "parts.txt");
  const unpacked = path.join(workDir, "unpacked.avi");
  const temp = path.join(workDir, name);
  const plan = rewrapArgs(packed ? unpacked : joining ? listPath : source, temp, input, {
    languages: options.languages,
    subtitleLanguages: options.subtitleLanguages,
    firstLanguage: options.firstLanguage,
    concat: packed ? false : joining,
    transport: rewrapFamily(source) === "ts",
  });
  const tracks = [plural(plan.video, "video stream"), plural(plan.audio, "audio track"), plan.subtitles ? plural(plan.subtitles, "subtitle") : null]
    .filter(Boolean)
    .join(", ");
  const moved = plan.firstMoved ? ` ${options.firstLanguage} audio goes first.` : "";
  const flac = plan.converted ? ` ${plural(plan.converted, "PCM audio track")} ${plan.converted === 1 ? "is" : "are"} stored as lossless FLAC.` : "";
  const joined = joining ? ` Joined from ${sources.length} parts.` : "";
  let ordered = packed ? " The picture frames stay in order." : "";
  if (options.dryRun) {
    const action = joining ? `join ${sources.length} parts and copy` : "copy";
    const split = packed ? " Packed frames are split apart first so the picture stays in order." : "";
    return `Dry run: would ${action} ${tracks} into ${target} without re-encoding.${moved}${flac}${split} Nothing was written.`;
  }
  if (!options.replace && fs.existsSync(target)) throw new Error(`${name} already exists next to the ${kind}.`);
  removeWorkDir(workDir);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    if (joining) fs.writeFileSync(listPath, concatList(sources));
    let lastWrite = 0;
    const report = (line: string, message: (percent: number) => string) => {
      const percent = progressFromLine(line, input.duration);
      if (percent == null) return;
      const now = Date.now();
      if (now - lastWrite < 2_000) return;
      lastWrite = now;
      onProgress(percent, message(percent));
    };
    const splitPacked = async () => {
      roomToSplit(sources, workDir);
      onProgress(0, "Splitting packed frames");
      await runTool("ffmpeg", unpackArgs(joining ? listPath : source, unpacked, joining), REWRAP_TIMEOUT_MS, (line) => {
        report(line, (percent) => `Splitting packed frames ${percent}%`);
      });
    };
    if (packed) await splitPacked();
    await runTool("ffmpeg", plan.args, REWRAP_TIMEOUT_MS, (line) => {
      report(line, (percent) => `Rewrapping ${percent}%`);
    });
    onProgress(99, "Checking the MKV");
    const problem = checkRewrap(input, await probe(temp), plan, joining ? "parts" : kind);
    if (problem) throw new Error(problem);
    const mpeg4 = rewrapFamily(source) === "avi" && input.streams.some((stream) => stream.codecType === "video" && stream.codecName === "mpeg4");
    // The DivX "p" mark is not on every packed file. Xvid can store the next B-frame in the
    // previous one without that text, and one copy then gives the B-frame the later time.
    // A Mac player reorders from the picture data. Apple TV converts from these times.
    if ((packed || mpeg4) && (await framesJumpBack(temp))) {
      if (packed) throw new Error(OUT_OF_ORDER);
      await splitPacked();
      fs.rmSync(temp, { force: true });
      const again = rewrapArgs(unpacked, temp, input, {
        languages: options.languages,
        subtitleLanguages: options.subtitleLanguages,
        firstLanguage: options.firstLanguage,
        concat: false,
      });
      await runTool("ffmpeg", again.args, REWRAP_TIMEOUT_MS, (line) => {
        report(line, (percent) => `Rewrapping ${percent}%`);
      });
      const retry = checkRewrap(input, await probe(temp), again, joining ? "parts" : kind);
      if (retry) throw new Error(retry);
      if (await framesJumpBack(temp)) throw new Error(OUT_OF_ORDER);
      ordered = " The picture frames stay in order.";
    }
    onProgress(100, "Saving the MKV");
    deliverFile(temp, target, { replace: options.replace });
    const left = joining ? `The ${kind} files were left in place.` : `The ${kind} was left in place.`;
    const verb = options.replace ? "Replaced" : "Saved";
    return `${verb} ${name} with ${tracks}.${joined}${moved}${flac}${ordered} ${left}`;
  } finally {
    removeWorkDir(workDir);
  }
}
