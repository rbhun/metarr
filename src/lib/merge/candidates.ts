import type Database from "better-sqlite3";
import { filesForLibrary } from "@/lib/detect/files";
import type { ScanFile } from "@/lib/detect/targets";
import { durationsCloseMinutes } from "@/lib/merge/compare";
import { pickVideoSource } from "@/lib/merge/quality";
import { canMergeVersion } from "@/lib/merge/source";
import { languageName, sameSpokenLanguage } from "@/lib/media";
import type { HdrLabel, MediaVersion, PlayableLabel } from "@/lib/types";

export type MergeVersionView = {
  path: string;
  name: string;
  resolution: string | null;
  bitrateKbps: number | null;
  fileBytes: number | null;
  hdr: HdrLabel;
  edition: string | null;
  durationMinutes: number | null;
  audioLanguages: string[];
  subtitleLanguages: string[];
  flags: string[];
  playableLabel: PlayableLabel;
  container: string | null;
};

export type MergeCandidate = {
  key: string;
  titleId: number | null;
  label: string;
  left: MergeVersionView;
  right: MergeVersionView;
  videoFrom: "left" | "right";
  durationDeltaMinutes: number | null;
  audioOnlyLeft: string[];
  audioOnlyRight: string[];
  subtitleOnlyLeft: string[];
  subtitleOnlyRight: string[];
  editionConflict: boolean;
  reason: string;
};

function namedLanguages(values: string[]): string[] {
  const named: string[] = [];
  for (const value of values) {
    const language = languageName(value);
    if (!language) continue;
    if (!named.some((item) => sameSpokenLanguage(item, language))) named.push(language);
  }
  return named;
}

export function languagesOnlyIn(left: string[], right: string[]): string[] {
  return namedLanguages(left).filter((language) => !namedLanguages(right).some((other) => sameSpokenLanguage(language, other)));
}

function editionConflict(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return left.toLowerCase() !== right.toLowerCase();
}

function toView(version: MediaVersion): MergeVersionView | null {
  if (!version.path || !canMergeVersion(version.playableLabel, version.container, version.path)) return null;
  if (version.flags.includes("sample") || version.flags.includes("short")) return null;
  return {
    path: version.path,
    name: version.name,
    resolution: version.resolution,
    bitrateKbps: version.bitrateKbps,
    fileBytes: version.fileBytes,
    hdr: version.hdr,
    edition: version.edition,
    durationMinutes: version.durationMinutes,
    audioLanguages: namedLanguages(version.audioLanguages),
    subtitleLanguages: namedLanguages(version.subtitleLanguages),
    flags: version.flags,
    playableLabel: version.playableLabel,
    container: version.container,
  };
}

function versionsOf(file: ScanFile): MergeVersionView[] {
  const views: MergeVersionView[] = [];
  const seen = new Set<string>();
  for (const version of file.versions) {
    const view = toView(version);
    if (!view || seen.has(view.path)) continue;
    seen.add(view.path);
    views.push(view);
  }
  return views;
}

