"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AudioTrack, SubtitleTrack } from "@/lib/types";

export function DetectionDialog({
  open,
  onOpenChange,
  title,
  entries,
  onDetect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  entries: Array<{ heading: string; body: string }>;
  onDetect?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" showCloseButton>
        <DialogHeader>
          <DialogTitle className="break-all pr-8">{title}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          {entries.map((entry) => (
            <section key={entry.heading}>
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">{entry.heading}</h3>
              <p className="whitespace-pre-line">{entry.body}</p>
            </section>
          ))}
        </div>
        {onDetect ? (
          <Button type="button" variant="outline" onClick={onDetect}>
            Listen again
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function fileDetectionEntries(audio: AudioTrack[], subtitles: SubtitleTrack[]): Array<{ heading: string; body: string }> {
  const entries: Array<{ heading: string; body: string }> = [];
  audio.forEach((track, index) => {
    if (!track.detectionLog) return;
    const label = track.detectedLanguage || track.language || "Unknown";
    const where = [track.layout, track.codec].filter(Boolean).join(" ");
    entries.push({ heading: `Audio ${index + 1} · ${label}${where ? ` · ${where}` : ""}`, body: track.detectionLog });
  });
  subtitles.forEach((track, index) => {
    if (!track.detectionLog) return;
    const label = track.detectedLanguage || track.language || "Unknown";
    entries.push({ heading: `Subtitle ${index + 1} · ${label}`, body: track.detectionLog });
  });
  return entries;
}

/** The file path. Clicking it opens the language check for every track in the file. */
export function FilePathLog({ path, audio, subtitles }: { path: string; audio: AudioTrack[]; subtitles: SubtitleTrack[] }) {
  const [open, setOpen] = useState(false);
  const entries = fileDetectionEntries(audio, subtitles);
  const name = path.split("/").pop() || path;
  return (
    <>
      <button
        type="button"
        className="break-all text-left underline decoration-dotted underline-offset-2 hover:decoration-solid"
        onClick={() => setOpen(true)}
      >
        {path}
      </button>
      <DetectionDialog
        open={open}
        onOpenChange={setOpen}
        title={name}
        entries={entries.length ? entries : [{ heading: "Language check", body: "No language check is stored for this file." }]}
      />
    </>
  );
}
