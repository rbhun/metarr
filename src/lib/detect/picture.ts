/** A handful of cue times, spread through the subtitle, when the usual windows are empty. */
export function cueSampleStarts(times: number[], limit = 4): number[] {
  const unique = [...new Set(times.map((time) => Math.max(0, Math.floor(time))))].sort((left, right) => left - right);
  if (unique.length <= limit) return unique;
  return Array.from({ length: limit }, (_, index) => unique[Math.min(unique.length - 1, Math.floor(((index + 0.5) * unique.length) / limit))] as number);
}

export function pgsCopyArgs(file: string, ordinal: number, startSeconds: number, output: string, seconds = 45): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    String(startSeconds),
    "-t",
    String(seconds),
    "-i",
    file,
    "-map",
    `0:s:${ordinal}`,
    "-c",
    "copy",
    "-f",
    "sup",
    output,
  ];
}

export function vobsubExtractArgs(file: string, ordinal: number, startSeconds: number, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    String(startSeconds),
    "-t",
    "24",
    "-i",
    file,
    "-filter_complex",
    `[0:s:${ordinal}]scale=1280:-1[sub]`,
    "-map",
    "[sub]",
    "-frames:v",
    "4",
    "-c:v",
    "png",
    output,
  ];
}
