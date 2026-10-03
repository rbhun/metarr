/** A handful of cue times, spread through the subtitle, when the usual windows are empty. */
export function cueSampleStarts(times: number[], limit = 4): number[] {
  const unique = [...new Set(times.map((time) => Math.max(0, Math.floor(time))))].sort((left, right) => left - right);
  if (unique.length <= limit) return unique;
  return Array.from({ length: limit }, (_, index) => unique[Math.min(unique.length - 1, Math.floor(((index + 0.5) * unique.length) / limit))] as number);
}

/** Copy the whole PGS track. An indexed file (MKV) can seek the subtitle; a disc stream cannot. */
export function pgsDemuxArgs(file: string, ordinal: number, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
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

/** Copy a short window when the whole track would mean reading a disc from the start. */
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

/** Copy PGS from a transport-stream slice already positioned on stdin. */
export function pgsSliceArgs(ordinal: number, output: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "mpegts",
    "-probesize",
    "5000000",
    "-analyzeduration",
    "5000000",
    "-i",
    "pipe:0",
    "-map",
    `0:s:${ordinal}`,
    "-c",
    "copy",
    "-f",
    "sup",
    output,
  ];
}

/** Display size from a VobSub index. A loose `.sub` with no index is drawn on a 1080p canvas. */
export function vobsubCanvasSize(idx: string | null | undefined): string {
  const match = idx?.match(/^size:\s*(\d+)\s*x\s*(\d+)/im);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!width || !height || width > 7680 || height > 4320) return "1920x1080";
  return `${width}x${height}`;
}

export function vobsubExtractArgs(file: string, ordinal: number, startSeconds: number, output: string, canvas: string | null = null): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...(canvas ? ["-canvas_size", canvas] : []),
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
