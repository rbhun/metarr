"use client";

import { AudioTracks } from "@/components/audio-tracks";
import { FileBrowserButton } from "@/components/file-browser-button";
import { LineScroll } from "@/components/line-scroll";
import { MarkedText } from "@/components/marked-text";
import { MediaPills } from "@/components/media-pills";
import { SubtitleRows } from "@/components/subtitle-rows";
import { formatBitrate, hdrText } from "@/lib/format";
import { multiPartLabel } from "@/lib/media";
import type { MediaVersion } from "@/lib/types";

function versionKey(version: MediaVersion, index: number): string {
  return `${version.path ?? version.name}-${index}`;
}

function versionHeading(version: MediaVersion): string {
  return [hdrText(version.hdr), version.edition, version.qualityName, version.bitrateKbps ? formatBitrate(version.bitrateKbps) : null]
    .filter(Boolean)
    .join(" · ");
}

export function VersionLines({ versions }: { versions: MediaVersion[] }) {
  return (
    <LineScroll className="space-y-1.5">
      {versions.map((version, index) => (
        <div key={versionKey(version, index)}>
          <p className="flex flex-wrap items-center gap-1">
            <MediaPills container={version.container} resolution={version.resolution} part={multiPartLabel(version.path, version.name)} />
            <span><MarkedText text={versionHeading(version)} /></span>
          </p>
          {version.flags?.length ? (
            <p className="text-[11px] text-amber-800 dark:text-amber-200">{version.flags.map((flag) => (flag === "sample" ? "Sample" : "Short")).join(" · ")}</p>
          ) : null}
          {version.missing.length ? (
            <p className="text-[11px] text-amber-800 dark:text-amber-200">Missing {version.missing.join(", ")}</p>
          ) : null}
        </div>
      ))}
    </LineScroll>
  );
}

export function VersionAudio({ versions }: { versions: MediaVersion[] }) {
  return (
    <LineScroll className="space-y-1.5">
      {versions.map((version, index) => (
        <div key={versionKey(version, index)}>
          <p className="text-[10px] text-muted-foreground">{[version.resolution, hdrText(version.hdr), version.edition].filter(Boolean).join(" · ")}</p>
          <AudioTracks tracks={version.audioTracks} languages={version.audioLanguages} path={version.path} label={version.name} scroll={false} />
        </div>
      ))}
    </LineScroll>
  );
}

export function VersionSubtitles({ versions }: { versions: MediaVersion[] }) {
  return (
    <LineScroll className="space-y-1.5">
      {versions.map((version, index) => (
        <div key={versionKey(version, index)}>
          <p className="text-[10px] text-muted-foreground">{[version.resolution, hdrText(version.hdr), version.edition].filter(Boolean).join(" · ")}</p>
          <SubtitleRows tracks={version.subtitleTracks} languages={version.subtitleLanguages} path={version.path} label={version.name} />
        </div>
      ))}
    </LineScroll>
  );
}

export function VersionDetail({
  versions,
  fileBrowserUrl = "",
  fileBrowserRoot = "",
}: {
  versions: MediaVersion[];
  fileBrowserUrl?: string;
  fileBrowserRoot?: string;
}) {
  return (
    <div className="col-span-2 space-y-3">
      <p className="text-muted-foreground">Versions</p>
      {versions.map((version, index) => (
        <div key={versionKey(version, index)} className="space-y-1 rounded-lg border p-2">
          <p className="font-medium">{version.name}</p>
          <p className="flex flex-wrap items-center gap-1">
            <MediaPills container={version.container} resolution={version.resolution} part={multiPartLabel(version.path, version.name)} />
            <span><MarkedText text={versionHeading(version)} /></span>
            {version.is3d ? <span>3D</span> : null}
          </p>
          {version.flags?.length ? (
            <p className="text-amber-800 dark:text-amber-200">{version.flags.map((flag) => (flag === "sample" ? "Sample" : "Short")).join(" · ")}</p>
          ) : null}
          {version.missing.length ? (
            <p className="text-amber-800 dark:text-amber-200">Missing {version.missing.join(", ")}</p>
          ) : null}
          <p className="break-all text-muted-foreground">{version.path ?? "No path"}</p>
          <FileBrowserButton filePath={version.path} baseUrl={fileBrowserUrl} root={fileBrowserRoot} />
          <AudioTracks tracks={version.audioTracks} languages={version.audioLanguages} path={version.path} label={version.name} />
          <SubtitleRows tracks={version.subtitleTracks} languages={version.subtitleLanguages} path={version.path} label={version.name} />
        </div>
      ))}
    </div>
  );
}
