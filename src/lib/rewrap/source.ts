import { fileExtension } from "@/lib/media";

const AVI = new Set(["avi", "divx"]);
const TRANSPORT = new Set(["m2ts", "mts", "ts"]);

function inDiscFolder(filePath: string): boolean {
  return /[\\/](bdmv|video_ts)[\\/]/i.test(filePath);
}

export function isAvi(container: string | null | undefined, filePath: string | null | undefined): boolean {
  const ext = fileExtension(filePath);
  if (ext) return AVI.has(ext);
  return AVI.has((container ?? "").toLowerCase());
}

/**
 * AVI and loose MPEG transport streams cannot hold a language on each track, so they are copied into an MKV.
 * A transport stream inside a Blu-ray folder belongs to the disc remux instead.
 */
export function canRewrap(container: string | null | undefined, filePath: string | null | undefined): boolean {
  if (isAvi(container, filePath)) return true;
  if (filePath && inDiscFolder(filePath)) return false;
  const ext = fileExtension(filePath) ?? (container ?? "").toLowerCase();
  return TRANSPORT.has(ext);
}

/** "AVI" or "M2TS", for messages about the file being copied. */
export function sourceKind(filePath: string): string {
  const ext = fileExtension(filePath);
  if (!ext || AVI.has(ext)) return "AVI";
  return ext.toUpperCase();
}

/** The MKV lands beside the source under the same name, so sidecar subtitles and multi-part names keep matching. */
export function rewrapTarget(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  const stem = dot > slash ? filePath.slice(0, dot) : filePath;
  return `${stem}.mkv`;
}

/** An MKV already sitting on the same title under the rewrap name. */
export function rewrappedPathFor(sourcePath: string, paths: Array<string | null | undefined>): string | null {
  const target = rewrapTarget(sourcePath).toLowerCase();
  return paths.find((item): item is string => Boolean(item) && item!.toLowerCase() === target) ?? null;
}
