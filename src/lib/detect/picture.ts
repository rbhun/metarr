export function pgsCopyArgs(file: string, ordinal: number, startSeconds: number, output: string, seconds = 180): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    String(startSeconds),
    "-i",
    file,
    "-map",
    `0:s:${ordinal}`,
    "-c",
    "copy",
    "-t",
    String(seconds),
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
