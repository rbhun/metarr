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
