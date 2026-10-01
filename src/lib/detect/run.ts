import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { audioClipArgs, audioCopyArgs, audioDecodeArgs, audioPid, audioSliceArgs, clipStart, dialogueMix, isExceptionallyShortClip, isShortSpan, isTransportStream, languageFromProbeTags, markerWindow, openingWindow, packetBytes, pcmIsSilent, pidActivity, sampleOffsets, tsWindow, wavSeconds } from "@/lib/detect/audio";
import { agreeLanguage } from "@/lib/detect/agree";
import { commentaryRole } from "@/lib/detect/commentary";
import { cueCount, cueText } from "@/lib/detect/cues";
import { isForcedCueCount } from "@/lib/detect/forced";
import type { DetectJob } from "@/lib/detect/store";
import { readPgsImages, scaleBitmap, writePng } from "@/lib/detect/pgs";
import { cueSampleStarts, pgsCopyArgs, pgsDemuxArgs, pgsSliceArgs, vobsubCanvasSize, vobsubExtractArgs } from "@/lib/detect/picture";
import { isPictureSubtitle } from "@/lib/detect/targets";
import { decodeSubtitleBytes } from "@/lib/detect/encoding";
import { isSubtitleFile } from "@/lib/detect/sidecars";
import { subtitleSampleIsText } from "@/lib/detect/subtitle-name";
import { detectTextLanguage } from "@/lib/detect/text-language";
import { idle } from "@/lib/idle";
import { languageName } from "@/lib/media";

export type DetectionOutcome = {
  language: string | null;
  role: "commentary" | "forced" | "short" | null;
  confidence: number;
  message: string | null;
  source?: "file" | null;
};

const limitedEnv = { ...process.env, OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1" };

function runCommand(command: string, args: string[], timeout = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const low = idle(command, args);
    execFile(low.command, low.args, { timeout, maxBuffer: 2 * 1024 * 1024, env: limitedEnv }, (error, stdout, stderr) => {
      const out = stdout?.toString() ?? "";
      const err = stderr?.toString() ?? "";
      if (error) {
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        const timedOut = "killed" in error && error.killed;
        const detail = err
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("_STATISTICS_"))
          .slice(-4)
          .join(" ");
        reject(new Error(missing ? `${command} is not installed.` : timedOut ? `${command} timed out.` : detail || error.message));
        return;
      }
      resolve({ stdout: out, stderr: err });
    });
  });
}

