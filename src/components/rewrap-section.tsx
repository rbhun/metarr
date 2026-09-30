"use client";

import { enqueueRewrapPaths } from "@/components/rewrap-actions";
import { toastRemux } from "@/components/remux-tasks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type AviCandidate = {
  path: string;
  label: string;
  converted: boolean;
  convertedPath: string | null;
  titleId: number | null;
};

type Totals = { pending: number; running: number; done: number; failed: number };

type RewrapBody = {
  settings: { enabled: boolean; startHour: number; endHour: number; firstLanguage: string };
  totals: Totals;
  pause: "window" | "plex" | "detect" | "remux" | "off" | null;
  active: { label: string; progress: number | null; message: string | null } | null;
  latest: { label: string; status: "done" | "failed"; message: string | null } | null;
  files?: AviCandidate[];
  error?: string;
};

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function summary(body: RewrapBody | null): string {
  if (!body) return "Loading…";
  const { totals, pause, settings, active } = body;
  const parts = [
    totals.pending ? `${totals.pending.toLocaleString("en")} waiting` : null,
    totals.running ? `${totals.running.toLocaleString("en")} running` : null,
    totals.failed ? `${totals.failed.toLocaleString("en")} failed` : null,
    totals.done ? `${totals.done.toLocaleString("en")} done` : null,
  ].filter(Boolean);
  const base = parts.join(" · ") || "No rewraps yet.";
  if (active) return `${base} · ${active.label}${active.progress ? ` ${active.progress}%` : ""}`;
  if (!totals.pending) return base;
  if (pause === "off") return `${base} · MKV rewrap is off in Settings`;
  if (pause === "window") return `${base} · waiting for ${hourLabel(settings.startHour)}–${hourLabel(settings.endHour)}`;
  if (pause === "remux") return `${base} · a disc remux is running`;
  if (pause === "plex") return `${base} · Plex is busy`;
  if (pause === "detect") return `${base} · language detection is using the disk`;
  return base;
}

