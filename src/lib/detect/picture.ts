export function pictureExtractArgs(file: string, ordinal: number, startSeconds: number, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    String(startSeconds),
    "-t",
    "40",
    "-i",
    file,
    "-filter_complex",
    `[0:s:${ordinal}]scale=1280:-1,fps=1/3[sub]`,
    "-map",
    "[sub]",
    "-frames:v",
    "8",
    "-c:v",
    "png",
    output,
  ];
}
