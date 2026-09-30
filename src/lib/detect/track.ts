import path from "node:path";
import { languageFromSubtitleName } from "@/lib/detect/sidecars";
import type { DetectTarget } from "@/lib/detect/targets";
import type { AudioTrack, SubtitleTrack } from "@/lib/types";

export function audioTarget(path: string | null, track: AudioTrack, index: number, label: string): DetectTarget | null {
  const targets = audioTargets(path, track, index, label);
  return targets[0] ?? null;
}

function narrowLayout(layout: string | null | undefined): boolean {
  return layout === "1.0" || layout === "2.0" || layout === "mono" || layout === "stereo";
}

export function audioTargets(path: string | null, track: AudioTrack, index: number, label: string): DetectTarget[] {
  if (track.language || track.fromFile || track.detectedRole === "short") return [];
  if (track.detectedLanguage && (track.detectedRole === "commentary" || !narrowLayout(track.layout))) return [];
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

export function subtitleTargets(mediaPath: string | null, track: SubtitleTrack, index: number, label: string): DetectTarget[] {
  if (track.language || track.detectedLanguage || track.placement === "burn-in") return [];
  if (track.placement === "external" && !track.file) return [];
  const external = track.placement === "external" && track.file ? track.file : null;
  if (external && languageFromSubtitleName(path.basename(external))) return [];
  const copies = track.copies?.length
    ? track.copies
    : external
      ? [{ path: external, ordinal: 0 }]
      : mediaPath
        ? [{ path: mediaPath, ordinal: track.streamIndex ?? index }]
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
