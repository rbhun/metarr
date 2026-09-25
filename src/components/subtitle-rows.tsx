"use client";

import { enqueueTrack } from "@/components/detect-actions";
import { UnknownLabel } from "@/components/marked-text";
import { subtitleTarget } from "@/lib/detect/track";
import { shownLanguage } from "@/lib/format";
import type { SubtitleTrack } from "@/lib/types";
import { toast } from "sonner";

async function detectUnknown(track: NonNullable<ReturnType<typeof subtitleTarget>>) {
  try {
    toast.success(await enqueueTrack(track));
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
  const named = new Set(tracks.map((track) => shownLanguage(track)?.toLowerCase()).filter((language): language is string => Boolean(language)));
  return (
    <>
      {tracks.map((track, index) => {
        const language = shownLanguage(track);
        const place = track.placement === "burn-in" ? "burn-in" : track.placement;
        const target = subtitleTarget(path, track, index, label);
        const rest = [place, track.format, track.forced ? "forced" : null].filter(Boolean).join(" · ");
        return (
          <p key={`${track.placement}-${track.format ?? ""}-${track.streamIndex ?? index}`}>
            {language ? language : <UnknownLabel onClick={target ? () => void detectUnknown(target) : undefined} />}
            {rest ? ` · ${rest}` : ""}
          </p>
        );
      })}
      {languages.filter((language) => !named.has(language.toLowerCase())).map((language) => (
        <p key={language}>{language}</p>
      ))}
    </>
  );
}
