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
