import type Database from "better-sqlite3";
import { filesForLibrary, filesForSelection } from "@/lib/detect/files";
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

export type MergePairOptions = {
  maxDurationDeltaMinutes?: number | null;
};

export type MergePairInspect = {
  key: string;
  left: MergeVersionView;
  right: MergeVersionView;
  videoFrom: "left" | "right";
  durationDeltaMinutes: number | null;
  eligible: boolean;
  reason: string;
  candidate: MergeCandidate | null;
};

export type MergeTitleInspect = {
  titleId: number;
  label: string;
  versions: MergeVersionView[];
  pairs: MergePairInspect[];
  eligibleCount: number;
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

/**
 * Audio on the non-video file that the video source lacks.
 * Extra languages already on the better file do not make a useful merge.
 */
export function donorAudioLanguages(
  left: Pick<MergeVersionView, "audioLanguages">,
  right: Pick<MergeVersionView, "audioLanguages">,
  videoFrom: "left" | "right",
): string[] {
  return videoFrom === "left"
    ? languagesOnlyIn(right.audioLanguages, left.audioLanguages)
    : languagesOnlyIn(left.audioLanguages, right.audioLanguages);
}

/** Untagged or empty audio on either file is not enough to justify a merge. */
export function bothHaveKnownAudio(
  left: Pick<MergeVersionView, "audioLanguages">,
  right: Pick<MergeVersionView, "audioLanguages">,
): boolean {
  return namedLanguages(left.audioLanguages).length > 0 && namedLanguages(right.audioLanguages).length > 0;
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

function formatTolerance(minutes: number): string {
  if (minutes === 0) return "0 min";
  if (Number.isInteger(minutes)) return `${minutes} min`;
  return `${minutes} min`;
}

/** Score one pair; used for the auto list and for a manual title check. */
export function evaluatePair(
  file: ScanFile,
  left: MergeVersionView,
  right: MergeVersionView,
  options: MergePairOptions = {},
): MergePairInspect {
  const key = `${left.path}\0${right.path}`;
  const videoFrom = pickVideoSource(left, right);
  const duration = durationsCloseMinutes(left.durationMinutes, right.durationMinutes, options.maxDurationDeltaMinutes);
  const durationDeltaMinutes = duration.deltaSeconds == null ? null : duration.deltaSeconds / 60;
  const base = { key, left, right, videoFrom, durationDeltaMinutes };

  if (left.durationMinutes == null || right.durationMinutes == null) {
    return { ...base, eligible: false, reason: "One or both files have no known runtime.", candidate: null };
  }
  if (!duration.ok) {
    const delta = durationDeltaMinutes == null ? "?" : String(Math.round(durationDeltaMinutes * 10) / 10);
    const allowed = formatTolerance(duration.toleranceSeconds / 60);
    return {
      ...base,
      eligible: false,
      reason: `Runtimes differ by ${delta} min (allowed ${allowed}).`,
      candidate: null,
    };
  }
  if (!bothHaveKnownAudio(left, right)) {
    return { ...base, eligible: false, reason: "Both files need a known audio language.", candidate: null };
  }
  const donorAudio = donorAudioLanguages(left, right, videoFrom);
  if (donorAudio.length === 0) {
    return {
      ...base,
      eligible: false,
      reason: "The other file adds no audio language the better video source lacks.",
      candidate: null,
    };
  }

  const audioOnlyLeft = languagesOnlyIn(left.audioLanguages, right.audioLanguages);
  const audioOnlyRight = languagesOnlyIn(right.audioLanguages, left.audioLanguages);
  const subtitleOnlyLeft = languagesOnlyIn(left.subtitleLanguages, right.subtitleLanguages);
  const subtitleOnlyRight = languagesOnlyIn(right.subtitleLanguages, left.subtitleLanguages);
  const conflict = editionConflict(left.edition, right.edition);
  const donor = videoFrom === "left" ? right : left;
  const audioParts = `${donorAudio.join(", ")} from ${donor.name}`;
  const reason = conflict
    ? `Same length, but labels say ${left.edition} and ${right.edition}. Adds ${audioParts}.`
    : `Same length (±${formatTolerance(duration.toleranceSeconds / 60)}). Adds ${audioParts}.`;
  const candidate: MergeCandidate = {
    key,
    titleId: file.titleId ?? null,
    label: file.label,
    left,
    right,
    videoFrom,
    durationDeltaMinutes,
    audioOnlyLeft,
    audioOnlyRight,
    subtitleOnlyLeft,
    subtitleOnlyRight,
    editionConflict: conflict,
    reason,
  };
  return { ...base, eligible: true, reason, candidate };
}

export function pairCandidates(file: ScanFile, options: MergePairOptions = {}): MergeCandidate[] {
  const versions = versionsOf(file);
  const pairs: MergeCandidate[] = [];
  for (let i = 0; i < versions.length; i += 1) {
    for (let j = i + 1; j < versions.length; j += 1) {
      const verdict = evaluatePair(file, versions[i]!, versions[j]!, options);
      if (verdict.candidate) pairs.push(verdict.candidate);
    }
  }
  return pairs;
}

export function listMergeCandidates(db: Database.Database, search = "", options: MergePairOptions = {}): MergeCandidate[] {
  const needle = search.trim().toLowerCase();
  const candidates: MergeCandidate[] = [];
  const seen = new Set<string>();
  for (const file of filesForLibrary(db)) {
    if (needle && !file.label.toLowerCase().includes(needle) && !(file.path ?? "").toLowerCase().includes(needle)) continue;
    for (const pair of pairCandidates(file, options)) {
      if (seen.has(pair.key)) continue;
      seen.add(pair.key);
      candidates.push(pair);
    }
  }
  candidates.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.left.name.localeCompare(b.left.name));
  return candidates;
}

export function mergeCandidateForPaths(
  db: Database.Database,
  leftPath: string,
  rightPath: string,
  options: MergePairOptions = {},
): MergeCandidate | null {
  const left = leftPath.trim();
  const right = rightPath.trim();
  if (!left || !right || left === right) return null;
  for (const file of filesForLibrary(db)) {
    for (const pair of pairCandidates(file, options)) {
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
  options: MergePairOptions = {},
): MergeCandidate | null {
  return evaluatePair({ titleId: titleId ?? undefined, label, path: left.path, container: left.container, playableLabel: left.playableLabel, audioTracks: [], subtitleTracks: [], versions: [] }, left, right, options)
    .candidate;
}

/** Manual check: every version pair on a library title, with why each is or is not eligible. */
export function inspectTitleMerge(db: Database.Database, titleId: number, options: MergePairOptions = {}): MergeTitleInspect | null {
  if (!Number.isInteger(titleId) || titleId < 1) return null;
  const files = filesForSelection(db, [titleId], []);
  if (!files.length) return null;
  // Movies are one ScanFile; series yield many episodes — inspect each file that has versions.
  const pairs: MergePairInspect[] = [];
  const versions: MergeVersionView[] = [];
  const seenVersion = new Set<string>();
  let label = files[0]!.label;
  for (const file of files) {
    if (files.length === 1) label = file.label;
    const fileVersions = versionsOf(file);
    for (const version of fileVersions) {
      if (seenVersion.has(version.path)) continue;
      seenVersion.add(version.path);
      versions.push(version);
    }
    for (let i = 0; i < fileVersions.length; i += 1) {
      for (let j = i + 1; j < fileVersions.length; j += 1) {
        pairs.push(evaluatePair(file, fileVersions[i]!, fileVersions[j]!, options));
      }
    }
  }
  if (files.length > 1) {
    const row = db.prepare(`SELECT title, year FROM catalog_titles WHERE id = ?`).get(titleId) as { title: string; year: number | null } | undefined;
    if (row) label = row.year ? `${row.title} (${row.year})` : row.title;
  }
  return {
    titleId,
    label,
    versions,
    pairs,
    eligibleCount: pairs.filter((pair) => pair.eligible).length,
  };
}

/** Resolve a title id from a pasted id or an exact/partial label match for manual check. */
export function resolveTitleIdForMerge(db: Database.Database, raw: string): { titleId: number; label: string } | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const id = Number(text);
    const row = db.prepare(`SELECT id, title, year FROM catalog_titles WHERE id = ?`).get(id) as
      | { id: number; title: string; year: number | null }
      | undefined;
    if (!row) return null;
    return { titleId: row.id, label: row.year ? `${row.title} (${row.year})` : row.title };
  }
  const needle = text.toLowerCase();
  const rows = db.prepare(`SELECT id, title, year FROM catalog_titles ORDER BY title COLLATE NOCASE`).all() as Array<{
    id: number;
    title: string;
    year: number | null;
  }>;
  const scored = rows
    .map((row) => {
      const label = row.year ? `${row.title} (${row.year})` : row.title;
      const lower = label.toLowerCase();
      const titleLower = row.title.toLowerCase();
      let score = 0;
      if (lower === needle || titleLower === needle) score = 3;
      else if (lower.startsWith(needle) || titleLower.startsWith(needle)) score = 2;
      else if (lower.includes(needle) || titleLower.includes(needle)) score = 1;
      return { id: row.id, label, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  if (!scored.length) return null;
  return { titleId: scored[0]!.id, label: scored[0]!.label };
}
