"use client";

import { enqueueRemuxPaths } from "@/components/remux-actions";
import { toastRemux } from "@/components/remux-tasks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type DiscCandidate = {
  path: string;
  label: string;
  kind: string;
  kindLabel: string;
};

type JobTotals = { pending: number; running: number; done: number; failed: number };

type RemuxBody = {
  settings: { startHour: number; endHour: number };
  counts: { waiting: number; running: number };
  totals?: JobTotals;
  pause: "window" | "plex" | "detect" | null;
  discs?: DiscCandidate[];
  latest?: { label: string; status: "done" | "failed"; message: string | null } | null;
  error?: string;
};

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function queueSummary(totals: JobTotals, pause: RemuxBody["pause"], settings: RemuxBody["settings"]): string {
  const parts = [
    totals.pending ? `${totals.pending.toLocaleString("en")} waiting` : null,
    totals.running ? `${totals.running.toLocaleString("en")} running` : null,
    totals.failed ? `${totals.failed.toLocaleString("en")} failed` : null,
    totals.done ? `${totals.done.toLocaleString("en")} done` : null,
  ].filter(Boolean);
  const base = parts.join(" · ") || "No remux jobs yet.";
  if (pause === "plex" && totals.pending) return `${base} · Plex is busy`;
  if (pause === "detect" && totals.pending) return `${base} · language detection is using the disk`;
  if (pause === "window" && totals.pending) {
    return `${base} · waiting for ${hourLabel(settings.startHour)}–${hourLabel(settings.endHour)}`;
  }
  return base;
}

