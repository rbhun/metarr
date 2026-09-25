import type { AudioTrack, SubtitleTrack } from "@/lib/types";
import type { StoredDetection } from "@/lib/detect/store";

export function detectionKey(path: string, kind: "audio" | "subtitle", ordinal: number): string {
  return `${path}\0${kind}\0${ordinal}`;
}

export function overlayAudio(path: string | null, tracks: AudioTrack[], detections: Map<string, StoredDetection>): AudioTrack[] {
  if (!path) return tracks;
  return tracks.map((track, index) => {
    const found = detections.get(detectionKey(path, "audio", track.streamIndex ?? index));
    if (!found) return track;
    return {
      ...track,
      ...(found.language ? { detectedLanguage: found.language } : {}),
      ...(found.role ? { detectedRole: found.role } : {}),
    };
  });
}

export function overlaySubtitles(path: string | null, tracks: SubtitleTrack[], detections: Map<string, StoredDetection>): SubtitleTrack[] {
  return tracks.map((track, index) => {
    const external = track.placement === "external" && track.file ? track.file : null;
    const mediaPath = external ?? path;
    if (!mediaPath) return track;
    const ordinal = external ? 0 : (track.streamIndex ?? index);
    const found = detections.get(detectionKey(mediaPath, "subtitle", ordinal));
    if (!found?.language) return track;
    return { ...track, detectedLanguage: found.language };
  });
}
