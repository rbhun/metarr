import { languageName } from "@/lib/media";

const CLIP_SECONDS = 20;
const THREE_MINUTES = 3 * 60;
const TEN_MINUTES = 10 * 60;
const TWENTY_MINUTES = 20 * 60;

/**
 * Titles and the opening scene are skipped. A file that cannot reach 10 minutes
 * is sampled at its middle, then near the start, so a cut-off file still has a clip.
 * A file that reaches only one of the later marks also gets a clip at 3 minutes,
 * so one window cannot decide the language on its own.
 */
export function sampleOffsets(duration: number | null): number[] {
  const fits = (offset: number) => duration == null || duration > offset + CLIP_SECONDS;
  const marks = [TEN_MINUTES, TWENTY_MINUTES].filter(fits);
  if (marks.length >= 2) return marks;
  if (marks.length === 1) {
    const earlier = THREE_MINUTES;
    if (fits(earlier) && earlier !== marks[0]) return [marks[0]!, earlier];
    return marks;
  }
  const middle = Math.max(1, Math.floor((duration ?? CLIP_SECONDS) / 2));
  const early = 1;
  if (early >= middle) return [middle];
  return [middle, early];
}

/**
 * A Blu-ray stream often starts minutes or hours past zero. Ten minutes of the
 * movie is that far into the program, then shifted onto the file's timeline.
 */
export function clipStart(programOffset: number, mediaStart: number | null): number {
  const start = mediaStart != null && Number.isFinite(mediaStart) && mediaStart > 0 ? mediaStart : 0;
  return Math.round((start + programOffset) * 1000) / 1000;
}

/** Twelve seconds of programme is enough for Whisper and stays small on a 4K disc over NFS. */
const WINDOW_SECONDS = 12;
const UNKNOWN_WINDOW = 24 * 1024 * 1024;
const OPENING_BYTES = 8 * 1024 * 1024;

export function isTransportStream(file: string): boolean {
  return /\.m2ts$/i.test(file) || /\.ts$/i.test(file);
}

/** Blu-ray packets are 192 bytes. A plain transport stream uses 188. */
export function packetBytes(file: string): number {
  return /\.m2ts$/i.test(file) ? 192 : 188;
}

/**
 * A disc file has no index, so a timestamp seek reads the 4K picture from the
 * start. The same moment is a short aligned slice of the file instead.
 */
export function tsWindow(
  size: number,
  duration: number | null,
  programOffset: number,
  packet: number,
  windowSeconds = WINDOW_SECONDS,
): { start: number; end: number } | null {
  if (size < packet * 2 || packet < 1) return null;
  const ratio = duration != null && duration > programOffset
    ? programOffset / duration
    : programOffset >= TWENTY_MINUTES
      ? 0.22
      : programOffset >= TEN_MINUTES
        ? 0.12
        : 0.5;
  const span = duration != null && duration > 0 ? Math.ceil((windowSeconds / duration) * size) : UNKNOWN_WINDOW;
  const bytes = Math.min(size, Math.max(span, packet * 64));
  let start = Math.floor(size * Math.min(ratio, 0.98));
  if (start + bytes > size) start = Math.max(0, size - bytes);
  start -= start % packet;
  const end = Math.min(size, start + bytes);
  if (end - start < packet) return null;
  return { start, end };
}

/** The first slice of a disc, where a stub track may exist before it disappears. */
export function openingWindow(size: number, packet: number): { start: number; end: number } | null {
  if (size < packet * 2 || packet < 1) return null;
  const end = Math.min(size, OPENING_BYTES) - (Math.min(size, OPENING_BYTES) % packet);
  if (end < packet) return null;
  return { start: 0, end };
}

/** The language stored on the stream, which a player can show even when Plex left it blank. */
export function languageFromProbeTags(tags: unknown): string | null {
  if (!tags || typeof tags !== "object") return null;
  const language = (tags as { language?: unknown }).language;
  return typeof language === "string" ? languageName(language) : null;
}

/** A wav of digital silence, such as a disc track that only holds a blank second. */
export function pcmIsSilent(wav: Buffer): boolean {
  const data = wav.length > 44 && wav.toString("ascii", 0, 4) === "RIFF" ? wav.subarray(44) : wav;
  if (data.length < 2) return true;
  const step = Math.max(2, (Math.floor(data.length / 4000) * 2) || 2);
  for (let offset = 0; offset + 1 < data.length; offset += step) {
    const sample = data.readInt16LE(offset);
    if (sample > 80 || sample < -80) return false;
  }
  return true;
}

/** Decode audio from a transport-stream slice already positioned on stdin. */
export function audioSliceArgs(ordinal: number, wav: string, mix: string | null = null): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "mpegts",
    "-probesize",
    "2000000",
    "-analyzeduration",
    "2000000",
    "-i",
    "pipe:0",
    "-map",
    `0:a:${ordinal}`,
    "-t",
    "20",
    ...(mix ? ["-af", mix] : []),
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-vn",
    wav,
  ];
}