export function RewrapSection() {
  const [body, setBody] = useState<RewrapBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/rewrap?files=1", { cache: "no-store" });
      const next = (await response.json().catch(() => null)) as RewrapBody | null;
      if (!response.ok || !next) throw new Error(next?.error || "The file list could not be loaded.");
      setBody(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file list could not be loaded.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const poll = window.setInterval(() => void load(), 5_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
    };
  }, [load]);

  const files = useMemo(() => body?.files ?? [], [body]);
  const matching = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return files;
    return files.filter((file) => file.label.toLowerCase().includes(needle) || file.path.toLowerCase().includes(needle));
  }, [files, search]);
  const open = useMemo(() => matching.filter((file) => !file.converted), [matching]);
  const converted = useMemo(() => matching.filter((file) => file.converted), [matching]);
  const allVisibleSelected = open.length > 0 && open.every((file) => selected.has(file.path));

  function toggle(filePath: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((previous) => {
      const next = new Set(previous);
      if (allVisibleSelected) for (const file of open) next.delete(file.path);
      else for (const file of open) next.add(file.path);
      return next;
    });
  }

  async function send(paths: Array<{ path: string; label?: string }>, immediate: boolean) {
    if (paths.length < 1 || sending) return;
    setSending(true);
    try {
      toastRemux(await enqueueRewrapPaths(paths, immediate), "rewrap");
      setSelected(new Set());
      setPathInput("");
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not queue the rewrap.");
    } finally {
      setSending(false);
    }
  }

  function selectedPaths() {
    return [...selected].map((filePath) => ({ path: filePath, label: files.find((file) => file.path === filePath)?.label }));
  }

  async function clearQueue() {
    const waiting = body?.totals.pending ?? 0;
    if (waiting < 1 || clearing) return;
    if (!window.confirm(`Remove ${waiting.toLocaleString("en")} waiting rewraps? A rewrap already running will finish.`)) return;
    setClearing(true);
    try {
      const response = await fetch("/api/rewrap", { method: "DELETE" });
      if (!response.ok) throw new Error("The queue could not be cleared.");
      toast.success("Waiting rewraps cleared.");
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The queue could not be cleared.");
    } finally {
      setClearing(false);
    }
  }

  const totals = body?.totals ?? { pending: 0, running: 0, done: 0, failed: 0 };
  const tasksHref =
    totals.failed > 0 && totals.pending === 0 && totals.running === 0
      ? "/tasks?queue=rewrap&status=failed"
      : totals.running > 0
        ? "/tasks?queue=rewrap&status=running"
        : "/tasks?queue=rewrap&status=all";

  return (
    <section className="space-y-3 border-t pt-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight">AVI and M2TS files</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          AVI and loose M2TS or TS files cannot store a language on each track. ffmpeg copies the video, every audio track, and the subtitles into an
          MKV with the same name, next to it, and writes the audio and subtitle languages Metarr knows onto the tracks. Nothing is re-encoded, so the
          quality and size stay the same; Blu-ray PCM audio is stored as lossless FLAC. Old DivX/Xvid video may still need Plex to convert it on some
          players. The original file stays where it is. Hours and the audio order are under Settings.
        </p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border px-3 py-3">
        <div>
          <h3 className="text-sm font-medium">Rewrap queue</h3>
          <p className="mt-1 text-sm text-muted-foreground">{summary(body)}</p>
          {!body?.active && body?.latest?.status === "failed" ? (
            <p className="mt-2 text-sm leading-6 text-destructive">
              Last failure: {body.latest.label}
              {body.latest.message ? ` — ${body.latest.message}` : ""}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {totals.pending > 0 ? (
            <Button size="sm" variant="outline" onClick={() => void clearQueue()} disabled={clearing}>
              Clear waiting
            </Button>
          ) : null}
          <Button size="sm" variant="outline" asChild>
            <Link href={tasksHref}>Open Tasks</Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">To rewrap</h3>
          <p className="text-xs text-muted-foreground">AVI and M2TS files in the library that do not have their MKV yet.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={selected.size < 1 || sending} onClick={() => void send(selectedPaths(), true)}>
            Rewrap now
          </Button>
          <Button size="sm" disabled={selected.size < 1 || sending} onClick={() => void send(selectedPaths(), false)}>
            {sending ? "Sending…" : selected.size ? `Queue ${selected.size}` : "Queue"}
          </Button>
        </div>
      </div>
      <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search titles or paths" aria-label="Search titles or paths" />
      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-3 text-sm">
          <p>{error}</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : null}
      {!body && !error ? <p className="text-sm text-muted-foreground">Loading files…</p> : null}
      {body && files.length === 0 ? <p className="text-sm text-muted-foreground">No AVI or M2TS files in the library.</p> : null}
      {body && files.length > 0 && matching.length === 0 ? <p className="text-sm text-muted-foreground">No files match that search.</p> : null}
      {body && matching.length > 0 && open.length === 0 ? (
        <p className="text-sm text-muted-foreground">Every file here already has its MKV.</p>
      ) : null}
      {open.length > 0 ? (
        <div className="overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
            <Checkbox checked={allVisibleSelected} onCheckedChange={() => toggleAllVisible()} aria-label="Select all visible files" />
            <span className="text-muted-foreground">
              {open.length.toLocaleString("en")} file{open.length === 1 ? "" : "s"}
              {selected.size ? ` · ${selected.size} selected` : ""}
            </span>
          </div>
          <ul className="divide-y">
            {open.map((file) => (
              <li key={file.path}>
                <label className="flex cursor-pointer items-start gap-3 px-3 py-3 hover:bg-muted/30">
                  <Checkbox checked={selected.has(file.path)} onCheckedChange={() => toggle(file.path)} className="mt-0.5" aria-label={`Select ${file.label}`} />
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium">{file.label}</span>
                    <span className="mt-1 block text-xs leading-5 break-all text-muted-foreground">{file.path}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {converted.length > 0 ? (
        <div className="space-y-2 pt-2">
          <div>
            <h3 className="text-sm font-medium">Already rewrapped</h3>
            <p className="text-xs text-muted-foreground">These files have their MKV. The original is still there until you remove it.</p>
          </div>
          <ul className="divide-y overflow-hidden rounded-lg border">
            {converted.map((file) => (
              <li key={file.path} className="px-3 py-3">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  {file.titleId ? (
                    <Link href={`/?file=${encodeURIComponent(file.path)}`} className="text-sm font-medium underline-offset-2 hover:underline">
                      {file.label}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium">{file.label}</span>
                  )}
                  <span className="text-xs text-emerald-700 dark:text-emerald-300">
                    {file.convertedPath ? `Rewrapped to ${fileName(file.convertedPath)}` : "Rewrap finished"}
                  </span>
                </span>
                <span className="mt-1 block text-xs leading-5 break-all text-muted-foreground">{file.path}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <label htmlFor="rewrap-path" className="text-xs font-medium">
            Or paste an AVI or M2TS path on this machine
          </label>
          <Input
            id="rewrap-path"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            placeholder="/movies/Film (1999)/Film (1999).avi"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void send([{ path: pathInput.trim() }], false);
              }
            }}
          />
        </div>
        <Button size="sm" variant="outline" disabled={!pathInput.trim() || sending} onClick={() => void send([{ path: pathInput.trim() }], false)}>
          Send path
        </Button>
      </div>
    </section>
  );
}
