import { isDiscImage } from "@/lib/media";
import type { ScanFile } from "@/lib/detect/targets";
import type { MediaVersion } from "@/lib/types";

export type DiscCandidate = { path: string; label: string };

export function discsFromFile(file: ScanFile): DiscCandidate[] {
  const found: DiscCandidate[] = [];
  const push = (filePath: string | null, container: string | null) => {
    if (!filePath || !isDiscImage(container, filePath)) return;
    if (found.some((item) => item.path === filePath)) return;
    found.push({ path: filePath, label: file.label });
  };
  push(file.path, file.container);
  for (const version of file.versions) push(version.path, version.container);
  return found;
}

/** A playable, non-disc video file on the same title, such as the MKV a remux produced. */
export function convertedFileFor(
  file: Pick<ScanFile, "path" | "container" | "playableLabel"> & { versions: Array<Pick<MediaVersion, "path" | "container" | "playableLabel">> },
): string | null {
  const paths = [
    ...(file.playableLabel === "video" ? [{ path: file.path, container: file.container }] : []),
    ...file.versions.filter((version) => version.playableLabel === "video").map((version) => ({ path: version.path, container: version.container })),
  ];
  return paths.find((item) => item.path && !isDiscImage(item.container, item.path))?.path ?? null;
}
