import type { AudioTrack, SubtitleTrack } from "@/lib/types";
import type { StoredDetection } from "@/lib/detect/store";

export function detectionKey(path: string, kind: "audio" | "subtitle", ordinal: number): string {
  return `${path}\0${kind}\0${ordinal}`;
}

export function overlayAudio(path: string | null, tracks: AudioTrack[], detections: Map<string, StoredDetection>): AudioTrack[] {
  return tracks.map((track, index) => {
    const mediaPath = track.file ?? path;
    if (!mediaPath) return track;
    const ordinal = track.file ? 0 : (track.streamIndex ?? index);
    const found = detections.get(detectionKey(mediaPath, "audio", ordinal));
    if (!found) return track;
    const role = found.role === "commentary" || found.role === "short" ? found.role : null;
    return {
      ...track,
      ...(found.language ? { detectedLanguage: found.language } : {}),
      ...(role ? { detectedRole: role } : {}),
      ...(found.source === "file" ? { fromFile: true } : {}),
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
    return { ...track, detectedLanguage: found.language, ...(found.role === "forced" ? { forced: true } : {}) };
  });
}
