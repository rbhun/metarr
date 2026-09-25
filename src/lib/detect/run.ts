import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { agreeLanguage } from "@/lib/detect/agree";
import { commentaryRole } from "@/lib/detect/commentary";
import { cueText } from "@/lib/detect/cues";
import type { DetectJob } from "@/lib/detect/store";
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
        const detail = err
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("_STATISTICS_"))
          .slice(-4)
          .join(" ");
        reject(new Error(missing ? `${command} is not installed.` : detail || error.message));
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

function sampleOffsets(duration: number | null): number[] {
  if (duration == null || duration < 90) return [15];
  return [0.12, 0.38, 0.62]
    .map((ratio) => Math.round(Math.min(Math.max(duration * ratio, 20), duration - 30)))
    .filter((offset, index, all) => all.indexOf(offset) === index);
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
    const offsets = sampleOffsets(await durationSeconds(file));
    const samples: Array<{ language: string; probability: number }> = [];
    const transcript: string[] = [];
    for (const [index, offset] of offsets.entries()) {
      const wav = path.join(directory, `clip-${index}.wav`);
      await runCommand("ffmpeg", ["-y", "-ss", String(offset), "-i", file, "-map", `0:a:${job.ordinal}`, "-t", "20", "-ac", "1", "-ar", "16000", "-vn", wav]);
      if (!fs.existsSync(wav) || fs.statSync(wav).size < 8_000) continue;
      const speech = await transcribe(wav);
      if (speech.language) samples.push({ language: speech.language, probability: speech.probability });
      if (speech.text) transcript.push(speech.text);
    }
    if (samples.length === 0) return { language: null, role: null, confidence: 0, message: "No speech found in the sample." };
    const agreed = agreeLanguage(samples);
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

async function ocrLanguages(): Promise<string> {
  const { stdout, stderr } = await runCommand("tesseract", ["--list-langs"], 20_000);
  const installed = new Set(`${stdout}\n${stderr}`.split("\n").map((line) => line.trim()).filter((line) => /^[a-z0-9_]+$/i.test(line) && line !== "osd"));
  const chosen = ["eng", "hun"].filter((language) => installed.has(language));
  return (chosen.length ? chosen : [...installed].slice(0, 1)).join("+") || "eng";
}

async function detectPictureSubtitle(job: DetectJob, file: string): Promise<DetectionOutcome> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metarr-sub-"));
  try {
    await runCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      "300",
      "-i",
      file,
      "-map",
      `0:s:${job.ordinal}`,
      "-frames:v",
      "4",
      "-vf",
      "scale=960:-1",
      "-c:v",
      "png",
      path.join(directory, "cue-%02d.png"),
    ]);
    const frames = fs.readdirSync(directory).filter((name) => name.endsWith(".png"));
    if (frames.length === 0) return { language: null, role: null, confidence: 0, message: "No subtitle images could be read." };
    const languages = await ocrLanguages();
    const pieces: string[] = [];
    for (const frame of frames) {
      const { stdout } = await runCommand("tesseract", [path.join(directory, frame), "stdout", "-l", languages], 60_000);
      pieces.push(stdout);
    }
    const detected = detectTextLanguage(pieces.join(" "));
    return {
      language: detected.language,
      role: null,
      confidence: detected.confidence,
      message: detected.language ? null : "This language cannot be reliably recognized.",
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
