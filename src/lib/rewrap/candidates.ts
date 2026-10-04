import type Database from "better-sqlite3";
import { filesForLibrary, filesForSelection } from "@/lib/detect/files";
import type { ScanFile } from "@/lib/detect/targets";
import type { AudioTrack, SubtitleTrack } from "@/lib/types";
import { finishedRewrapPaths, type RewrapItem } from "@/lib/rewrap/store";
import { canRewrap, joinedTarget, orderedSplit, rewrapFamily, rewrapSplit, rewrappedPathFor } from "@/lib/rewrap/source";

export type RewrapCandidateView = {
  path: string;
  /** Every part in a labeled split, in order. A single file is a one-item list. */
  paths: string[];
  label: string;
  /** Set when the MKV is already on the title, or a real rewrap of this file finished. */
  converted: boolean;
  convertedPath: string | null;
  titleId: number | null;
};

function trackLanguages(tracks: AudioTrack[]): Array<string | null> {
  return tracks.map((track) => track.language || track.detectedLanguage || null);
}

/** Languages of the subtitle streams inside the file, by stream order. Sidecar files keep their own names. */
export function subtitleStreamLanguages(tracks: SubtitleTrack[]): Array<string | null> {
  const languages: Array<string | null> = [];
  tracks
    .filter((track) => track.placement === "internal")
    .forEach((track, index) => {
      languages[track.streamIndex ?? index] = track.language || track.detectedLanguage || null;
    });
  return Array.from(languages, (language) => language ?? null);
}

/** Every AVI or loose transport stream on a library file, with the languages Metarr already knows for it. */
export function avisFromFile(file: ScanFile): RewrapItem[] {
  const found: RewrapItem[] = [];
  const push = (filePath: string | null, container: string | null, audio: AudioTrack[], subtitles: SubtitleTrack[]) => {
    if (!filePath || (!canRewrap(container, filePath) && !rewrapSplit(filePath))) return;
    if (found.some((item) => item.path === filePath)) return;
    found.push({ path: filePath, label: file.label, languages: trackLanguages(audio), subtitleLanguages: subtitleStreamLanguages(subtitles) });
  };
  push(file.path, file.container, file.audioTracks, file.subtitleTracks);
  for (const version of file.versions) push(version.path, version.container, version.audioTracks, version.subtitleTracks ?? []);
  return found;
}

function knownPaths(file: ScanFile): Array<string | null> {
  return [file.path, ...file.versions.map((version) => version.path)];
}

/** A complete CD1/CD2 set becomes one item. A missing part stays on its own. */
export function bundleRewraps(items: RewrapItem[]): RewrapItem[][] {
  const buckets = new Map<string, RewrapItem[]>();
  const singles: RewrapItem[][] = [];
  for (const item of items) {
    const split = rewrapSplit(item.path);
    const family = rewrapFamily(item.path);
    if (!split || !family) {
      singles.push([item]);
      continue;
    }
    const key = `${split.key}|${family}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  const groups = [...singles];
  for (const bucket of buckets.values()) {
    const ordered = orderedSplit(
      bucket.map((item) => {
        const split = rewrapSplit(item.path)!;
        return { path: item.path, index: split.index, total: split.total };
      }),
    );
    if (!ordered) {
      for (const item of bucket) {
        if (canRewrap(null, item.path)) groups.push([item]);
      }
      continue;
    }
    const byPath = new Map(bucket.map((item) => [item.path, item]));
    groups.push(ordered.map((member) => byPath.get(member.path)!));
  }
  return groups;
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase();
}

export function listRewrapCandidates(db: Database.Database): RewrapCandidateView[] {
  const seen = new Set<string>();
  const finished = finishedRewrapPaths(db);
  const candidates: RewrapCandidateView[] = [];
  for (const file of filesForLibrary(db)) {
    const paths = knownPaths(file);
    for (const group of bundleRewraps(avisFromFile(file))) {
      const lead = group[0];
      if (!lead || seen.has(lead.path)) continue;
      for (const item of group) seen.add(item.path);
      const joined = group.length > 1 ? joinedTarget(lead.path) : null;
      const joinedKnown = Boolean(joined && paths.some((item) => samePath(item, joined)));
      const eachDone = group.every((item) => finished.has(item.path) || Boolean(rewrappedPathFor(item.path, paths)));
      const convertedPath = group.length > 1 ? (joinedKnown ? joined : null) : rewrappedPathFor(lead.path, paths);
      candidates.push({
        path: lead.path,
        paths: group.map((item) => item.path),
        label: lead.label ?? lead.path,
        converted: group.length > 1 ? joinedKnown || eachDone : Boolean(convertedPath) || finished.has(lead.path),
        convertedPath,
        titleId: file.titleId ?? null,
      });
    }
  }
  candidates.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path));
  return candidates;
}

/** Library AVIs by path, so a pasted path still carries its title name and audio languages. */
export function libraryAvis(db: Database.Database): Map<string, RewrapItem> {
  const found = new Map<string, RewrapItem>();
  for (const file of filesForLibrary(db)) {
    for (const avi of avisFromFile(file)) if (!found.has(avi.path)) found.set(avi.path, avi);
  }
  return found;
}

/** AVIs on the chosen library titles or episodes that do not have their MKV yet. */
export function rewrapItemsForSelection(db: Database.Database, titles: number[], episodes: number[]): RewrapItem[] {
  const items: RewrapItem[] = [];
  for (const file of filesForSelection(db, titles, episodes)) {
    const paths = knownPaths(file);
    for (const group of bundleRewraps(avisFromFile(file))) {
      const lead = group[0];
      if (!lead) continue;
      if (group.length > 1) {
        const joined = joinedTarget(lead.path);
        const joinedKnown = Boolean(joined && paths.some((item) => samePath(item, joined)));
        if (joinedKnown || group.every((item) => rewrappedPathFor(item.path, paths))) continue;
        items.push(lead);
        continue;
      }
      if (!rewrappedPathFor(lead.path, paths)) items.push(lead);
    }
  }
  return items;
}
