import fs from "node:fs";
import path from "node:path";
import { languageName, languageOptions } from "@/lib/media";
import type { SubtitleTrack } from "@/lib/types";

const SUBTITLE_EXT = /\.(srt|ass|ssa|vtt|sub|idx)$/i;
const SKIP_TOKEN = /^(forced|sdh|cc|foreign|normal|default|hi)$/i;
const KNOWN = new Set(languageOptions().map((name) => name.toLowerCase()));
const listed = new Map<string, string[]>();

export function isSubtitleFile(file: string): boolean {
  return SUBTITLE_EXT.test(file);
}

export function languageFromSubtitleName(fileName: string): string | null {
  const stem = fileName.replace(SUBTITLE_EXT, "");
  const parts = stem.split(/[._\-\s]+/).filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const token = parts[index];
    if (!token || SKIP_TOKEN.test(token)) continue;
    const named = languageName(token);
    if (!named) continue;
    const tokenKey = token.toLowerCase();
    const namedKey = named.toLowerCase();
    if (KNOWN.has(tokenKey)) return languageOptions().find((option) => option.toLowerCase() === tokenKey) ?? named;
    if (KNOWN.has(namedKey) && namedKey !== tokenKey) return named;
  }
  return null;
}

export type Sidecar = { file: string; language: string | null };

export function sidecarsIn(videoPath: string, names: string[]): Sidecar[] {
  const directory = path.dirname(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  if (!stem) return [];
  return names
    .filter((name) => SUBTITLE_EXT.test(name) && name.toLowerCase().startsWith(stem))
    .map((name) => ({ file: path.join(directory, name), language: languageFromSubtitleName(name) }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function sameLanguage(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return (languageName(left) ?? left).toLowerCase() === (languageName(right) ?? right).toLowerCase();
}

export function assignSidecars(videoPath: string | null, tracks: SubtitleTrack[], names: string[]): SubtitleTrack[] {
  if (!videoPath || names.length === 0) return tracks;
  const sidecars = sidecarsIn(videoPath, names);
  if (sidecars.length === 0) return tracks;
  const used = new Set<string>();
  const next = tracks.map((track) => ({ ...track }));
  for (const track of next) {
    if (track.file || track.placement !== "external" || !track.language) continue;
    const match = sidecars.find((sidecar) => !used.has(sidecar.file) && sameLanguage(sidecar.language, track.language));
    if (!match) continue;
    track.file = match.file;
    used.add(match.file);
  }
  const unknown = next.filter((track) => track.placement === "external" && !track.language && !track.file && !track.detectedLanguage);
  const remaining = sidecars.filter((sidecar) => !used.has(sidecar.file));
  const claimed = next.map((track) => track.language).filter((language): language is string => Boolean(language));
  const open = remaining.filter((sidecar) => !sidecar.language || !claimed.some((language) => sameLanguage(sidecar.language, language)));
  const choice = unknown.length === 1 ? (open.length === 1 ? open[0] : remaining.length === 1 ? remaining[0] : null) : null;
  if (unknown[0] && choice) {
    unknown[0].file = choice.file;
    if (choice.language) unknown[0].language = choice.language;
  }
  return next;
}

export function readSidecarNames(videoPath: string | null): string[] {
  if (!videoPath) return [];
  const directory = path.dirname(videoPath);
  const cached = listed.get(directory);
  if (cached) return cached;
  try {
    const names = fs.readdirSync(directory);
    listed.set(directory, names);
    return names;
  } catch {
    listed.set(directory, []);
    return [];
  }
}
