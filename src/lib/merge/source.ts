import path from "node:path";
import { fileExtension, isDiscImage, playableFrom } from "@/lib/media";
import type { PlayableLabel } from "@/lib/types";

/** Combined MKV beside the video source, never overwriting either original. */
export function mergeTarget(videoPath: string): string {
  const directory = path.dirname(videoPath);
  const base = path.basename(videoPath);
  const ext = fileExtension(videoPath);
  const stem = ext ? base.slice(0, -(ext.length + 1)) : base;
  return path.join(directory, `${stem}.combined.mkv`);
}

export function canMergeVersion(playableLabel: PlayableLabel, container: string | null, filePath: string | null): boolean {
  if (!filePath?.trim()) return false;
  if (isDiscImage(container, filePath)) return false;
  if (playableLabel !== "video" && playableFrom(true, container, filePath) !== "video") return false;
  const ext = (container || fileExtension(filePath) || "").toLowerCase();
  return Boolean(ext) && ext !== "iso" && ext !== "img";
}
