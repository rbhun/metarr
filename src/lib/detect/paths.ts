import fs from "node:fs";
import path from "node:path";
import { languageFromSubtitleName } from "@/lib/detect/subtitle-name";

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

export function mediaPathCandidates(filePath: string, maps: PathMap[]): string[] {
  const normalized = filePath.replace(/\\/g, "/");
  const candidates = [filePath];
  if (normalized !== filePath) candidates.push(normalized);
  for (const map of maps) {
    if (normalized !== map.from && !normalized.startsWith(`${map.from}/`)) continue;
    candidates.push(`${map.to}${normalized.slice(map.from.length)}`);
  }
  return [...new Set(candidates.filter(Boolean))];
}

export function resolveMediaPath(filePath: string, maps: PathMap[], exists: (candidate: string) => boolean): string | null {
  for (const candidate of mediaPathCandidates(filePath, maps)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Why this process cannot use a media path — missing, not a file, or permission. */
export function mediaPathProblem(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return `${filePath} is not a file.`;
  } catch (caught) {
    const code = caught && typeof caught === "object" && "code" in caught ? String((caught as NodeJS.ErrnoException).code) : "";
    if (code === "EACCES" || code === "EPERM") {
      return `Permission denied for ${filePath}. Metarr runs as uid ${process.getuid?.() ?? "?"} gid ${process.getgid?.() ?? "?"}; the file or a parent folder must be readable by that user or group.`;
    }
    if (code === "ENOENT") return null;
    return `Cannot open ${filePath}${code ? ` (${code})` : ""}.`;
  }
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return null;
  } catch {
    return `Permission denied for ${filePath}. Metarr runs as uid ${process.getuid?.() ?? "?"} gid ${process.getgid?.() ?? "?"}; the file or a parent folder must be readable by that user or group.`;
  }
}

/** Readable subtitle files in the same folder that share this title stem (language tags ignored). */
export function listSiblingSubtitles(filePath: string): string[] {
  const directory = path.dirname(filePath);
  const base = path.basename(filePath);
  if (!/\.(srt|ass|ssa|vtt)$/i.test(base)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const wanted = subtitleStem(base);
  if (!wanted) return [];
  return names
    .filter((name) => /\.(srt|ass|ssa|vtt)$/i.test(name) && subtitleStem(name) === wanted)
    .map((name) => path.join(directory, name))
    .filter((found) => !mediaPathProblem(found));
}

/**
 * Plex sometimes stores a subtitle name that no longer matches the disc. Prefer an
 * existing sidecar in the same folder whose stem matches after dropping language tags.
 * When several files share the stem, the unlabeled one is the file to recognize.
 */
export function siblingSubtitlePath(filePath: string): string | null {
  const matches = listSiblingSubtitles(filePath);
  if (matches.length === 1) return matches[0]!;
  const base = path.basename(filePath);
  const exact = matches.find((found) => path.basename(found) === base);
  if (exact) return exact;
  const unlabeled = matches.filter((found) => !languageFromSubtitleName(path.basename(found)));
  if (unlabeled.length === 1) return unlabeled[0]!;
  return null;
}

/** True when every sidecar for this title already has a language in its name. */
export function siblingSubtitlesAlreadyTagged(filePath: string): boolean {
  const matches = listSiblingSubtitles(filePath);
  return matches.length > 0 && matches.every((found) => Boolean(languageFromSubtitleName(path.basename(found))));
}

/** Folder + title stem, ignoring language / forced / SDH tags on the subtitle name. */
export function subtitleStem(fileName: string): string {
  const stem = fileName
    .replace(/\.(srt|ass|ssa|vtt)$/i, "")
    .replace(/[([{\]](\d{4})[\])} ]/g, " $1 ")
    .replace(/[([{\])]/g, " ");
  const parts = stem.split(/[._\-\s]+/).filter(Boolean);
  while (parts.length > 1) {
    const last = parts[parts.length - 1] ?? "";
    if (/^(forced|sdh|cc|foreign|hi|default|normal)$/i.test(last)) {
      parts.pop();
      continue;
    }
    if (/^[a-z]{2,3}$/i.test(last) || /^(english|hungarian|german|french|spanish|italian|japanese|chinese|portuguese|russian|polish|dutch|swedish|norwegian|danish|finnish|czech|turkish|arabic|hindi|ukrainian|hebrew|greek|romanian|croatian|serbian|bulgarian|catalan|vietnamese|slovak|thai|indonesian)$/i.test(last)) {
      parts.pop();
      continue;
    }
    break;
  }
  return parts.join(" ").toLowerCase();
}

export function unresolvedMediaMessage(filePath: string, maps: PathMap[]): string {
  const candidates = mediaPathCandidates(filePath, maps);
  for (const candidate of candidates) {
    const problem = mediaPathProblem(candidate);
    if (problem) return problem;
  }
  const parent = path.dirname(candidates[0]?.replace(/\\/g, "/") ?? filePath.replace(/\\/g, "/"));
  let parentNote = "";
  try {
    fs.readdirSync(parent);
    parentNote = ` The folder ${parent} is readable, so the subtitle name may not match the file on disk.`;
  } catch (caught) {
    const code = caught && typeof caught === "object" && "code" in caught ? String((caught as NodeJS.ErrnoException).code) : "";
    if (code === "EACCES" || code === "EPERM") {
      return `Permission denied for folder ${parent}. Metarr runs as uid ${process.getuid?.() ?? "?"} gid ${process.getgid?.() ?? "?"}; that folder must be traversable by that user or group.`;
    }
    if (code === "ENOENT") parentNote = ` The folder ${parent} is missing inside the container.`;
  }
  return `Cannot open ${filePath}.${parentNote} Add a path mapping in Settings if Plex uses a different path.`;
}
