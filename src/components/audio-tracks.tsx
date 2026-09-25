"use client";

import { enqueueTracks } from "@/components/detect-actions";
import { toastDetection } from "@/components/detect-tasks";
import { LineScroll } from "@/components/line-scroll";
import { UnknownLabel } from "@/components/marked-text";
import { audioTargets } from "@/lib/detect/track";
import { formatLayout } from "@/lib/format";
import type { AudioTrack } from "@/lib/types";
import { toast } from "sonner";

function Mark({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span title={label} aria-label={label} className="inline-flex h-3.5 shrink-0 items-center">
      {children}
    </span>
  );
}

function DolbyDigital({ plus }: { plus?: boolean }) {
  return (
    <Mark label={plus ? "Dolby Digital Plus" : "Dolby Digital"}>
      <svg viewBox="0 0 28 14" className="h-3.5 w-7" aria-hidden>
        <rect width="28" height="14" rx="2" className="fill-foreground" />
        <text x="3" y="11" className="fill-background" fontSize="9" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="700">
          DD
        </text>
        {plus ? (
          <text x="18" y="8" className="fill-background" fontSize="8" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="700">
            +
          </text>
        ) : null}
      </svg>
    </Mark>
  );
}

function TrueHd() {
  return (
    <Mark label="Dolby TrueHD">
      <svg viewBox="0 0 36 14" className="h-3.5 w-9" aria-hidden>
        <rect width="36" height="14" rx="2" className="fill-foreground" />
        <text x="3" y="11" className="fill-background" fontSize="8" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="700">
          TrueHD
        </text>
      </svg>
    </Mark>
  );
}

function Dts({ hd }: { hd?: boolean }) {
  return (
    <Mark label={hd ? "DTS-HD" : "DTS"}>
      <svg viewBox={hd ? "0 0 40 14" : "0 0 26 14"} className={hd ? "h-3.5 w-10" : "h-3.5 w-7"} aria-hidden>
        <rect width={hd ? 40 : 26} height="14" rx="2" className="fill-none stroke-foreground" strokeWidth="1.5" />
        <text x="4" y="11" className="fill-foreground" fontSize="8" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="700">
          {hd ? "DTS-HD" : "DTS"}
        </text>
      </svg>
    </Mark>
  );
}

async function detectUnknown(tracks: ReturnType<typeof audioTargets>) {
  try {
    toastDetection(await enqueueTracks(tracks));
  } catch (caught) {
    toast.error(caught instanceof Error ? caught.message : "Could not start language detection.");
  }
}

function CodecMark({ codec }: { codec: string | null }) {
  if (codec === "Dolby Digital") return <DolbyDigital />;
  if (codec === "Dolby Digital Plus") return <DolbyDigital plus />;
  if (codec === "Dolby TrueHD") return <TrueHd />;
  if (codec === "DTS") return <Dts />;
  if (codec === "DTS-HD") return <Dts hd />;
  if (!codec) return null;
  return <span className="text-[10px] text-muted-foreground">{codec}</span>;
}

export function AudioTracks({
  tracks,
  languages,
  path = null,
  label = "Audio",
  className,
  scroll = true,
}: {
  tracks: AudioTrack[];
  languages: string[];
  path?: string | null;
  label?: string;
  className?: string;
  scroll?: boolean;
}) {
  const rows = tracks.length
    ? tracks
        .map((track, index) => ({
          language: track.language || track.detectedLanguage || null,
          commentary: track.detectedRole === "commentary",
          layout: formatLayout(track.layout),
          codec: track.codec,
          targets: audioTargets(path, track, index, label),
        }))
        .filter((row) => row.language || row.layout || row.codec)
    : languages.map((language) => ({ language, commentary: false, layout: null, codec: null, targets: [] }));

  if (rows.length === 0) return <p>—</p>;

  const items = rows.map((row, index) => (
        <p key={`${row.language ?? ""}-${row.layout ?? ""}-${row.codec ?? ""}-${index}`} className="flex items-center gap-1">
          {row.language ? (
            <span>
              {row.language}
              {row.commentary ? " commentary" : ""}
            </span>
          ) : (
            <UnknownLabel onClick={row.targets.length ? () => void detectUnknown(row.targets) : undefined} />
          )}
          {row.layout ? <span className="font-mono text-[0.92em] tabular-nums">{row.layout}</span> : null}
          <CodecMark codec={row.codec} />
        </p>
      ));
  return scroll ? <LineScroll className={className}>{items}</LineScroll> : <div className={className}>{items}</div>;
}
