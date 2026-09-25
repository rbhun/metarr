import { mergeAudioTracks, mergeLanguages, mergeSubtitleTracks, summarizeFiles } from "@/lib/media";
import type { MediaFile, SourceDraft } from "@/lib/types";

export function sourceDraft(
  partial: Pick<SourceDraft, "connector" | "kind" | "externalKey" | "title"> & Partial<SourceDraft>,
): SourceDraft {
  return {
    seriesTitle: null,
    year: null,
    season: null,
    episode: null,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    guid: null,
    parentKey: null,
    hasFile: false,
    wanted: false,
    monitored: false,
    container: null,
    path: null,
    qualityName: null,
    resolution: null,
    hdr: "none",
    is3d: false,
    audioLanguages: [],
    subtitleLanguages: [],
    subtitleWanted: [],
    audioTracks: [],
    subtitleTracks: [],
    posterPath: null,
    runtimeMinutes: null,
    notes: null,
    rating: null,
    contentRating: null,
    genres: [],
    files: [],
    airDate: null,
    ...partial,
  };
}

export function withMedia(draft: SourceDraft, files: MediaFile[], hints: Array<string | null | undefined> = []): SourceDraft {
  const summary = summarizeFiles(files, [draft.title, ...hints]);
  return {
    ...draft,
    files,
    hasFile: summary.hasFile,
    container: summary.container ?? draft.container,
    path: summary.path ?? draft.path,
    qualityName: summary.qualityName ?? draft.qualityName,
    resolution: summary.resolution ?? draft.resolution,
    hdr: summary.hdr === "none" ? draft.hdr : summary.hdr,
    is3d: summary.is3d || draft.is3d,
    audioLanguages: mergeLanguages(draft.audioLanguages, summary.audioLanguages),
    subtitleLanguages: mergeLanguages(draft.subtitleLanguages, summary.subtitleLanguages),
    audioTracks: mergeAudioTracks([draft.audioTracks, summary.audioTracks]),
    subtitleTracks: mergeSubtitleTracks([draft.subtitleTracks, summary.subtitleTracks]),
  };
}
