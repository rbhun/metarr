"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type InspectPair = {
  key: string;
  left: VersionView;
  right: VersionView;
  videoFrom: "left" | "right";
  durationDeltaMinutes: number | null;
  eligible: boolean;
  reason: string;
  candidate: Candidate | null;
};

type TitleInspect = {
  titleId: number;
  label: string;
  versions: VersionView[];
  pairs: InspectPair[];
  eligibleCount: number;
};

type FrameResult = {
  ok: boolean;
  matched: number;
  required: number;
  percent?: number;
  kind?: "same" | "framerate" | "edition" | "titles";
  message: string;
};

type Totals = { pending: number; running: number; done: number; failed: number };

type MergeBody = {
  settings: { enabled: boolean; maxDurationDeltaMinutes: number; frameSampleCount: number };
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

function audioLine(candidate: Pick<Candidate, "videoFrom" | "audioOnlyLeft" | "audioOnlyRight">): string {
  const donor = candidate.videoFrom === "left" ? candidate.audioOnlyRight : candidate.audioOnlyLeft;
  const side = candidate.videoFrom === "left" ? "B" : "A";
  if (!donor.length) return "No new audio from the other file";
  return `Adds ${donor.join(", ")} from ${side}`;
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

function PairCard({
  title,
  titleId,
  left,
  right,
  videoFrom,
  reason,
  editionConflict,
  audioOnlyLeft,
  audioOnlyRight,
  eligible,
  frames,
  comparing,
  sending,
  onCompare,
  onMerge,
}: {
  title: string;
  titleId: number | null;
  left: VersionView;
  right: VersionView;
  videoFrom: "left" | "right";
  reason: string;
  editionConflict?: boolean;
  audioOnlyLeft?: string[];
  audioOnlyRight?: string[];
  eligible: boolean;
  frames?: FrameResult;
  comparing: boolean;
  sending: boolean;
  onCompare?: () => void;
  onMerge?: () => void;
}) {
  const video = videoFrom === "left" ? left : right;
  return (
    <div className="rounded-lg border px-3 py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {titleId ? (
              <Link href={`/?title=${titleId}`} className="font-medium underline-offset-2 hover:underline">
                {title}
              </Link>
            ) : (
              <p className="font-medium">{title}</p>
            )}
            {eligible ? null : (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Not eligible</span>
            )}
            {editionConflict ? (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-800 dark:text-amber-200">Edition labels differ</span>
            ) : null}
          </div>
          <p className={`text-xs ${eligible ? "text-muted-foreground" : "text-amber-800 dark:text-amber-200"}`}>{reason}</p>
          {eligible ? (
            <p className="text-xs">
              <span className="text-muted-foreground">Video from </span>
              {video.name}
              <span className="text-muted-foreground"> · all audio and subtitles from both files</span>
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">A · {versionLine(left)} · {left.audioLanguages.join(", ") || "no audio languages"}</p>
          <p className="text-xs text-muted-foreground">B · {versionLine(right)} · {right.audioLanguages.join(", ") || "no audio languages"}</p>
          {eligible && audioOnlyLeft && audioOnlyRight ? (
            <p className="text-xs">{audioLine({ videoFrom, audioOnlyLeft, audioOnlyRight })}</p>
          ) : null}
          {frames ? (
            <p className={`text-xs ${frames.ok ? "text-emerald-700 dark:text-emerald-300" : "text-amber-800 dark:text-amber-200"}`}>{frames.message}</p>
          ) : null}
        </div>
        {eligible ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={comparing || !onCompare} onClick={onCompare}>
              {comparing ? "Comparing…" : "Check frames"}
            </Button>
            <Button type="button" size="sm" disabled={sending || !onMerge} onClick={onMerge}>
              {sending ? "Queuing…" : "Merge now"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
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
  const [deltaText, setDeltaText] = useState("1");
  const deltaDirtyRef = useRef(false);
  const [framesText, setFramesText] = useState("12");
  const framesDirtyRef = useRef(false);
  const [savingDelta, setSavingDelta] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspect, setInspect] = useState<TitleInspect | null>(null);

  const load = useCallback(async (needle: string) => {
    try {
      const params = new URLSearchParams({ candidates: "1" });
      if (needle.trim()) params.set("q", needle.trim());
      const response = await fetch(`/api/merge?${params}`, { cache: "no-store" });
      const next = (await response.json().catch(() => null)) as MergeBody | null;
      if (!response.ok || !next) throw new Error(next?.error || "Merge candidates could not be loaded.");
      setBody(next);
      // Polling must not clobber the field while the user is editing it.
      if (!deltaDirtyRef.current) setDeltaText(String(next.settings.maxDurationDeltaMinutes));
      if (!framesDirtyRef.current) setFramesText(String(next.settings.frameSampleCount));
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

  async function saveDelta() {
    if (savingDelta) return;
    const value = Number(deltaText);
    if (!Number.isFinite(value)) {
      toast.error("Use a runtime difference between 0 and 120 minutes.");
      return;
    }
    setSavingDelta(true);
    try {
      const response = await fetch("/api/merge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxDurationDeltaMinutes: value }),
      });
      const next = (await response.json().catch(() => null)) as { error?: string; settings?: MergeBody["settings"] } | null;
      if (!response.ok) throw new Error(next?.error || "Could not save the runtime difference.");
      if (next?.settings) {
        deltaDirtyRef.current = false;
        setDeltaText(String(next.settings.maxDurationDeltaMinutes));
      }
      toast.success(`Runtime difference set to ${next?.settings?.maxDurationDeltaMinutes ?? value} min.`);
      await load(query);
      if (inspect) await checkTitle(inspect.label);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save the runtime difference.");
    } finally {
      setSavingDelta(false);
    }
  }

  async function saveFrames() {
    if (savingDelta) return;
    const value = Number(framesText);
    if (!Number.isInteger(value) || value < 4 || value > 24) {
      toast.error("Use between 4 and 24 frame samples.");
      return;
    }
    setSavingDelta(true);
    try {
      const response = await fetch("/api/merge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frameSampleCount: value }),
      });
      const next = (await response.json().catch(() => null)) as { error?: string; settings?: MergeBody["settings"] } | null;
      if (!response.ok) throw new Error(next?.error || "Could not save the frame count.");
      if (next?.settings) {
        framesDirtyRef.current = false;
        setFramesText(String(next.settings.frameSampleCount));
      }
      toast.success(`Frame check set to ${next?.settings?.frameSampleCount ?? value} samples.`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save the frame count.");
    } finally {
      setSavingDelta(false);
    }
  }

  async function checkTitle(raw = titleInput) {
    if (inspecting) return;
    const text = raw.trim();
    if (!text) {
      toast.error("Enter a title name or library id.");
      return;
    }
    setInspecting(true);
    try {
      const response = await fetch("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "inspect", title: text }),
      });
      const next = (await response.json().catch(() => null)) as { error?: string; inspect?: TitleInspect } | null;
      if (!response.ok || !next?.inspect) throw new Error(next?.error || "That title could not be checked.");
      setInspect(next.inspect);
      setTitleInput(next.inspect.label);
      toast.success(
        next.inspect.eligibleCount
          ? `${next.inspect.label}: ${next.inspect.eligibleCount} eligible pair${next.inspect.eligibleCount === 1 ? "" : "s"}.`
          : `${next.inspect.label}: no eligible pairs with the current rules.`,
      );
    } catch (caught) {
      setInspect(null);
      toast.error(caught instanceof Error ? caught.message : "That title could not be checked.");
    } finally {
      setInspecting(false);
    }
  }

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

      <div className="flex flex-col gap-3 rounded-lg border px-3 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="merge-duration-delta">Max runtime difference (minutes)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="merge-duration-delta"
                type="number"
                min={0}
                max={120}
                step={0.5}
                value={deltaText}
                disabled={savingDelta}
                className="w-28"
                onChange={(event) => {
                  deltaDirtyRef.current = true;
                  setDeltaText(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveDelta();
                  }
                }}
              />
              <Button type="button" size="sm" disabled={savingDelta} onClick={() => void saveDelta()}>
                {savingDelta ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="merge-frame-count">Frame samples</Label>
            <div className="flex items-center gap-2">
              <Input
                id="merge-frame-count"
                type="number"
                min={4}
                max={24}
                step={1}
                value={framesText}
                disabled={savingDelta}
                className="w-28"
                onChange={(event) => {
                  framesDirtyRef.current = true;
                  setFramesText(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveFrames();
                  }
                }}
              />
              <Button type="button" size="sm" disabled={savingDelta} onClick={() => void saveFrames()}>
                {savingDelta ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="merge-title-check">Check a title</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="merge-title-check"
                value={titleInput}
                onChange={(event) => setTitleInput(event.target.value)}
                placeholder="Title name or library id"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void checkTitle();
                  }
                }}
              />
              <Button type="button" size="sm" disabled={inspecting} onClick={() => void checkTitle()}>
                {inspecting ? "Checking…" : "Check title"}
              </Button>
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Runtime difference filters the automatic list. Check frames reports how many pictures matched, looks for a constant start-title offset (one copy
          missing the open), and says whether a runtime gap is PAL speed, titles, or a different edition. If it finds an offset, Merge delays or trims the other
          file's audio and subtitles so they stay in sync.
        </p>
      </div>

      {inspect ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">
              Manual check · {inspect.label}
              <span className="ml-2 font-normal text-muted-foreground">
                {inspect.versions.length} version{inspect.versions.length === 1 ? "" : "s"} · {inspect.eligibleCount} eligible
              </span>
            </h2>
            <Button type="button" size="sm" variant="ghost" onClick={() => setInspect(null)}>
              Clear check
            </Button>
          </div>
          {inspect.pairs.length === 0 ? (
            <p className="text-sm text-muted-foreground">This title does not have two mergeable video files.</p>
          ) : (
            inspect.pairs.map((pair) => (
              <PairCard
                key={pair.key}
                title={inspect.label}
                titleId={inspect.titleId}
                left={pair.left}
                right={pair.right}
                videoFrom={pair.videoFrom}
                reason={pair.reason}
                editionConflict={pair.candidate?.editionConflict}
                audioOnlyLeft={pair.candidate?.audioOnlyLeft}
                audioOnlyRight={pair.candidate?.audioOnlyRight}
                eligible={pair.eligible}
                frames={frameNotes[pair.key]}
                comparing={comparing === pair.key}
                sending={sending === pair.key}
                onCompare={pair.candidate ? () => void compare(pair.candidate!) : undefined}
                onMerge={pair.candidate ? () => void merge(pair.candidate!) : undefined}
              />
            ))
          )}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter automatic candidates"
          className="sm:max-w-sm"
          aria-label="Filter merge candidates"
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

      <h2 className="text-sm font-medium">Automatic candidates</h2>

      {body && candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {query.trim() ? "No matching titles with complementary audio and similar runtime." : "No titles with two similar-length versions and different audio yet."}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {candidates.map((candidate) => (
          <PairCard
            key={candidate.key}
            title={candidate.label}
            titleId={candidate.titleId}
            left={candidate.left}
            right={candidate.right}
            videoFrom={candidate.videoFrom}
            reason={candidate.reason}
            editionConflict={candidate.editionConflict}
            audioOnlyLeft={candidate.audioOnlyLeft}
            audioOnlyRight={candidate.audioOnlyRight}
            eligible
            frames={frameNotes[candidate.key]}
            comparing={comparing === candidate.key}
            sending={sending === candidate.key}
            onCompare={() => void compare(candidate)}
            onMerge={() => void merge(candidate)}
          />
        ))}
      </div>
    </div>
  );
}
