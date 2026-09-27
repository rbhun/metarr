const CLIP_SECONDS = 20;
const TEN_MINUTES = 10 * 60;
const TWENTY_MINUTES = 20 * 60;

/** Titles and the opening scene are skipped. A short file is sampled at its middle instead. */
export function sampleOffsets(duration: number | null): number[] {
  const fits = (offset: number) => duration == null || duration > offset + CLIP_SECONDS;
  const marks = [TEN_MINUTES, TWENTY_MINUTES].filter(fits);
  if (marks.length > 0) return marks;
  return [Math.max(1, Math.floor((duration ?? CLIP_SECONDS) / 2))];
}

/**
 * A Blu-ray stream often starts minutes or hours past zero. Ten minutes of the
 * movie is that far into the program, then shifted onto the file's timeline.
 */
export function clipStart(programOffset: number, mediaStart: number | null): number {
  const start = mediaStart != null && Number.isFinite(mediaStart) && mediaStart > 0 ? mediaStart : 0;
  return Math.round((start + programOffset) * 1000) / 1000;
}

const WINDOW_SECONDS = 30;
const UNKNOWN_WINDOW = 160 * 1024 * 1024;
const OPENING_BYTES = 16 * 1024 * 1024;

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
export function tsWindow(size: number, duration: number | null, programOffset: number, packet: number): { start: number; end: number } | null {
  if (size < packet * 2 || packet < 1) return null;
  const ratio = duration != null && duration > programOffset
    ? programOffset / duration
    : programOffset >= TWENTY_MINUTES
      ? 0.22
      : programOffset >= TEN_MINUTES
        ? 0.12
        : 0.5;
  const span = duration != null && duration > 0 ? Math.ceil((WINDOW_SECONDS / duration) * size) : UNKNOWN_WINDOW;
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