function secondsOf(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function probeAudio(
  file: string,
  ordinal: number,
  quick = false,
): Promise<{
  duration: number | null;
  start: number | null;
  layout: string | null;
  channels: number | null;
  language: string | null;
  streamDuration: number | null;
  pid: number | null;
}> {
  const empty = { duration: null, start: null, layout: null, channels: null, language: null, streamDuration: null, pid: null };
  try {
    const { stdout } = await runCommand(
      "ffprobe",
      [
        "-v",
        "error",
        ...(quick ? ["-probesize", "8000000", "-analyzeduration", "2000000"] : []),
        "-show_entries",
        "format=duration,start_time:stream=codec_type,start_time,duration,channel_layout,channels,id:stream_tags=language",
        "-of",
        "json",
        file,
      ],
      quick ? 15_000 : 30_000,
    );
    const body = JSON.parse(stdout) as {
      format?: { duration?: unknown; start_time?: unknown };
      streams?: Array<{ codec_type?: unknown; start_time?: unknown; duration?: unknown; channel_layout?: unknown; channels?: unknown; id?: unknown; tags?: unknown }>;
    };
    const audio = (body.streams ?? []).filter((stream) => stream.codec_type === "audio")[ordinal];
    const duration = secondsOf(body.format?.duration);
    return {
      duration: duration != null && duration > 0 ? duration : null,
      start: secondsOf(audio?.start_time) ?? secondsOf(body.format?.start_time),
      layout: typeof audio?.channel_layout === "string" ? audio.channel_layout : null,
      channels: typeof audio?.channels === "number" ? audio.channels : null,
      language: languageFromProbeTags(audio?.tags),
      streamDuration: secondsOf(audio?.duration),
      pid: audioPid(audio?.id),
    };
  } catch {
    return empty;
  }
}

async function durationSeconds(file: string): Promise<number | null> {
  const probed = await probeAudio(file, 0);
  return probed.duration;
}

type Speech = { language: string; probability: number; text: string };

let whisper: ChildProcessWithoutNullStreams | null = null;
let whisperLines: readline.Interface | null = null;
let whisperWaiter: { resolve: (speech: Speech) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;

function resetWhisper(error?: Error) {
  whisperLines?.close();
  whisper?.kill();
  whisper = null;
  whisperLines = null;
  if (whisperWaiter) {
    clearTimeout(whisperWaiter.timer);
    whisperWaiter.reject(error ?? new Error("Whisper stopped."));
    whisperWaiter = null;
  }
}

function whisperScript(): string {
  return path.join(process.cwd(), "scripts", "detect_speech.py");
}

function ensureWhisper(): ChildProcessWithoutNullStreams {
  if (whisper && whisper.exitCode == null && !whisper.killed) return whisper;
  const script = whisperScript();
  if (!fs.existsSync(script)) throw new Error("Whisper script is missing.");
  const command = process.env.WHISPER_PYTHON || "python3";
  const low = idle(command, [script]);
  const child = spawn(low.command, low.args, { stdio: ["pipe", "pipe", "pipe"], env: limitedEnv });
  child.on("error", (error) => {
    resetWhisper(error);
  });
  child.stdin.on("error", () => undefined);
  child.stdout.on("error", () => undefined);
  child.stderr.on("error", () => undefined);
  whisper = child;
  whisperLines = readline.createInterface({ input: child.stdout });
  whisperLines.on("error", () => undefined);
  let startup = "";
  child.stderr.on("data", (chunk: Buffer) => {
    startup = `${startup}${chunk.toString()}`.slice(-2000);
  });
  child.on("exit", () => {
    const detail = /No module named ['"]faster_whisper['"]/.test(startup)
      ? "faster-whisper is not installed. Use a Python that has it, or set WHISPER_PYTHON."
      : "Whisper stopped.";
    resetWhisper(new Error(detail));
  });
  whisperLines.on("line", (line) => {
    const waiter = whisperWaiter;
    whisperWaiter = null;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    try {
      const body = JSON.parse(line) as { error?: string; language?: string; probability?: number; text?: string };
      if (body.error) {
        waiter.reject(new Error(body.error));
        return;
      }
      waiter.resolve({
        language: typeof body.language === "string" ? body.language : "",
        probability: typeof body.probability === "number" ? body.probability : 0,
        text: typeof body.text === "string" ? body.text : "",
      });
    } catch (caught) {
      waiter.reject(caught instanceof Error ? caught : new Error("Whisper returned an unreadable result."));
    }
  });
  return child;
}

function ffmpegSlice(file: string, start: number, end: number, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const low = idle("ffmpeg", args);
    const child: ChildProcess = spawn(low.command, low.args, {
      stdio: ["pipe", "ignore", "pipe"],
      env: limitedEnv,
    });
    const reader = fs.createReadStream(file, { start, end: Math.max(start, end - 1) });
    let stderr = "";
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader.destroy();
      child.stdin?.destroy();
      if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => settle(new Error("ffmpeg timed out.")), timeout);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.stdin?.on("error", () => undefined);
    reader.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
      settle(error);
    });
    child.on("error", (error) => settle(error));
    if (child.stdin) reader.pipe(child.stdin);
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        settle();
        return;
      }
      const detail = stderr
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("_STATISTICS_"))
        .slice(-4)
        .join(" ");
      settle(new Error(detail || "ffmpeg could not read the audio slice."));
    });
  });
}

function transcribe(wav: string): Promise<Speech> {
  const child = ensureWhisper();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resetWhisper(new Error("Whisper timed out."));
      reject(new Error("Whisper timed out."));
    }, 180_000);
    whisperWaiter = { resolve, reject, timer };
    child.stdin.write(`${JSON.stringify({ wav })}\n`);
  });
}

