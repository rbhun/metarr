import type { DetectTarget } from "@/lib/detect/targets";
import type { AudioTrack, SubtitleTrack } from "@/lib/types";

export function audioTarget(path: string | null, track: AudioTrack, index: number, label: string): DetectTarget | null {
  if (!path || track.language || track.detectedLanguage) return null;
  return {
    path,
    kind: "audio",
    ordinal: track.streamIndex ?? index,
    label,
    format: track.codec,
    placement: null,
    streamLabel: track.label ?? null,
  };
}

export function subtitleTarget(path: string | null, track: SubtitleTrack, index: number, label: string): DetectTarget | null {
  if (track.language || track.detectedLanguage || track.placement === "burn-in") return null;
  const external = track.placement === "external" && track.file ? track.file : null;
  const mediaPath = external ?? path;
  if (!mediaPath) return null;
  return {
    path: mediaPath,
    kind: "subtitle",
    ordinal: external ? 0 : (track.streamIndex ?? index),
    label,
    format: track.format,
    placement: external ? "external" : track.placement,
    streamLabel: null,
  };
}