export function RipsView() {
  const [discs, setDiscs] = useState<DiscCandidate[]>([]);
  const [totals, setTotals] = useState<JobTotals>({ pending: 0, running: 0, done: 0, failed: 0 });
  const [settings, setSettings] = useState({ startHour: 1, endHour: 7 });
  const [pause, setPause] = useState<RemuxBody["pause"]>(null);
  const [latest, setLatest] = useState<RemuxBody["latest"]>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    let response: Response;
    try {
      response = await fetch("/api/remux?discs=1", { cache: "no-store" });
    } catch {
      setError("The remux list could not be loaded.");
      setLoading(false);
      return;
    }
    const body = (await response.json().catch(() => null)) as RemuxBody | null;
    if (!response.ok || !body) {
      setError(body?.error || "The remux list could not be loaded.");
      setLoading(false);
      return;
    }
    setError(null);
    setDiscs(body.discs ?? []);
    setTotals(
      body.totals ?? {
        pending: body.counts.waiting,
        running: body.counts.running,
        done: 0,
        failed: 0,
      },
    );
    setSettings(body.settings);
    setPause(body.pause);
    setLatest(body.latest ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    const poll = window.setInterval(() => void load(), 3_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
    };
  }, [load]);

  const filteredDiscs = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return discs;
    return discs.filter(
      (disc) => disc.label.toLowerCase().includes(needle) || disc.path.toLowerCase().includes(needle) || disc.kindLabel.toLowerCase().includes(needle),
    );
  }, [discs, search]);

  function toggle(path: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleAllVisible() {
    const paths = filteredDiscs.map((disc) => disc.path);
    setSelected((previous) => {
      const allOn = paths.length > 0 && paths.every((path) => previous.has(path));
      const next = new Set(previous);
      if (allOn) {
        for (const path of paths) next.delete(path);
      } else {
        for (const path of paths) next.add(path);
      }
      return next;
    });
  }

  async function sendSelected() {
    if (selected.size < 1 || sending) return;
    setSending(true);
    try {
      const paths = [...selected].map((path) => {
        const disc = discs.find((item) => item.path === path);
        return { path, label: disc?.label };
      });
      toastRemux(await enqueueRemuxPaths(paths, extras));
      setSelected(new Set());
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not queue the disc remux.");
    } finally {
      setSending(false);
    }
  }

  async function sendPath() {
    const path = pathInput.trim();
    if (!path || sending) return;
    setSending(true);
    try {
      toastRemux(await enqueueRemuxPaths([{ path }], extras));
      setPathInput("");
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not queue the disc remux.");
    } finally {
      setSending(false);
    }
  }

  async function clearQueue() {
    if (totals.pending < 1 || clearing) return;
    const waiting = totals.pending.toLocaleString("en");
    if (!window.confirm(`Remove ${waiting} waiting discs? A remux already running will finish.`)) return;
    setClearing(true);
    try {
      const response = await fetch("/api/remux", { method: "DELETE" });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || "The queue could not be cleared.");
      toast.success("Waiting remux jobs cleared.");
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The queue could not be cleared.");
    } finally {
      setClearing(false);
    }
  }

  const allVisibleSelected = filteredDiscs.length > 0 && filteredDiscs.every((disc) => selected.has(disc.path));
  const tasksHref =
    totals.failed > 0 && totals.pending === 0 && totals.running === 0
      ? "/tasks?queue=remux&status=failed"
      : totals.running > 0
        ? "/tasks?queue=remux&status=running"
        : "/tasks?queue=remux&status=pending";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-5">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Rips</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              Send ISO, DVD, and Blu-ray disc images for a high-quality MakeMKV remux. Every audio and subtitle track is copied into an MKV beside the disc; nothing is re-encoded, and the disc stays where it is. Progress and failure reasons stay on{" "}
              <Link href="/tasks?queue=remux&status=all" className="underline underline-offset-2">
                Tasks
              </Link>
              .
            </p>
          </div>

          <section className="space-y-2 rounded-lg border px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">Queue</h2>
                <p className="mt-1 text-sm text-muted-foreground">{queueSummary(totals, pause, settings)}</p>
                {latest?.status === "failed" ? (
                  <p className="mt-2 text-sm leading-6 text-destructive">
                    Last failure: {latest.label}
                    {latest.message ? ` — ${latest.message}` : ""}
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
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">Disc images</h2>
                <p className="text-xs text-muted-foreground">Titles already in the library that still look like a disc.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="rips-extras" className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox id="rips-extras" checked={extras} onCheckedChange={(value) => setExtras(value === true)} />
                  Keep extras
                </label>
                <Button size="sm" disabled={selected.size < 1 || sending} onClick={() => void sendSelected()}>
                  {sending ? "Sending…" : selected.size ? `Send ${selected.size} for remux` : "Send for remux"}
                </Button>
              </div>
            </div>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search disc titles or paths"
              aria-label="Search disc titles or paths"
            />
            {error ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-3 text-sm">
                <p>{error}</p>
                <Button className="mt-3" size="sm" variant="outline" onClick={() => void load()}>
                  Retry
                </Button>
              </div>
            ) : null}
            {loading && discs.length === 0 ? <p className="text-sm text-muted-foreground">Loading disc images…</p> : null}
            {!loading && discs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No ISO or DVD images in the library yet. Sync metadata, or paste a path on this machine below.
              </p>
            ) : null}
            {!loading && discs.length > 0 && filteredDiscs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No discs match that search.</p>
            ) : null}
            {filteredDiscs.length > 0 ? (
              <div className="overflow-hidden rounded-lg border">
                <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs">
                  <Checkbox checked={allVisibleSelected} onCheckedChange={() => toggleAllVisible()} aria-label="Select all visible discs" />
                  <span className="text-muted-foreground">
                    {filteredDiscs.length.toLocaleString("en")} disc{filteredDiscs.length === 1 ? "" : "s"}
                    {selected.size ? ` · ${selected.size} selected` : ""}
                  </span>
                </div>
                <ul className="divide-y">
                  {filteredDiscs.map((disc) => (
                    <li key={disc.path}>
                      <label className="flex cursor-pointer items-start gap-3 px-3 py-3 hover:bg-muted/30">
                        <Checkbox
                          checked={selected.has(disc.path)}
                          onCheckedChange={() => toggle(disc.path)}
                          className="mt-0.5"
                          aria-label={`Select ${disc.label}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <span className="text-sm font-medium">{disc.label}</span>
                            <span className="text-xs text-muted-foreground">{disc.kindLabel}</span>
                          </span>
                          <span className="mt-1 block text-xs leading-5 break-all text-muted-foreground">{disc.path}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1 space-y-1.5">
                <label htmlFor="rips-path" className="text-xs font-medium">
                  Or paste a path on this machine
                </label>
                <Input
                  id="rips-path"
                  value={pathInput}
                  onChange={(event) => setPathInput(event.target.value)}
                  placeholder="/movies/Film (1999)/Film.iso"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void sendPath();
                    }
                  }}
                />
              </div>
              <Button size="sm" variant="outline" disabled={!pathInput.trim() || sending} onClick={() => void sendPath()}>
                Send path
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
