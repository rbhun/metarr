"use client";

import { enqueueTracks } from "@/components/detect-actions";
import { toastDetection } from "@/components/detect-tasks";
import { omittedLanguageClass, UnknownLabel } from "@/components/marked-text";
import { SourceHover } from "@/components/source-hover";
import { subtitleTargets } from "@/lib/detect/track";
import { languageHover, shownLanguage, subtitleNote } from "@/lib/format";
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
        const hover = languageHover(track.sources, language) || (targets.length ? "Detect this language now" : undefined);
        return (
          <p key={`${language ?? "unknown"}-${track.placement}-${track.format ?? ""}-${track.streamIndex ?? ""}-${index}`}>
            {language ? (
              <SourceHover text={hover}>
                <span className={track.conflict ? omittedLanguageClass : undefined}>{language}</span>
              </SourceHover>
            ) : (
              <SourceHover text={hover}>
                <span>
                  <UnknownLabel onClick={targets.length ? () => void detectUnknown(targets) : undefined} />
                </span>
              </SourceHover>
            )}
            {rest ? ` · ${rest}` : ""}
          </p>
        );
      })}
    </>
  );
}
