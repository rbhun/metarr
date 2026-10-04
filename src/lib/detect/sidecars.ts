import fs from "node:fs";
import path from "node:path";
import { audioCodecFromName, isAudioFile, languageFromAudioName } from "@/lib/detect/audio-name";
import { subtitleStem } from "@/lib/detect/paths";
import { isSubtitleFile, languageFromSubtitleName } from "@/lib/detect/subtitle-name";
import { dedupeExternalSubtitles, languageName } from "@/lib/media";
import type { AudioTrack, SubtitleTrack } from "@/lib/types";

export { isSubtitleFile, languageFromSubtitleName };
export { isAudioFile, languageFromAudioName };

const SUBTITLE_EXT = /\.(srt|ass|ssa|vtt|sub|idx)$/i;
const AUDIO_EXT = /\.(ac3|eac3|dts|dtshd|dtsma|truehd|thd|flac|mka|aac|m4a|wav|mp3|ogg|opus)$/i;
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|ts|wmv|mov|m2ts|mts|mpg|mpeg|webm)$/i;
const listed = new Map<string, { names: string[]; at: number }>();

export type Sidecar = { file: string; language: string | null };

function longerVideoStems(videoPath: string, names: string[]): string[] {
  const base = path.basename(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  if (!stem) return [];
  // Another video whose name starts with this one ("Film" and "Film Extended") owns its own sidecars.
  return names
    .filter((name) => VIDEO_EXT.test(name) && path.basename(name) === name && name !== base)
    .map((name) => path.basename(name, path.extname(name)).toLowerCase())
    .filter((other) => other.length > stem.length && other.startsWith(stem));
}

function matchingSidecarNames(videoPath: string, names: string[], extension: RegExp): string[] {
  const base = path.basename(videoPath);
  const stem = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  if (!stem) return [];
  const longer = longerVideoStems(videoPath, names);
  const sidecars = names.filter((name) => {
    const lower = path.basename(name).toLowerCase();
    return extension.test(lower) && !longer.some((other) => lower.startsWith(other));
  });
  const matched = sidecars.filter((name) => path.basename(name).toLowerCase().startsWith(stem));
  if (matched.length > 0) return matched;
  const videoKey = subtitleStem(base);
  const byStem = videoKey ? sidecars.filter((name) => subtitleStem(path.basename(name)) === videoKey) : [];
  if (byStem.length > 0) return byStem;
  if (sidecars.length !== 1) return [];
  const otherVideo = names.some((name) => VIDEO_EXT.test(name) && path.basename(name) === name && name !== base);
  return otherVideo ? [] : sidecars;
}

function subtitleNames(videoPath: string, names: string[]): string[] {
  return matchingSidecarNames(videoPath, names, SUBTITLE_EXT);
}

function audioNames(videoPath: string, names: string[]): string[] {
  return matchingSidecarNames(videoPath, names, AUDIO_EXT);
}

export function sidecarsIn(videoPath: string, names: string[]): Sidecar[] {
  const directory = path.dirname(videoPath);
  return subtitleNames(videoPath, names)
    .map((name) => ({ file: path.join(directory, name), language: languageFromSubtitleName(name) }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

export function audioSidecarsIn(videoPath: string, names: string[]): Sidecar[] {
  const directory = path.dirname(videoPath);
  return audioNames(videoPath, names)
    .map((name) => ({ file: path.join(directory, name), language: languageFromAudioName(path.basename(name)) }))
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
  const held = new Set<SubtitleTrack>();
  const next = tracks.map((track) => {
    const copy = { ...track };
    if (copy.placement !== "external") return copy;
    // The folder scan already found no file for this Plex subtitle; a different sidecar is not it.
    if (!copy.file && copy.sources?.file === null) {
      held.add(copy);
      return copy;
    }
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
  const open = (track: SubtitleTrack) => track.placement === "external" && !track.file && !held.has(track);
  for (const track of next) {
    if (!open(track) || !track.language) continue;
    const match = sidecars.find((sidecar) => !used.has(sidecar.file) && sameLanguage(sidecar.language, track.language));
    if (!match) continue;
    track.file = match.file;
    used.add(match.file);
  }
  const unfilled = next.filter(open);
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
  const unknown = next.filter((track) => open(track) && !track.language && !track.detectedLanguage);
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
  const stillUnknown = next.filter((track) => open(track) && !track.language && !track.detectedLanguage);
  const stillRemaining = sidecars.filter((sidecar) => !used.has(sidecar.file));
  const claimed = next.map((track) => track.language).filter((language): language is string => Boolean(language));
  const unclaimed = stillRemaining.filter((sidecar) => !sidecar.language || !claimed.some((language) => sameLanguage(sidecar.language, language)));
  const choice = stillUnknown.length === 1 ? (unclaimed.length === 1 ? unclaimed[0] : stillRemaining.length === 1 ? stillRemaining[0] : null) : null;
  if (stillUnknown[0] && choice) {
    stillUnknown[0].file = choice.file;
    if (choice.language) stillUnknown[0].language = choice.language;
  }
  return dedupeExternalSubtitles(next);
}

/** The subtitle files on disk that belong to this video, as folder-scan tracks. */
export function sidecarTracks(videoPath: string, names: string[] = readSidecarNames(videoPath)): SubtitleTrack[] {
  const found = sidecarsIn(videoPath, names).filter((sidecar) => {
    const pair = sidecar.file.replace(/\.sub$/i, ".idx");
    return pair === sidecar.file || !names.some((name) => path.join(path.dirname(videoPath), name) === pair);
  });
  return found.map((sidecar) => ({
    language: sidecar.language,
    placement: "external" as const,
    format: subtitleFormatOf(sidecar.file),
    forced: /[._\-\s]forced[._\-\s]/i.test(`${path.basename(sidecar.file)} `),
    file: sidecar.file,
    fromFile: true,
  }));
}

/** Separate audio files beside the video (or in an audio subfolder). Plex does not list these. */
export function audioSidecarTracks(videoPath: string, names: string[] = readSidecarNames(videoPath)): AudioTrack[] {
  return audioSidecarsIn(videoPath, names).map((sidecar) => ({
    language: sidecar.language,
    layout: null,
    codec: audioCodecFromName(path.basename(sidecar.file)),
    file: sidecar.file,
    fromFile: true,
    folderOnly: true,
    sources: { plex: null, file: sidecar.file },
    conflict: FOLDER_ONLY_AUDIO,
  }));
}

/** Keep stored audio tracks and append separate audio files found beside the video. */
export function withAudioSidecars(videoPath: string | null, tracks: AudioTrack[], names?: string[]): AudioTrack[] {
  if (!videoPath) return tracks;
  const found = audioSidecarTracks(videoPath, names ?? readSidecarNames(videoPath));
  if (!found.length) return tracks;
  const have = new Set(tracks.map((track) => track.file).filter((file): file is string => Boolean(file)));
  const extras = found.filter((track) => track.file && !have.has(track.file));
  return extras.length ? [...tracks, ...extras] : tracks;
}

export const FOLDER_ONLY_AUDIO =
  "This audio file is beside the video, but Plex does not list separate audio files.";

function subtitleFormatOf(file: string): string | null {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === "idx" || ext === "sub") return "VobSub";
  return ext ? ext.toUpperCase() : null;
}

const SUBTITLE_DIRS = ["subs", "Subs", "subtitles", "Subtitles"];
const AUDIO_DIRS = ["audio", "Audio", "AUDIO"];

/** Folder listings are reused briefly so a library page does not re-read every folder, but renames still show. */
const LISTING_MS = 60_000;

export function readSidecarNames(videoPath: string | null): string[] {
  if (!videoPath) return [];
  const directory = path.dirname(videoPath);
  const cached = listed.get(directory);
  if (cached && Date.now() - cached.at < LISTING_MS) return cached.names;
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
    for (const folder of AUDIO_DIRS) {
      if (!names.includes(folder)) continue;
      const subdirectory = path.join(directory, folder);
      try {
        if (!fs.statSync(subdirectory).isDirectory()) continue;
        for (const name of fs.readdirSync(subdirectory)) {
          if (AUDIO_EXT.test(name)) nested.push(path.join(folder, name));
        }
      } catch {
        continue;
      }
    }
    const found = [...names, ...nested];
    listed.set(directory, { names: found, at: Date.now() });
    return found;
  } catch {
    listed.set(directory, { names: [], at: Date.now() });
    return [];
  }
}
