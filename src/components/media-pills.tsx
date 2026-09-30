"use client";

import { UnknownLabel } from "@/components/marked-text";
import { SourceHover } from "@/components/source-hover";
import { presenceTooltip } from "@/lib/media";
import type { FileSources } from "@/lib/types";

function pillClass(kind: "container" | "resolution" | "rate", value: string): string {
  if (kind === "rate") return "bg-amber-500/15 text-amber-950 dark:text-amber-100";
  if (kind === "resolution") {
    const height = Number.parseInt(value, 10);
    if (height >= 2160) return "bg-violet-500/15 text-violet-950 dark:text-violet-100";
    if (height >= 1080) return "bg-sky-500/15 text-sky-950 dark:text-sky-100";
    if (height >= 720) return "bg-emerald-500/15 text-emerald-950 dark:text-emerald-100";
    return "bg-stone-500/15 text-stone-800 dark:text-stone-200";
  }
  const container = value.toLowerCase();
  if (container === "mkv" || container === "mp4" || container === "m4v") return "bg-sky-500/15 text-sky-950 dark:text-sky-100";
  if (container === "avi") return "bg-orange-500/15 text-orange-950 dark:text-orange-100";
  if (container === "ts" || container === "m2ts" || container === "mts") return "bg-teal-500/15 text-teal-950 dark:text-teal-100";
  return "bg-slate-500/15 text-slate-800 dark:text-slate-100";
}

export function FlagPill({ kind }: { kind: "short" | "sample" }) {
  const sample = kind === "sample";
  return (
    <span
      title={sample ? "Named as a sample" : "Only a moment long"}
      className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-950 dark:text-amber-100"
    >
      {sample ? "Sample" : "Short"}
    </span>
  );
}

export function MediaPills({
  container,
  resolution,
  frameRate,
  threeD,
  part,
  edition,
  flags,
  sources,
}: {
  container?: string | null;
  resolution?: string | null;
  frameRate?: string | null;
  threeD?: boolean;
  part?: string | null;
  edition?: string | null;
  flags?: string[];
  sources?: FileSources;
}) {
  const pills = [
    container ? { kind: "container" as const, value: container } : null,
    resolution ? { kind: "resolution" as const, value: resolution } : null,
    frameRate ? { kind: "rate" as const, value: frameRate } : null,
  ].filter((pill): pill is { kind: "container" | "resolution" | "rate"; value: string } => Boolean(pill));
  if (!pills.length && !part && !edition && resolution !== null && !threeD && !flags?.length) return null;
  const sourceText = presenceTooltip(sources);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {pills.map((pill) => {
        const className = `rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${pillClass(pill.kind, pill.value)}`;
        const label = (
          <span key={`${pill.kind}-${pill.value}`} className={className}>
            {pill.value}
          </span>
        );
        if (pill.kind !== "container" || !sourceText) return label;
        return (
          <SourceHover key={`${pill.kind}-${pill.value}`} text={sourceText}>
            <span className={className}>{pill.value}</span>
          </SourceHover>
        );
      })}
      {resolution === null ? <UnknownLabel /> : null}
      {threeD ? (
        <span className="rounded-full bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fuchsia-950 dark:text-fuchsia-100">
          3D
        </span>
      ) : null}
      {edition ? (
        <span
          title="Special release"
          className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-950 dark:text-rose-100"
        >
          {edition}
        </span>
      ) : null}
      {part ? (
        <span
          title="Multi-part movie"
          className="rounded-full bg-yellow-400/25 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-yellow-950 dark:text-yellow-100"
        >
          {part}
        </span>
      ) : null}
      {flags?.includes("sample") ? <FlagPill kind="sample" /> : null}
      {flags?.includes("short") ? <FlagPill kind="short" /> : null}
    </span>
  );
}
