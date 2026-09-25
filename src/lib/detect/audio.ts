/** Early windows, so a transport stream is not read halfway through for an empty clip. */
export function sampleOffsets(duration: number | null): number[] {
  if (duration == null || duration < 90) return [15];
  const latest = Math.max(20, Math.floor(duration - 30));
  return [90, 300, 600]
    .map((offset) => Math.min(offset, latest))
    .filter((offset, index, all) => all.indexOf(offset) === index);
}

/**
 * `-t` is an input limit. After `-i` it trims by output timestamp, and a Dolby
 * Digital seek often lands on packets whose timestamps are then discarded.
 */
export function audioClipArgs(file: string, ordinal: number, offset: number, wav: string): string[] {
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
