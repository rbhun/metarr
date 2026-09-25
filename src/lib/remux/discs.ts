import { isDiscImage } from "@/lib/media";
import type { ScanFile } from "@/lib/detect/targets";

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
