"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type VersionView = {
  path: string;
  name: string;
  resolution: string | null;
  bitrateKbps: number | null;
  fileBytes: number | null;
  hdr: string;
  edition: string | null;
  durationMinutes: number | null;
  audioLanguages: string[];
  subtitleLanguages: string[];
};

type Candidate = {
  key: string;
  titleId: number | null;
  label: string;
  left: VersionView;
  right: VersionView;
  videoFrom: "left" | "right";
  durationDeltaMinutes: number | null;
  audioOnlyLeft: string[];
  audioOnlyRight: string[];
  subtitleOnlyLeft: string[];
  subtitleOnlyRight: string[];
  editionConflict: boolean;
  reason: string;
};

type FrameResult = {
  ok: boolean;
  matched: number;
  required: number;
  message: string;
};

type Totals = { pending: number; running: number; done: number; failed: number };

type MergeBody = {
  settings: { enabled: boolean };
  totals: Totals;
  pause: "plex" | "detect" | "remux" | "rewrap" | "off" | null;
  active: { label: string; progress: number | null; message: string | null } | null;
  latest: { label: string; status: "done" | "failed"; message: string | null } | null;
  candidates?: Candidate[];
  error?: string;
};

function formatBitrate(kbps: number | null): string | null {
  if (kbps == null || kbps <= 0) return null;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1).replace(/\.0$/, "")} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