function readWindow(file: string, window: { start: number; end: number }): Buffer {
  const length = window.end - window.start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    const read = fs.readSync(fd, buffer, 0, length, window.start);
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function trackIsShort(
  file: string,
  heard: { duration: number | null; streamDuration: number | null; pid: number | null },
): boolean {
  if (!isTransportStream(file)) return isShortSpan(heard.streamDuration, heard.duration);
  if (heard.pid == null) return false;
  try {
    const size = fs.statSync(file).size;
    const packet = packetBytes(file);
    const opening = openingWindow(size, packet);
    if (!opening) return false;
    const open = pidActivity(readWindow(file, opening), packet, heard.pid);
    if (!open.ended) return false;
    const laterAt = sampleOffsets(heard.duration)[0];
    const later = laterAt == null ? null : markerWindow(size, heard.duration, laterAt, packet);
    if (!later) return false;
    if (pidActivity(readWindow(file, later), packet, heard.pid).packets > 0) return false;
    if (open.span != null) return isShortSpan(open.span, heard.duration);
    return open.packets > 0 && open.packets < 500 && (heard.duration == null || heard.duration >= 120);
  } catch {
    return false;
  }
}

async function detectAudio(job: DetectJob, file: string): Promise<DetectionOutcome> {
  const transport = isTransportStream(file);
  const heard = await probeAudio(file, job.ordinal, transport);
  const short = trackIsShort(file, heard);
  if (heard.language || short) {
    return {
      language: heard.language,
      role: short ? "short" : null,
      confidence: heard.language ? 1 : 0,
      message: heard.language ? null : "This track is only a moment long.",
      source: heard.language ? "file" : null,
    };
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-audio-"));
  try {
    const mix = dialogueMix(heard.layout, heard.channels);
    const fileSize = transport ? fs.statSync(file).size : 0;
    const samples: Array<{ language: string; probability: number }> = [];
    const transcript: string[] = [];
    let agreed = { language: null as string | null, confidence: 0 };
    let readSample = false;
    let silent = false;
    let shortClip = false;
    const present = (target: string, minimum: number) => fs.existsSync(target) && fs.statSync(target).size >= minimum;
    const hearFile = async (wav: string): Promise<"timeout" | "heard"> => {
      if (!present(wav, 8_000)) return "heard";
      const audio = fs.readFileSync(wav);
      if (isExceptionallyShortClip(wavSeconds(audio))) {
        shortClip = true;
        return "heard";
      }
      if (pcmIsSilent(audio)) {
        silent = true;
        return "heard";
      }
      readSample = true;
      const speech = await transcribe(wav);
      if (speech.language) samples.push({ language: speech.language, probability: speech.probability });
      if (speech.text) transcript.push(speech.text);
      agreed = agreeLanguage(samples);
      return "heard";
    };
    const listenSlice = async (window: { start: number; end: number } | null, index: number): Promise<"timeout" | "heard"> => {
      const wav = path.join(directory, `clip-${index}.wav`);
      if (!window) return "heard";
      let sawTimeout = false;
      for (const filter of mix ? [mix, null] : [null]) {
        try {
          await ffmpegSlice(file, window.start, window.end, audioSliceArgs(job.ordinal, wav, filter), 45_000);
          if (present(wav, 8_000)) break;
        } catch (caught) {
          if (caught instanceof Error && /timed out/.test(caught.message)) {
            sawTimeout = true;
            continue;
          }
        }
      }
      if (!present(wav, 8_000) && sawTimeout) return "timeout";
      return hearFile(wav);
    };
    const listen = async (offset: number, index: number): Promise<"timeout" | "heard"> => {
      const copied = path.join(directory, `clip-${index}.mka`);
      const wav = path.join(directory, `clip-${index}.wav`);
      if (transport) {
        return listenSlice(tsWindow(fileSize, heard.duration, offset, packetBytes(file)), index);
      } else {
        try {
          await runCommand("ffmpeg", audioCopyArgs(file, job.ordinal, offset, copied), 45_000);
        } catch (caught) {
          if (caught instanceof Error && /timed out/.test(caught.message)) return "timeout";
        }
        const source = present(copied, 1_000) ? copied : null;
        for (const filter of mix ? [mix, null] : [null]) {
          try {
            const args = source
              ? audioDecodeArgs(source, wav, filter)
              : audioClipArgs(file, job.ordinal, offset, wav, filter);
            await runCommand("ffmpeg", args, source ? 20_000 : 45_000);
            break;
          } catch (caught) {
            if (caught instanceof Error && /timed out/.test(caught.message)) return "timeout";
          }
        }
      }
      return hearFile(wav);
    };
    let timedOut = false;
    for (const [index, offset] of sampleOffsets(heard.duration).entries()) {
      const outcome = await listen(transport ? offset : clipStart(offset, heard.start), index);
      if (outcome === "timeout") {
        timedOut = true;
        continue;
      }
      if (agreed.language && transcript.join(" ").trim().length >= 80) break;
    }
    if (transport && samples.length === 0 && !readSample) {
      const outcome = await listenSlice(openingWindow(fileSize, packetBytes(file)), sampleOffsets(heard.duration).length);
      if (outcome === "timeout") timedOut = true;
    }
    if (samples.length === 0) {
      const message = shortClip
        ? "This track is only a moment long."
        : readSample
          ? "No speech found in the sample."
          : silent
            ? "This track is silent."
            : timedOut
              ? "The audio sample could not be read in time."
              : "This track has no audio to hear.";
      return { language: null, role: shortClip ? "short" : null, confidence: 0, message };
    }
    const language = agreed.language ? languageName(agreed.language) : null;
    const role = commentaryRole(job.streamLabel, transcript.join(" "));
    return {
      language,
      role,
      confidence: agreed.confidence,
      message: language ? null : "This language cannot be reliably recognized.",
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const OCR_ORDER = ["eng", "hun", "fra", "spa", "deu", "ita"];

async function ocrLanguages(): Promise<string[]> {
  const { stdout, stderr } = await runCommand("tesseract", ["--list-langs"], 20_000);
  const installed = new Set(`${stdout}\n${stderr}`.split("\n").map((line) => line.trim()).filter((line) => /^[a-z0-9_]+$/i.test(line) && line !== "osd"));
  const chosen = OCR_ORDER.filter((language) => installed.has(language));
  return chosen.length ? chosen : [...installed].slice(0, 1);
}

function spread<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) => items[Math.min(items.length - 1, Math.floor(((index + 0.5) * items.length) / limit))] as T);
}

function clearDirectory(directory: string) {
  for (const name of fs.readdirSync(directory)) fs.rmSync(path.join(directory, name), { force: true });
}

async function subtitleCues(file: string, ordinal: number): Promise<{ starts: number[]; count: number }> {
  try {
    const { stdout } = await runCommand(
      "ffprobe",
      ["-v", "error", "-select_streams", `s:${ordinal}`, "-show_entries", "packet=pts_time,size", "-of", "csv=p=0", file],
      60_000,
    );
    const times: number[] = [];
    for (const line of stdout.split("\n")) {
      const [pts, size] = line.split(",");
      const time = Number(pts);
      const bytes = Number(size);
      if (!Number.isFinite(time) || time < 0) continue;
      if (!Number.isFinite(bytes) || bytes < 500) continue;
      times.push(time);
    }
    return { starts: cueSampleStarts(times).map((time) => Math.max(0, time - 1)), count: times.length };
  } catch {
    return { starts: [], count: 0 };
  }
}

/**
 * A disc stream has no index, so `-ss` reads the picture from the start of the file.
 * There each window is a byte slice piped into ffmpeg, like the audio samples.
 * A slow window does not stop the others; only all of them timing out counts.
 */
async function collectPgs(
  file: string,
  ordinal: number,
  directory: string,
  starts: number[],
  seconds: number,
  duration: number | null,
): Promise<{ bitmaps: ReturnType<typeof readPgsImages>; timedOut: boolean }> {
  const sup = path.join(directory, "track.sup");
  const bitmaps = [];
  const transport = isTransportStream(file);
  const size = transport ? fs.statSync(file).size : 0;
  let tried = 0;
  let timeouts = 0;
  for (const start of starts) {
    clearDirectory(directory);
    const window = transport ? tsWindow(size, duration, start, packetBytes(file), seconds) : null;
    if (transport && !window) continue;
    tried += 1;
    try {
      if (window) await ffmpegSlice(file, window.start, window.end, pgsSliceArgs(ordinal, sup), 90_000);
      else await runCommand("ffmpeg", pgsCopyArgs(file, ordinal, start, sup, seconds), 90_000);
    } catch (error) {
      const failed = error instanceof Error ? error : new Error(String(error));
      if (/timed out/i.test(failed.message)) timeouts += 1;
      else if (!transport && !/empty|nothing was written/i.test(failed.message)) throw failed;
    }
    if (fs.existsSync(sup) && fs.statSync(sup).size >= 32) {
      bitmaps.push(...readPgsImages(fs.readFileSync(sup), 12));
      fs.rmSync(sup, { force: true });
    }
    if (bitmaps.length >= 4) break;
  }
  return { bitmaps, timedOut: tried > 0 && timeouts === tried };
}

/** An indexed file can hand over the whole PGS track. A disc stream has to be sliced. */
async function demuxPgsTrack(file: string, ordinal: number, directory: string): Promise<{ bitmaps: ReturnType<typeof readPgsImages>; timedOut: boolean }> {
  const sup = path.join(directory, "track.sup");
  clearDirectory(directory);
  try {
    await runCommand("ffmpeg", pgsDemuxArgs(file, ordinal, sup), 120_000);
  } catch (error) {
    const failed = error instanceof Error ? error : new Error(String(error));
    if (/timed out/i.test(failed.message)) return { bitmaps: [], timedOut: true };
    if (/empty|nothing was written/i.test(failed.message)) return { bitmaps: [], timedOut: false };
    throw failed;
  }
  if (!fs.existsSync(sup) || fs.statSync(sup).size < 32) return { bitmaps: [], timedOut: false };
  const bitmaps = readPgsImages(fs.readFileSync(sup), 24);
  fs.rmSync(sup, { force: true });
  return { bitmaps, timedOut: false };
}

async function pgsFrames(file: string, ordinal: number, directory: string): Promise<{ frames: string[]; forced: boolean }> {
  const duration = await durationSeconds(file);
  let bitmaps: ReturnType<typeof readPgsImages> = [];
  let timedOut = false;
  let cues = 0;
  if (!isTransportStream(file)) {
    ({ bitmaps, timedOut } = await demuxPgsTrack(file, ordinal, directory));
  }
  if (bitmaps.length < 4 && !timedOut) {
    const windowed = await collectPgs(file, ordinal, directory, sampleOffsets(duration), isTransportStream(file) ? 30 : 45, duration);
    bitmaps.push(...windowed.bitmaps);
    timedOut = windowed.timedOut;
  }
  if (bitmaps.length < 4 && !timedOut) {
    const found = await subtitleCues(file, ordinal);
    cues = found.count;
    if (bitmaps.length === 0 && found.starts.length > 0) {
      const atCues = await collectPgs(file, ordinal, directory, found.starts, 8, duration);
      bitmaps.push(...atCues.bitmaps);
      timedOut = atCues.timedOut;
    }
  }
  if (bitmaps.length === 0 && timedOut) {
    throw new Error("Reading subtitle images from this file took too long every time. The share may have been slow; Redo tries again.");
  }
  const frames = spread(bitmaps, 8).map((bitmap) => scaleBitmap(bitmap, 3));
  frames.forEach((image, index) => writePng(path.join(directory, `cue-${index}.png`), image));
  return {
    frames: frames.length ? fs.readdirSync(directory).filter((name) => name.endsWith(".png")) : [],
    forced: isForcedCueCount(cues, duration),
  };
}

async function tightenFrame(file: string) {
  const probed = await runCommand("ffmpeg", ["-hide_banner", "-i", file, "-vf", "cropdetect=limit=24:round=2:reset=0", "-f", "null", "-"], 20_000);
  const crop = `${probed.stdout}\n${probed.stderr}`.match(/crop=(\d+:\d+:\d+:\d+)/g)?.at(-1)?.slice("crop=".length);
  if (!crop) return;
  const [width, height] = crop.split(":").map((part) => Number(part));
  if (!width || !height || width < 8 || height < 8 || height > 400) return;
  const tight = file.replace(/\.png$/, ".tight.png");
  await runCommand(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vf", `crop=${crop},scale=iw*3:ih*3:flags=neighbor,pad=24:24:12:12:black`, tight],
    20_000,
  );
  fs.renameSync(tight, file);
}

function subtitleFileIsText(file: string): boolean {
  let handle: number;
  try {
    handle = fs.openSync(file, "r");
  } catch {
    return true;
  }
  try {
    const buffer = Buffer.alloc(256_000);
    const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return subtitleSampleIsText(buffer.subarray(0, bytes));
  } finally {
    fs.closeSync(handle);
  }
}

function looseVobSubCanvas(file: string): string {
  const indexPath = file.replace(/\.sub$/i, ".idx");
  try {
    return vobsubCanvasSize(fs.readFileSync(indexPath, "utf8").slice(0, 8_000));
  } catch {
    return vobsubCanvasSize(null);
  }
}

async function vobsubFrames(file: string, ordinal: number, directory: string): Promise<string[]> {
  const loose = /\.sub$/i.test(file);
  await runCommand(
    "ffmpeg",
    vobsubExtractArgs(file, ordinal, loose ? 0 : 600, path.join(directory, "cue-%02d.png"), loose ? looseVobSubCanvas(file) : null),
    60_000,
  );
  const frames = fs.readdirSync(directory).filter((name) => name.endsWith(".png"));
  for (const name of frames) {
    try {
      await tightenFrame(path.join(directory, name));
    } catch {
      // Keep the original frame when the crop cannot be measured.
    }
  }
  return frames;
}

async function detectPictureSubtitle(job: DetectJob, file: string): Promise<DetectionOutcome> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-sub-"));
  try {
    const picture = job.format === "PGS" ? await pgsFrames(file, job.ordinal, directory) : { frames: await vobsubFrames(file, job.ordinal, directory), forced: false };
    const frames = picture.frames;
    if (frames.length === 0) return { language: null, role: null, confidence: 0, message: "No subtitle images could be read." };
    const languages = await ocrLanguages();
    let best = { language: null as string | null, confidence: 0 };
    for (const language of languages.length ? languages : ["eng"]) {
      const pieces: string[] = [];
      for (const frame of frames) {
        const { stdout } = await runCommand("tesseract", [path.join(directory, frame), "stdout", "-l", language, "--psm", "6"], 60_000);
        const letters = stdout.match(/\p{L}/gu)?.length ?? 0;
        if (letters >= 3) pieces.push(stdout);
      }
      const detected = detectTextLanguage(pieces.join(" "));
      if (detected.language && detected.confidence > best.confidence) best = detected;
      if (best.language && best.confidence >= 0.1) break;
    }
    return {
      language: best.language,
      role: picture.forced ? "forced" : null,
      confidence: best.confidence,
      message: best.language ? null : "This language cannot be reliably recognized.",
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function detectTextSubtitle(job: DetectJob, file: string): Promise<DetectionOutcome> {
  if (job.placement === "external" && !isSubtitleFile(file)) {
    return {
      language: null,
      role: null,
      confidence: 0,
      message: "Plex did not name this subtitle file, so the video was not read as text. The subtitle is Plex only (probably downloaded into Plex's data folder); put a matching .srt beside the video to have it checked.",
    };
  }
  let raw = "";
  let complete = false;
  if (isSubtitleFile(file)) {
    const handle = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(256_000);
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
      const sample = buffer.subarray(0, bytes);
      if (!subtitleSampleIsText(sample)) {
        return { language: null, role: null, confidence: 0, message: "The subtitle file is not readable text." };
      }
      raw = decodeSubtitleBytes(sample);
      complete = bytes < buffer.length;
    } finally {
      fs.closeSync(handle);
    }
  } else {
    const extracted = await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-map", `0:s:${job.ordinal}`, "-f", "srt", "pipe:1"], 45_000);
    raw = extracted.stdout;
    complete = true;
  }
  const detected = detectTextLanguage(cueText(raw));
  return {
    language: detected.language,
    role: complete && isForcedCueCount(cueCount(raw), null) ? "forced" : null,
    confidence: detected.confidence,
    message: detected.language ? null : "This language cannot be reliably recognized.",
  };
}

export async function detectTrack(job: DetectJob, file: string): Promise<DetectionOutcome> {
  if (job.kind === "audio") return detectAudio(job, file);
  if (/\.sub$/i.test(file) && !subtitleFileIsText(file)) {
    try {
      return await detectPictureSubtitle(job, file);
    } catch {
      return { language: null, role: null, confidence: 0, message: "The subtitle file is not readable text." };
    }
  }
  if (isPictureSubtitle(job.format) && job.placement !== "external") return detectPictureSubtitle(job, file);
  try {
    const text = await detectTextSubtitle(job, file);
    if (text.language || job.placement === "external") return text;
    try {
      return await detectPictureSubtitle(job, file);
    } catch {
      return text;
    }
  } catch (error) {
    if (job.placement === "external") throw error;
    return detectPictureSubtitle(job, file);
  }
}
