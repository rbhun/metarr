import { isDiscImage } from "@/lib/media";
import type { AudioTrack, MediaVersion, SubtitleTrack } from "@/lib/types";

export type DetectTarget = {
  path: string;
  kind: "audio" | "subtitle";
  ordinal: number;
  label: string;
  format: string | null;
  placement: string | null;
  streamLabel: string | null;
};

export type ScanFile = {
  label: string;
  path: string | null;
  container: string | null;
  playableLabel: string;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  versions: MediaVersion[];
};

function keyOf(path: string, kind: string, ordinal: number): string {
  return `${path}\0${kind}\0${ordinal}`;
}

function pictureSubtitle(format: string | null): boolean {
  return Boolean(format && /pgs|vobsub/i.test(format));
}

function targetsOnFile(file: ScanFile, rescan: boolean, scanned: Set<string>): DetectTarget[] {
  const versions = file.versions.filter((version) => version.path);
  const files: Array<{ label: string; path: string; container: string | null; playableLabel: string; audioTracks: AudioTrack[]; subtitleTracks: SubtitleTrack[] }> =
    versions.length > 0
      ? versions.map((version) => ({
          label: `${file.label} ${version.name}`.trim(),
          path: version.path as string,
          container: version.container,
          playableLabel: version.playableLabel,
          audioTracks: version.audioTracks,
          subtitleTracks: version.subtitleTracks,
        }))
      : file.path
        ? [
            {
              label: file.label,
              path: file.path,
              container: file.container,
              playableLabel: file.playableLabel,
              audioTracks: file.audioTracks,
              subtitleTracks: file.subtitleTracks,
            },
          ]
        : [];

  const targets: DetectTarget[] = [];
  for (const item of files) {
    if (item.playableLabel === "disc" || item.playableLabel === "missing" || isDiscImage(item.container, item.path)) continue;
    item.audioTracks.forEach((track, index) => {
      if (track.language) return;
      const ordinal = track.streamIndex ?? index;
      if (!rescan && scanned.has(keyOf(item.path, "audio", ordinal))) return;
      targets.push({
        path: item.path,
        kind: "audio",
        ordinal,
        label: item.label,
        format: track.codec,
        placement: null,
        streamLabel: track.label ?? null,
      });
    });
    item.subtitleTracks.forEach((track, index) => {
      if (track.language || track.placement === "burn-in") return;
      const external = track.placement === "external" && track.file;
      const path = external ? track.file! : item.path;
      const ordinal = external ? 0 : (track.streamIndex ?? index);
      if (!rescan && scanned.has(keyOf(path, "subtitle", ordinal))) return;
      targets.push({
        path,
        kind: "subtitle",
        ordinal,
        label: item.label,
        format: track.format,
        placement: external ? "external" : track.placement,
        streamLabel: null,
      });
    });
  }
  return targets;
}

export function targetsFromFiles(files: ScanFile[], rescan: boolean, scanned: Set<string>): DetectTarget[] {
  return files.flatMap((file) => targetsOnFile(file, rescan, scanned));
}

export function isPictureSubtitle(format: string | null): boolean {
  return pictureSubtitle(format);
}