export function pairCandidates(file: ScanFile): MergeCandidate[] {
  const versions = versionsOf(file);
  const pairs: MergeCandidate[] = [];
  for (let i = 0; i < versions.length; i += 1) {
    for (let j = i + 1; j < versions.length; j += 1) {
      const left = versions[i]!;
      const right = versions[j]!;
      const duration = durationsCloseMinutes(left.durationMinutes, right.durationMinutes);
      if (!duration.ok) continue;
      const audioOnlyLeft = languagesOnlyIn(left.audioLanguages, right.audioLanguages);
      const audioOnlyRight = languagesOnlyIn(right.audioLanguages, left.audioLanguages);
      if (audioOnlyLeft.length === 0 && audioOnlyRight.length === 0) continue;
      const subtitleOnlyLeft = languagesOnlyIn(left.subtitleLanguages, right.subtitleLanguages);
      const subtitleOnlyRight = languagesOnlyIn(right.subtitleLanguages, left.subtitleLanguages);
      const videoFrom = pickVideoSource(left, right);
      const conflict = editionConflict(left.edition, right.edition);
      const audioParts = [
        audioOnlyLeft.length ? `${audioOnlyLeft.join(", ")} only on ${left.name}` : null,
        audioOnlyRight.length ? `${audioOnlyRight.join(", ")} only on ${right.name}` : null,
      ].filter(Boolean);
      pairs.push({
        key: `${left.path}\0${right.path}`,
        titleId: file.titleId ?? null,
        label: file.label,
        left,
        right,
        videoFrom,
        durationDeltaMinutes: duration.deltaSeconds == null ? null : duration.deltaSeconds / 60,
        audioOnlyLeft,
        audioOnlyRight,
        subtitleOnlyLeft,
        subtitleOnlyRight,
        editionConflict: conflict,
        reason: conflict
          ? `Same length, but labels say ${left.edition} and ${right.edition}. ${audioParts.join("; ")}.`
          : `Same length (±${Math.round(duration.toleranceSeconds / 60)} min). ${audioParts.join("; ")}.`,
      });
    }
  }
  return pairs;
}

export function listMergeCandidates(db: Database.Database, search = ""): MergeCandidate[] {
  const needle = search.trim().toLowerCase();
  const candidates: MergeCandidate[] = [];
  const seen = new Set<string>();
  for (const file of filesForLibrary(db)) {
    if (needle && !file.label.toLowerCase().includes(needle) && !(file.path ?? "").toLowerCase().includes(needle)) continue;
    for (const pair of pairCandidates(file)) {
      if (seen.has(pair.key)) continue;
      seen.add(pair.key);
      candidates.push(pair);
    }
  }
  candidates.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.left.name.localeCompare(b.left.name));
  return candidates;
}

export function mergeCandidateForPaths(db: Database.Database, leftPath: string, rightPath: string): MergeCandidate | null {
  const left = leftPath.trim();
  const right = rightPath.trim();
  if (!left || !right || left === right) return null;
  for (const file of filesForLibrary(db)) {
    for (const pair of pairCandidates(file)) {
      if (pair.left.path === left && pair.right.path === right) return pair;
      if (pair.left.path === right && pair.right.path === left) {
        return {
          ...pair,
          left: pair.right,
          right: pair.left,
          videoFrom: pair.videoFrom === "left" ? "right" : "left",
          audioOnlyLeft: pair.audioOnlyRight,
          audioOnlyRight: pair.audioOnlyLeft,
          subtitleOnlyLeft: pair.subtitleOnlyRight,
          subtitleOnlyRight: pair.subtitleOnlyLeft,
        };
      }
    }
  }
  return null;
}

/** Build a candidate from two known version views when the catalog search misses them. */
export function candidateFromVersions(
  label: string,
  titleId: number | null,
  left: MergeVersionView,
  right: MergeVersionView,
): MergeCandidate | null {
  const duration = durationsCloseMinutes(left.durationMinutes, right.durationMinutes);
  if (!duration.ok) return null;
  const audioOnlyLeft = languagesOnlyIn(left.audioLanguages, right.audioLanguages);
  const audioOnlyRight = languagesOnlyIn(right.audioLanguages, left.audioLanguages);
  if (audioOnlyLeft.length === 0 && audioOnlyRight.length === 0) return null;
  const videoFrom = pickVideoSource(left, right);
  const conflict = editionConflict(left.edition, right.edition);
  return {
    key: `${left.path}\0${right.path}`,
    titleId,
    label,
    left,
    right,
    videoFrom,
    durationDeltaMinutes: duration.deltaSeconds == null ? null : duration.deltaSeconds / 60,
    audioOnlyLeft,
    audioOnlyRight,
    subtitleOnlyLeft: languagesOnlyIn(left.subtitleLanguages, right.subtitleLanguages),
    subtitleOnlyRight: languagesOnlyIn(right.subtitleLanguages, left.subtitleLanguages),
    editionConflict: conflict,
    reason: conflict
      ? `Same length, but labels say ${left.edition} and ${right.edition}.`
      : "Same length with complementary audio.",
  };
}
