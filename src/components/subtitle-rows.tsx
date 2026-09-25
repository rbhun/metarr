"use client";

import { enqueueTrack } from "@/components/detect-actions";
import { toastDetection } from "@/components/detect-tasks";
import { UnknownLabel } from "@/components/marked-text";
import { subtitleTarget } from "@/lib/detect/track";
import { shownLanguage, subtitleNote } from "@/lib/format";
import type { SubtitleTrack } from "@/lib/types";
import { toast } from "sonner";

async function detectUnknown(track: NonNullable<ReturnType<typeof subtitleTarget>>) {
  try {
    toastDetection(await enqueueTrack(track));
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
  return (
    <>
      {tracks.map((track, index) => {
        const language = shownLanguage(track);
        const target = subtitleTarget(path, track, index, label);
        const rest = subtitleNote(track);
        return (
          <p key={`${track.placement}-${track.format ?? ""}-${track.streamIndex ?? index}`}>
            {language ? language : <UnknownLabel onClick={target ? () => void detectUnknown(target) : undefined} />}
            {rest ? ` · ${rest}` : ""}
          </p>
        );
      })}
    </>
  );
}
