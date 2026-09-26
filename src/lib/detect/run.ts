import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { audioClipArgs, dialogueMix, sampleOffsets } from "@/lib/detect/audio";
import { agreeLanguage } from "@/lib/detect/agree";
import { commentaryRole } from "@/lib/detect/commentary";
import { cueText } from "@/lib/detect/cues";
import type { DetectJob } from "@/lib/detect/store";
import { readPgsImages, scaleBitmap, writePng } from "@/lib/detect/pgs";
import { pgsCopyArgs, vobsubExtractArgs } from "@/lib/detect/picture";
import { isPictureSubtitle } from "@/lib/detect/targets";
import { decodeSubtitleBytes } from "@/lib/detect/encoding";
import { isSubtitleFile } from "@/lib/detect/sidecars";
import { detectTextLanguage } from "@/lib/detect/text-language";
import { languageName } from "@/lib/media";

export type DetectionOutcome = {
  language: string | null;
  role: "commentary" | null;
  confidence: number;
  message: string | null;
};

const limitedEnv = { ...process.env, OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1" };

function runCommand(command: string, args: string[], timeout = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("nice", ["-n", "15", command, ...args], { timeout, maxBuffer: 2 * 1024 * 1024, env: limitedEnv }, (error, stdout, stderr) => {
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

async function durationSeconds(file: string): Promise<number | null> {
  try {
    const { stdout } = await runCommand("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], 30_000);
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

async function streamLayout(file: string, ordinal: number): Promise<{ layout: string | null; channels: number | null }> {
  try {
    const { stdout } = await runCommand(
      "ffprobe",
      ["-v", "error", "-select_streams", `a:${ordinal}`, "-show_entries", "stream=channel_layout,channels", "-of", "json", file],
      30_000,
    );
    const body = JSON.parse(stdout) as { streams?: Array<{ channel_layout?: unknown; channels?: unknown }> };
    const stream = body.streams?.[0];
    const layout = typeof stream?.channel_layout === "string" ? stream.channel_layout : null;
    const channels = typeof stream?.channels === "number" ? stream.channels : null;
    return { layout, channels };
  } catch {
    return { layout: null, channels: null };
  }
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
  const child = spawn("nice", ["-n", "15", command, script], { stdio: ["pipe", "pipe", "pipe"], env: limitedEnv });
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

async function detectAudio(job: DetectJob, file: string): Promise<DetectionOutcome> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-audio-"));
  try {
    const heard = await streamLayout(file, job.ordinal);
    const mix = dialogueMix(heard.layout, heard.channels);
    const samples: Array<{ language: string; probability: number }> = [];
    const transcript: string[] = [];
    let agreed = { language: null as string | null, confidence: 0 };
    for (const [index, offset] of sampleOffsets(null).entries()) {
      const wav = path.join(directory, `clip-${index}.wav`);
      let extracted = false;
      for (const filter of mix ? [mix, null] : [null]) {
        try {
          await runCommand("ffmpeg", audioClipArgs(file, job.ordinal, offset, wav, filter), 30_000);
          extracted = true;
          break;
        } catch (caught) {
          const timedOut = caught instanceof Error && /timed out/.test(caught.message);
          if (timedOut) break;
        }
      }
      if (!extracted || !fs.existsSync(wav) || fs.statSync(wav).size < 8_000) continue;
      const speech = await transcribe(wav);
      if (speech.language) samples.push({ language: speech.language, probability: speech.probability });
      if (speech.text) transcript.push(speech.text);
      agreed = agreeLanguage(samples);
      if (agreed.language) break;
    }
    if (agreed.language && transcript.join(" ").trim().length < 80) {
      const wav = path.join(directory, "clip-later.wav");
      let extracted = false;
      for (const filter of mix ? [mix, null] : [null]) {
        try {
          await runCommand("ffmpeg", audioClipArgs(file, job.ordinal, 180, wav, filter), 30_000);
          extracted = true;
          break;
        } catch (caught) {
          const timedOut = caught instanceof Error && /timed out/.test(caught.message);
          if (timedOut) break;
        }
      }
      if (extracted && fs.existsSync(wav) && fs.statSync(wav).size >= 8_000) {
        const speech = await transcribe(wav);
        if (speech.text) transcript.push(speech.text);
      }
    }
    if (samples.length === 0) return { language: null, role: null, confidence: 0, message: "No speech found in the sample." };
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

async function pgsFrames(file: string, ordinal: number, directory: string): Promise<string[]> {
  const duration = await durationSeconds(file);
  const starts = duration && duration > 900
    ? [0.2, 0.4, 0.6, 0.8].map((ratio) => Math.round(Math.min(duration * ratio, Math.max(duration - 200, 0))))
    : [600, 1800, 3000];
  const sup = path.join(directory, "track.sup");
  const bitmaps = [];
  for (const start of starts) {
    clearDirectory(directory);
    try {
      await runCommand("ffmpeg", pgsCopyArgs(file, ordinal, start, sup), 90_000);
    } catch (error) {
      const failed = error instanceof Error ? error : new Error(String(error));
      if (!/empty|nothing was written/i.test(failed.message)) throw failed;
      continue;
    }
    if (!fs.existsSync(sup) || fs.statSync(sup).size < 32) continue;
    bitmaps.push(...readPgsImages(fs.readFileSync(sup), 12));
    fs.rmSync(sup, { force: true });
    if (bitmaps.length >= 24) break;
  }
  const frames = spread(bitmaps, 8).map((bitmap) => scaleBitmap(bitmap, 3));
  frames.forEach((image, index) => writePng(path.join(directory, `cue-${index}.png`), image));
  return frames.length ? fs.readdirSync(directory).filter((name) => name.endsWith(".png")) : [];
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

async function vobsubFrames(file: string, ordinal: number, directory: string): Promise<string[]> {
  await runCommand("ffmpeg", vobsubExtractArgs(file, ordinal, 600, path.join(directory, "cue-%02d.png")), 60_000);
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
    const frames = job.format === "PGS" ? await pgsFrames(file, job.ordinal, directory) : await vobsubFrames(file, job.ordinal, directory);
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
      role: null,
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
      message: "Plex did not name this subtitle file, so the video was not read as text.",
    };
  }
  let raw = "";
  if (isSubtitleFile(file)) {
    const handle = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(256_000);
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
      const sample = buffer.subarray(0, bytes);
      let noisy = 0;
      for (const byte of sample) {
        if (byte === 0 || byte < 9 || (byte > 13 && byte < 32)) noisy += 1;
      }
      if (bytes === 0 || noisy / bytes > 0.02) {
        return { language: null, role: null, confidence: 0, message: "The subtitle file is not readable text." };
      }
      raw = decodeSubtitleBytes(sample);
    } finally {
      fs.closeSync(handle);
    }
  } else {
    const extracted = await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-map", `0:s:${job.ordinal}`, "-f", "srt", "pipe:1"], 45_000);
    raw = extracted.stdout;
  }
  const detected = detectTextLanguage(cueText(raw));
  return {
    language: detected.language,
    role: null,
    confidence: detected.confidence,
    message: detected.language ? null : "This language cannot be reliably recognized.",
  };
}

export async function detectTrack(job: DetectJob, file: string): Promise<DetectionOutcome> {
  if (job.kind === "audio") return detectAudio(job, file);
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
