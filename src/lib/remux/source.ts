import path from "node:path";

function folderBefore(filePath: string, marker: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const needle = `/${marker}`;
  let from = lower.length;
  while (from > 0) {
    const at = lower.lastIndexOf(needle, from);
    if (at < 0) return null;
    const end = at + needle.length;
    if (end === lower.length || lower[end] === "/") return normalized.slice(0, at);
    from = at - 1;
  }
  return null;
}

/** MakeMKV source spec for an ISO or a Blu-ray / DVD folder. */
export function makemkvSource(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  const ext = path.posix.extname(normalized.toLowerCase());
  if (ext === ".iso" || ext === ".img") return `iso:${normalized}`;
  const bluray = folderBefore(filePath, "bdmv");
  if (bluray != null) return `file:${bluray}`;
  const dvd = folderBefore(filePath, "video_ts");
  if (dvd != null) return `file:${dvd}`;
  if (ext === ".vob" || ext === ".ifo" || ext === ".bup") return `file:${path.posix.dirname(normalized)}`;
  return null;
}

/** Folder that should receive the MKV, next to the disc. */
export function outputDirectory(filePath: string): string | null {
  const source = makemkvSource(filePath);
  if (!source) return null;
  if (source.startsWith("iso:")) return path.dirname(source.slice(4));
  if (source.startsWith("file:")) return source.slice(5);
  return null;
}
