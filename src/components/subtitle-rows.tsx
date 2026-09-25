"use client";

import { enqueueTracks } from "@/components/detect-actions";
import { toastDetection } from "@/components/detect-tasks";
import { UnknownLabel } from "@/components/marked-text";
import { subtitleTargets } from "@/lib/detect/track";
import { shownLanguage, subtitleNote } from "@/lib/format";
import type { SubtitleTrack } from "@/lib/types";
import { toast } from "sonner";

async function detectUnknown(tracks: ReturnType<typeof subtitleTargets>) {
  try {
    toastDetection(await enqueueTracks(tracks));
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : "Could not start language detection.");
  }
}

export function SubtitleRows({
  tracks,
  languages,
  path = null,
  label = "Subtitles",
}: {
  tracks: SubtitleTrack[];
  languages: string[];
  path?: string | null;
  label?: string;
}) {
  if (tracks.length === 0) {
    return languages.length ? languages.map((language) => <p key={language}>{language}</p>) : <p>—</p>;
  }
  const ordered = tracks
    .map((track, index) => ({ track, index }))
    .sort((left, right) => Number(left.track.placement !== "external") - Number(right.track.placement !== "external"));
  return (
    <>
      {ordered.map(({ track, index }) => {
        const language = shownLanguage(track);
        const targets = subtitleTargets(path, track, index, label);
        const rest = subtitleNote(track);
        return (
          <p key={`${language ?? "unknown"}-${track.placement}-${track.format ?? ""}-${track.streamIndex ?? ""}-${index}`}>
            {language ? language : <UnknownLabel onClick={targets.length ? () => void detectUnknown(targets) : undefined} />}
            {rest ? ` · ${rest}` : ""}
          </p>
        );
      })}
    </>
  );
}