const CENTERED = /^(?:3\.0|4\.0|5\.0|5\.1|6\.0|6\.1|7\.0|7\.1)(?:\(|$)/;

/** Center carries most of the dialogue. Front left and right carry the rest. Surrounds stay out. */
export function dialogueMix(layout: string | null, channels: number | null): string | null {
  const name = layout?.trim().toLowerCase() ?? "";
  const centered = CENTERED.test(name) || (!name && channels != null && channels >= 6);
  if (!centered) return null;
  return "pan=mono|c0=0.7*FC+0.15*FL+0.15*FR";
}

/**
 * `-t` is an input limit. After `-i` it trims by output timestamp, and a Dolby
 * Digital seek often lands on packets whose timestamps are then discarded.
 */
/**
 * Copy the audio without decoding it. `-seek2any` lands on an audio packet
 * instead of the previous 4K video keyframe, which a disc file may not reach
 * before the read is abandoned.
 */
export function audioCopyArgs(file: string, ordinal: number, offset: number, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-seek2any",
    "1",
    "-ss",
    String(offset),
    "-t",
    "20",
    "-i",
    file,
    "-map",
    `0:a:${ordinal}`,
    "-c",
    "copy",
    "-vn",
    "-f",
    "matroska",
    output,
  ];
}

/** Decode an already trimmed clip. No seek, so packet timestamps are kept. */
export function audioDecodeArgs(source: string, wav: string, mix: string | null = null): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    source,
    ...(mix ? ["-af", mix] : []),
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-vn",
    wav,
  ];
}

const SHORT_SECONDS = 15;
const MARKER_BYTES = 2 * 1024 * 1024;

/** A moment of audio on a long film, such as a disc dub that ends after the opening second. */
export function isShortSpan(span: number | null, film: number | null): boolean {
  if (span == null || !Number.isFinite(span) || span < 0 || span > SHORT_SECONDS) return false;
  if (film != null && film < 120) return false;
  return true;
}

/** Seconds of 16 kHz mono audio in a wav we decoded. A stub is about one second; a real sample is much longer. */
export function wavSeconds(wav: Buffer): number {
  const data = wav.length > 44 && wav.toString("ascii", 0, 4) === "RIFF" ? wav.subarray(44) : wav;
  return data.length / 2 / 16000;
}

/** The decoded clip ran out almost immediately, so listening to it cannot identify the film. */
export function isExceptionallyShortClip(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 3;
}

/** The MPEG-TS packet id ffprobe stored on an audio stream. */
export function audioPid(id: unknown): number | null {
  const text = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
  if (!text) return null;
  const value = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number(text);
  return Number.isInteger(value) && value >= 0 && value <= 0x1fff ? value : null;
}

export type PidActivity = { packets: number; span: number | null; ended: boolean };

function readPts(buffer: Buffer, payload: number): number | null {
  if (payload + 14 >= buffer.length) return null;
  if (buffer[payload] !== 0 || buffer[payload + 1] !== 0 || buffer[payload + 2] !== 1) return null;
  const id = buffer[payload + 3];
  if (id === 0xbe || id === 0xbf || id === 0xf0 || id === 0xf1 || id === 0xff || id === 0xf2 || id === 0xf8) return null;
  const flags = (buffer[payload + 7] >> 6) & 3;
  if (flags !== 2 && flags !== 3) return null;
  const point = payload + 9;
  return (
    ((buffer[point] ?? 0) & 0x0e) * 536870912 +
    (buffer[point + 1] ?? 0) * 4194304 +
    ((buffer[point + 2] ?? 0) & 0xfe) * 16384 +
    (buffer[point + 3] ?? 0) * 128 +
    ((buffer[point + 4] ?? 0) >> 1)
  ) / 90000;
}

/** How far one audio packet id reaches inside an aligned slice, and whether it stops before the slice ends. */
export function pidActivity(buffer: Buffer, packet: number, pid: number): PidActivity {
  if (packet < 188 || pid < 0 || pid > 0x1fff) return { packets: 0, span: null, ended: false };
  const prefix = packet >= 192 ? 4 : 0;
  const packets = Math.floor(buffer.length / packet);
  let count = 0;
  let last = -1;
  let firstPts: number | null = null;
  let lastPts: number | null = null;
  for (let index = 0; index < packets; index += 1) {
    const origin = index * packet;
    const sync = origin + prefix;
    if (buffer[sync] !== 0x47) continue;
    const found = ((buffer[sync + 1] & 0x1f) << 8) | buffer[sync + 2];
    if (found !== pid) continue;
    count += 1;
    last = index;
    if ((buffer[sync + 1] & 0x40) === 0) continue;
    const adaptation = (buffer[sync + 3] >> 4) & 3;
    if (adaptation === 2) continue;
    let payload = sync + 4;
    if (adaptation === 3) payload += 1 + (buffer[sync + 4] ?? 0);
    const pts = readPts(buffer, payload);
    if (pts == null) continue;
    if (firstPts == null) firstPts = pts;
    lastPts = pts;
  }
  const span = firstPts != null && lastPts != null ? lastPts - firstPts : null;
  return { packets: count, span, ended: count > 0 && last + 32 < packets };
}

/** A small aligned slice at the same moment a full sample would use, only large enough to see whether the track is still present. */
export function markerWindow(
  size: number,
  duration: number | null,
  programOffset: number,
  packet: number,
): { start: number; end: number } | null {
  const placed = tsWindow(size, duration, programOffset, packet);
  if (!placed) return null;
  const room = placed.end - placed.start;
  const bytes = Math.min(room, MARKER_BYTES - (MARKER_BYTES % packet));
  const end = placed.start + bytes - (bytes % packet);
  if (end - placed.start < packet) return null;
  return { start: placed.start, end };
}

export function audioClipArgs(file: string, ordinal: number, offset: number, wav: string, mix: string | null = null): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-seek2any",
    "1",
    "-ss",
    String(offset),
    "-t",
    "20",
    "-i",
    file,
    "-map",
    `0:a:${ordinal}`,
    ...(mix ? ["-af", mix] : []),
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-vn",
    wav,
  ];
}
