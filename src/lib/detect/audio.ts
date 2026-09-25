/** Early windows, so a transport stream is not read halfway through for an empty clip. */
export function sampleOffsets(duration: number | null): number[] {
  if (duration == null || duration < 90) return [15];
  const latest = Math.max(20, Math.floor(duration - 30));
  return [90, 300, 600]
    .map((offset) => Math.min(offset, latest))
    .filter((offset, index, all) => all.indexOf(offset) === index);
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
export function audioClipArgs(file: string, ordinal: number, offset: number, wav: string, mix: string | null = null): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
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
