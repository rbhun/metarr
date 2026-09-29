import type Database from "better-sqlite3";
import { filesForLibrary, filesForSelection } from "@/lib/detect/files";
import type { ScanFile } from "@/lib/detect/targets";
import type { AudioTrack } from "@/lib/types";
import { finishedRewrapPaths, type RewrapItem } from "@/lib/rewrap/store";
import { isAvi, rewrappedPathFor } from "@/lib/rewrap/source";

export type RewrapCandidateView = {
  path: string;
  label: string;
  /** Set when the MKV is already on the title, or a real rewrap of this file finished. */
  converted: boolean;
  convertedPath: string | null;
  titleId: number | null;
};

function trackLanguages(tracks: AudioTrack[]): Array<string | null> {
  return tracks.map((track) => track.language || track.detectedLanguage || null);
}

/** Every AVI on a library file, with the audio languages Metarr already knows for it. */
export function avisFromFile(file: ScanFile): RewrapItem[] {
  const found: RewrapItem[] = [];
  const push = (filePath: string | null, container: string | null, tracks: AudioTrack[]) => {
    if (!filePath || !isAvi(container, filePath)) return;
    if (found.some((item) => item.path === filePath)) return;
    found.push({ path: filePath, label: file.label, languages: trackLanguages(tracks) });
  };
  push(file.path, file.container, file.audioTracks);
  for (const version of file.versions) push(version.path, version.container, version.audioTracks);
  return found;
}

function knownPaths(file: ScanFile): Array<string | null> {
  return [file.path, ...file.versions.map((version) => version.path)];
}

export function listRewrapCandidates(db: Database.Database): RewrapCandidateView[] {
  const seen = new Set<string>();
  const finished = finishedRewrapPaths(db);
  const candidates: RewrapCandidateView[] = [];
  for (const file of filesForLibrary(db)) {
    const paths = knownPaths(file);
    for (const avi of avisFromFile(file)) {
      if (seen.has(avi.path)) continue;
      seen.add(avi.path);
      const convertedPath = rewrappedPathFor(avi.path, paths);
      candidates.push({
        path: avi.path,
        label: avi.label ?? avi.path,
        converted: Boolean(convertedPath) || finished.has(avi.path),
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
    for (const avi of avisFromFile(file)) {
      if (!rewrappedPathFor(avi.path, paths)) items.push(avi);
    }
  }
  return items;
}
