export type PathMap = { from: string; to: string };

function slash(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

export function parsePathMaps(value: unknown): PathMap[] {
  if (!Array.isArray(value)) return [];
  const maps: PathMap[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { from?: unknown; to?: unknown };
    const from = typeof record.from === "string" ? slash(record.from) : "";
    const to = typeof record.to === "string" ? slash(record.to) : "";
    if (!from || !to) continue;
    maps.push({ from, to });
  }
  return maps;
}

/** Turn a path on this machine back into the path Plex is watching. */
export function pathOnPlex(filePath: string, maps: PathMap[]): string {
  const normalized = filePath.replace(/\\/g, "/");
  let best: PathMap | null = null;
  for (const map of maps) {
    const to = map.to.replace(/\/+$/, "");
    if (!to) continue;
    if (normalized !== to && !normalized.startsWith(`${to}/`)) continue;
    if (!best || to.length > best.to.replace(/\/+$/, "").length) best = { from: map.from.replace(/\/+$/, ""), to };
  }
  if (!best) return normalized;
  return `${best.from}${normalized.slice(best.to.length)}`;
}

export function resolveMediaPath(filePath: string, maps: PathMap[], exists: (candidate: string) => boolean): string | null {
  const normalized = filePath.replace(/\\/g, "/");
  if (exists(filePath)) return filePath;
  if (normalized !== filePath && exists(normalized)) return normalized;
  for (const map of maps) {
    if (normalized !== map.from && !normalized.startsWith(`${map.from}/`)) continue;
    const candidate = `${map.to}${normalized.slice(map.from.length)}`;
    if (exists(candidate)) return candidate;
  }
  return null;
}
