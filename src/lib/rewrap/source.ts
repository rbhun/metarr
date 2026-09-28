import { fileExtension } from "@/lib/media";

const AVI = new Set(["avi", "divx"]);

export function isAvi(container: string | null | undefined, filePath: string | null | undefined): boolean {
  const ext = fileExtension(filePath);
  if (ext) return AVI.has(ext);
  return AVI.has((container ?? "").toLowerCase());
}

/** The MKV lands beside the AVI under the same name, so sidecar subtitles and multi-part names keep matching. */
export function rewrapTarget(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  const stem = dot > slash ? filePath.slice(0, dot) : filePath;
  return `${stem}.mkv`;
}

/** An MKV already sitting on the same title under the rewrap name. */
export function rewrappedPathFor(aviPath: string, paths: Array<string | null | undefined>): string | null {
  const target = rewrapTarget(aviPath).toLowerCase();
  return paths.find((item): item is string => Boolean(item) && item!.toLowerCase() === target) ?? null;
}
