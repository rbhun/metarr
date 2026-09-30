import fs from "node:fs";
import path from "node:path";
import { subtitleStem } from "@/lib/detect/paths";
import { languageName, languageOptions } from "@/lib/media";
import type { SubtitleTrack } from "@/lib/types";

const SUBTITLE_EXT = /\.(srt|ass|ssa|vtt|sub|idx)$/i;
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|ts|wmv|mov|m2ts|mts|mpg|mpeg|webm)$/i;
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

function subtitleNames(videoPath: string, names: string[]): string[] {
  const base = path.basename(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  if (!stem) return [];
  const subs = names.filter((name) => SUBTITLE_EXT.test(path.basename(name)));
  const matched = subs.filter((name) => path.basename(name).toLowerCase().startsWith(stem));
  if (matched.length > 0) return matched;
  const videoKey = subtitleStem(base);
  const byStem = videoKey ? subs.filter((name) => subtitleStem(path.basename(name)) === videoKey) : [];
  if (byStem.length > 0) return byStem;
  if (subs.length !== 1) return [];
  const otherVideo = names.some((name) => VIDEO_EXT.test(name) && path.basename(name) === name && name !== base);
  return otherVideo ? [] : subs;
}

export function sidecarsIn(videoPath: string, names: string[]): Sidecar[] {
  const directory = path.dirname(videoPath);
  return subtitleNames(videoPath, names)
    .map((name) => ({ file: path.join(directory, name), language: languageFromSubtitleName(name) }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function sameLanguage(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return (languageName(left) ?? left).toLowerCase() === (languageName(right) ?? right).toLowerCase();
}

/** Keep a Plex path only when that sidecar is still on disk (same path or unique basename). */
function liveSidecarFile(file: string, sidecars: Sidecar[]): string | null {
  if (sidecars.some((sidecar) => sidecar.file === file)) return file;
  const base = path.basename(file);
  const matches = sidecars.filter((sidecar) => path.basename(sidecar.file) === base);
  return matches.length === 1 ? matches[0]!.file : null;
}

export function assignSidecars(videoPath: string | null, tracks: SubtitleTrack[], names: string[]): SubtitleTrack[] {
  if (!videoPath || names.length === 0) return tracks;
  const sidecars = sidecarsIn(videoPath, names);
  if (sidecars.length === 0) return tracks;
  const used = new Set<string>();
  const next = tracks.map((track) => {
    const copy = { ...track };
    if (copy.placement !== "external") return copy;
    if (copy.file) {
      const live = liveSidecarFile(copy.file, sidecars);
      copy.file = live;
      if (!live) {
        // Stale Plex path — rematch below.
      } else {
        const fromName = languageFromSubtitleName(path.basename(live));
        if (fromName && !copy.language) copy.language = fromName;
        used.add(live);
      }
    }
    return copy;
  });
  for (const track of next) {
    if (track.file || track.placement !== "external" || !track.language) continue;
    const match = sidecars.find((sidecar) => !used.has(sidecar.file) && sameLanguage(sidecar.language, track.language));
    if (!match) continue;
    track.file = match.file;
    used.add(match.file);
  }
  const unfilled = next.filter((track) => track.placement === "external" && !track.file);
  const leftover = sidecars.filter((sidecar) => !used.has(sidecar.file));
  if (unfilled.length === 1 && leftover.length === 1) {
    const track = unfilled[0];
    const choice = leftover[0];
    if (track && choice && (!track.language || !choice.language || sameLanguage(track.language, choice.language))) {
      track.file = choice.file;
      used.add(choice.file);
      if (!track.language && choice.language) track.language = choice.language;
    }
  }
  const unknown = next.filter((track) => track.placement === "external" && !track.language && !track.file && !track.detectedLanguage);
  const remaining = sidecars.filter((sidecar) => !used.has(sidecar.file));
  // Prefer named leftovers so a bare Plex path can land on .hun / .en.hi without content detection.
  for (const sidecar of remaining) {
    if (!sidecar.language) continue;
    const track = unknown.find((item) => !item.file);
    if (!track) break;
    track.file = sidecar.file;
    track.language = sidecar.language;
    used.add(sidecar.file);
  }
  const stillUnknown = next.filter((track) => track.placement === "external" && !track.language && !track.file && !track.detectedLanguage);
  const stillRemaining = sidecars.filter((sidecar) => !used.has(sidecar.file));
  const claimed = next.map((track) => track.language).filter((language): language is string => Boolean(language));
  const open = stillRemaining.filter((sidecar) => !sidecar.language || !claimed.some((language) => sameLanguage(sidecar.language, language)));
  const choice = stillUnknown.length === 1 ? (open.length === 1 ? open[0] : stillRemaining.length === 1 ? stillRemaining[0] : null) : null;
  if (stillUnknown[0] && choice) {
    stillUnknown[0].file = choice.file;
    if (choice.language) stillUnknown[0].language = choice.language;
  }
  return next;
}

const SUBTITLE_DIRS = ["subs", "Subs", "subtitles", "Subtitles"];

export function readSidecarNames(videoPath: string | null): string[] {
  if (!videoPath) return [];
  const directory = path.dirname(videoPath);
  const cached = listed.get(directory);
  if (cached) return cached;
  try {
    const names = fs.readdirSync(directory);
    const nested: string[] = [];
    for (const folder of SUBTITLE_DIRS) {
      if (!names.includes(folder)) continue;
      const subdirectory = path.join(directory, folder);
      try {
        if (!fs.statSync(subdirectory).isDirectory()) continue;
        for (const name of fs.readdirSync(subdirectory)) {
          if (SUBTITLE_EXT.test(name)) nested.push(path.join(folder, name));
        }
      } catch {
        continue;
      }
    }
    const found = [...names, ...nested];
    listed.set(directory, found);
    return found;
  } catch {
    listed.set(directory, []);
    return [];
  }
}
