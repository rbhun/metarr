import type { AudioTrack, SubtitleTrack } from "@/lib/types";

export type TrackCopy = { path: string; ordinal: number };

function subtitleCopy(videoPath: string | null, track: SubtitleTrack, index: number): TrackCopy | null {
  if (track.language || track.detectedLanguage || track.placement === "burn-in") return null;
  if (track.placement === "external" && track.file) return { path: track.file, ordinal: 0 };
  if (!videoPath) return null;
  return { path: videoPath, ordinal: track.streamIndex ?? index };
}

function audioCopy(videoPath: string | null, track: AudioTrack, index: number): TrackCopy | null {
  if (!videoPath || track.language || track.detectedLanguage) return null;
  return { path: videoPath, ordinal: track.streamIndex ?? index };
}

export function rollupSubtitles(files: Array<{ path: string | null; subtitleTracks: SubtitleTrack[] }>): SubtitleTrack[] {
  const rows = new Map<string, SubtitleTrack>();
  for (const file of files) {
    file.subtitleTracks.forEach((track, index) => {
      const shown = track.language || track.detectedLanguage || "";
      const key = `${shown}|${track.placement}|${track.format ?? ""}|${track.forced ? 1 : 0}|${track.streamIndex ?? ""}|${track.file ?? ""}`.toLowerCase();
      const copy = subtitleCopy(file.path, track, index);
      const existing = rows.get(key);
      if (!existing) {
        rows.set(key, { ...track, ...(copy ? { copies: [copy] } : {}) });
        return;
      }
      if (copy) existing.copies = [...(existing.copies ?? []), copy];
    });
  }
  return [...rows.values()];
}

export function rollupAudio(files: Array<{ path: string | null; audioTracks: AudioTrack[] }>): AudioTrack[] {
  const rows = new Map<string, AudioTrack>();
  for (const file of files) {
    file.audioTracks.forEach((track, index) => {
      const shown = track.language || track.detectedLanguage || "";
      const key = `${shown}|${track.layout ?? ""}|${track.codec ?? ""}|${track.streamIndex ?? ""}|${track.detectedRole ?? ""}`.toLowerCase();
      const copy = audioCopy(file.path, track, index);
      const existing = rows.get(key);
      if (!existing) {
        rows.set(key, { ...track, ...(copy ? { copies: [copy] } : {}) });
        return;
      }
      if (copy) existing.copies = [...(existing.copies ?? []), copy];
    });
  }
  return [...rows.values()];
}