function versionLine(version: VersionView): string {
  return [
    version.resolution,
    version.hdr !== "none" ? version.hdr : null,
    formatBitrate(version.bitrateKbps),
    version.edition,
    version.durationMinutes != null ? `${version.durationMinutes} min` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function audioLine(candidate: Candidate): string {
  const parts = [
    candidate.audioOnlyLeft.length ? `${candidate.audioOnlyLeft.join(", ")} on A` : null,
    candidate.audioOnlyRight.length ? `${candidate.audioOnlyRight.join(", ")} on B` : null,
  ].filter(Boolean);
  return parts.join(" · ") || "Complementary audio";
}

function summary(body: MergeBody | null): string {
  if (!body) return "Loading…";
  const { totals, pause, active } = body;
  const parts = [
    totals.pending ? `${totals.pending.toLocaleString("en")} waiting` : null,
    totals.running ? `${totals.running.toLocaleString("en")} running` : null,
    totals.failed ? `${totals.failed.toLocaleString("en")} failed` : null,
    totals.done ? `${totals.done.toLocaleString("en")} done` : null,
  ].filter(Boolean);
  const base = parts.join(" · ") || "No merges yet.";
  if (active) return `${base} · ${active.label}${active.progress ? ` ${active.progress}%` : ""}`;
  if (!totals.pending) return base;
  if (pause === "off") return `${base} · version merge is off in Settings`;
  if (pause === "remux") return `${base} · a disc remux is running`;
  if (pause === "rewrap") return `${base} · an MKV rewrap is running`;
  if (pause === "plex") return `${base} · Plex is busy`;
  if (pause === "detect") return `${base} · language detection is using the disk`;
  return base;
}

export function MergeView() {
  const [body, setBody] = useState<MergeBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [comparing, setComparing] = useState<string | null>(null);
  const [frameNotes, setFrameNotes] = useState<Record<string, FrameResult>>({});
  const [skipFrame, setSkipFrame] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async (needle: string) => {
    try {
      const params = new URLSearchParams({ candidates: "1" });
      if (needle.trim()) params.set("q", needle.trim());
      const response = await fetch(`/api/merge?${params}`, { cache: "no-store" });
      const next = (await response.json().catch(() => null)) as MergeBody | null;
      if (!response.ok || !next) throw new Error(next?.error || "Merge candidates could not be loaded.");
      setBody(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Merge candidates could not be loaded.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), 0);
    const poll = window.setInterval(() => void load(query), 8_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
    };
  }, [load, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const candidates = useMemo(() => body?.candidates ?? [], [body]);

  async function compare(candidate: Candidate) {
    if (comparing) return;
    setComparing(candidate.key);
    try {
      const response = await fetch("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "compare", leftPath: candidate.left.path, rightPath: candidate.right.path }),
      });
      const next = (await response.json().catch(() => null)) as { result?: FrameResult; error?: string } | null;
      if (!response.ok || !next?.result) throw new Error(next?.error || "Frame compare failed.");
      setFrameNotes((previous) => ({ ...previous, [candidate.key]: next.result! }));
      if (next.result.ok) toast.success(next.result.message);
      else toast.message(next.result.message);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Frame compare failed.");
    } finally {
      setComparing(null);
    }
  }

  async function merge(candidate: Candidate) {
    if (sending) return;
    const frames = frameNotes[candidate.key];
    if (!skipFrame && frames && !frames.ok) {
      toast.error("Frame check says these may be different edits. Turn on skip, or pick another pair.");
      return;
    }
    setSending(candidate.key);
    try {
      const videoPath = candidate.videoFrom === "left" ? candidate.left.path : candidate.right.path;
      const response = await fetch("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leftPath: candidate.left.path,
          rightPath: candidate.right.path,
          videoPath,
          label: candidate.label,
          skipFrameCheck: skipFrame,
        }),
      });
      const next = (await response.json().catch(() => null)) as { error?: string; added?: number; already?: number } | null;
      if (!response.ok) throw new Error(next?.error || "Could not queue the merge.");
      if (next?.already) toast.message("That pair is already queued.");
      else {
        toast.success(
          <span>
            Merge queued. Watch{" "}
            <Link href="/tasks?queue=merge" className="underline underline-offset-2">
              Tasks
            </Link>
            .
          </span>,
          { duration: 8000 },
        );
      }
      await load(query);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not queue the merge.");
    } finally {
      setSending(null);
    }
  }

  async function clearWaiting() {
    if (clearing) return;
    setClearing(true);
    try {
      const response = await fetch("/api/merge", { method: "DELETE" });
      const next = (await response.json().catch(() => null)) as { error?: string; removed?: number } | null;
      if (!response.ok) throw new Error(next?.error || "Could not clear waiting merges.");
      toast.success(next?.removed ? `Cleared ${next.removed.toLocaleString("en")} waiting merge${next.removed === 1 ? "" : "s"}.` : "Nothing waiting.");
      await load(query);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not clear waiting merges.");
    } finally {
      setClearing(false);
    }
  }

  if (body && !body.settings.enabled) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Version merge</h1>
          <p className="mt-1 text-sm text-muted-foreground">This beta feature is turned off in Settings.</p>
        </div>
        <Button type="button" size="sm" variant="outline" asChild className="w-fit">
          <Link href="/settings">Open Settings</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Beta</p>
          <h1 className="text-lg font-semibold tracking-tight">Version merge</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Titles with two copies of about the same length, but different audio languages. Merge keeps the better video and copies every audio and subtitle
            track into a new <span className="font-mono text-[11px]">.combined.mkv</span>. Case by case — nothing is scheduled.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">{summary(body)}</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search titles"
          className="sm:max-w-sm"
          aria-label="Search merge candidates"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={skipFrame} onCheckedChange={(value) => setSkipFrame(value === true)} />
          Skip frame check when merging
        </label>
        <Button type="button" size="sm" variant="outline" disabled={clearing || !body?.totals.pending} onClick={() => void clearWaiting()}>
          {clearing ? "Clearing…" : "Clear waiting"}
        </Button>
        <Button type="button" size="sm" variant="ghost" asChild>
          <Link href="/tasks?queue=merge">Tasks</Link>
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {!body ? <p className="text-sm text-muted-foreground">Looking for candidates…</p> : null}

      {body && candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {query.trim() ? "No matching titles with complementary audio and similar runtime." : "No titles with two similar-length versions and different audio yet."}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {candidates.map((candidate) => {
          const video = candidate.videoFrom === "left" ? candidate.left : candidate.right;
          const other = candidate.videoFrom === "left" ? candidate.right : candidate.left;
          const frames = frameNotes[candidate.key];
          return (
            <div key={candidate.key} className="rounded-lg border px-3 py-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {candidate.titleId ? (
                      <Link href={`/?title=${candidate.titleId}`} className="font-medium underline-offset-2 hover:underline">
                        {candidate.label}
                      </Link>
                    ) : (
                      <p className="font-medium">{candidate.label}</p>
                    )}
                    {candidate.editionConflict ? (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-800 dark:text-amber-200">Edition labels differ</span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{candidate.reason}</p>
                  <p className="text-xs">
                    <span className="text-muted-foreground">Video from </span>
                    {video.name}
                    <span className="text-muted-foreground"> · all audio and subtitles from both files</span>
                  </p>
                  <p className="text-xs text-muted-foreground">A · {versionLine(candidate.left)} · {candidate.left.audioLanguages.join(", ") || "no audio languages"}</p>
                  <p className="text-xs text-muted-foreground">B · {versionLine(candidate.right)} · {candidate.right.audioLanguages.join(", ") || "no audio languages"}</p>
                  <p className="text-xs">{audioLine(candidate)}</p>
                  {frames ? (
                    <p className={`text-xs ${frames.ok ? "text-emerald-700 dark:text-emerald-300" : "text-amber-800 dark:text-amber-200"}`}>{frames.message}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={comparing === candidate.key} onClick={() => void compare(candidate)}>
                    {comparing === candidate.key ? "Comparing…" : "Check frames"}
                  </Button>
                  <Button type="button" size="sm" disabled={sending === candidate.key} onClick={() => void merge(candidate)}>
                    {sending === candidate.key ? "Queuing…" : "Merge now"}
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
