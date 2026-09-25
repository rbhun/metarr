import type { DetectTarget } from "@/lib/detect/targets";
import type { AudioTrack, SubtitleTrack } from "@/lib/types";

export function audioTarget(path: string | null, track: AudioTrack, index: number, label: string): DetectTarget | null {
  const targets = audioTargets(path, track, index, label);
  return targets[0] ?? null;
}

export function audioTargets(path: string | null, track: AudioTrack, index: number, label: string): DetectTarget[] {
  if (track.language || track.detectedLanguage) return [];
  const copies = track.copies?.length ? track.copies : path ? [{ path, ordinal: track.streamIndex ?? index }] : [];
  return copies.map((copy) => ({
    path: copy.path,
    kind: "audio" as const,
    ordinal: copy.ordinal,
    label,
    format: track.codec,
    placement: null,
    streamLabel: track.label ?? null,
  }));
}

export function subtitleTarget(path: string | null, track: SubtitleTrack, index: number, label: string): DetectTarget | null {
  const targets = subtitleTargets(path, track, index, label);
  return targets[0] ?? null;
}

export function subtitleTargets(path: string | null, track: SubtitleTrack, index: number, label: string): DetectTarget[] {
  if (track.language || track.detectedLanguage || track.placement === "burn-in") return [];
  const external = track.placement === "external" && track.file ? track.file : null;
  const copies = track.copies?.length
    ? track.copies
    : external
      ? [{ path: external, ordinal: 0 }]
      : path
        ? [{ path, ordinal: track.streamIndex ?? index }]
        : [];
  return copies.map((copy) => ({
    path: copy.path,
    kind: "subtitle" as const,
    ordinal: copy.ordinal,
    label,
    format: track.format,
    placement: external ? "external" : track.placement,
    streamLabel: null,
  }));
}
