"use client";

import { enqueueRemuxPaths } from "@/components/remux-actions";
import { toastRemux } from "@/components/remux-tasks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const PAGE_SIZE = 50;

const TABS = [
  ["pending", "Waiting"],
  ["running", "Running"],
  ["done", "Done"],
  ["failed", "Failed"],
] as const;

type JobStatus = (typeof TABS)[number][0];

type DiscCandidate = {
  path: string;
  label: string;
  kind: string;
  kindLabel: string;
};

type RemuxJobView = {
  id: number;
  path: string;
  label: string;
  extras: boolean;
  status: JobStatus;
  message: string | null;
  progress: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type JobTotals = { pending: number; running: number; done: number; failed: number };

type RemuxBody = {
  settings: { startHour: number; endHour: number };
  counts: { waiting: number; running: number };
  totals?: JobTotals;
  pause: "window" | "plex" | "detect" | null;
  discs?: DiscCandidate[];
  jobs?: RemuxJobView[];
  total?: number;
  error?: string;
};

function isStatus(value: string | null): value is JobStatus {
  return TABS.some(([status]) => status === value);
}

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

function jobState(job: RemuxJobView): string {
  if (job.status === "running") {
    if (job.progress != null && job.progress > 0) return `Remuxing ${job.progress}%`;
    return job.message || "Remuxing";
  }
  if (job.status === "pending") return "Queued";
  if (job.status === "failed") return "Failed";
  return "Done";
}

function when(job: RemuxJobView): string {
  const stamp = job.finishedAt ?? job.startedAt ?? job.createdAt;
  const date = new Date(stamp);
  const label = job.finishedAt ? "Finished" : job.startedAt ? "Started" : "Queued";
  if (Number.isNaN(date.getTime())) return label;
  return `${label} ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
}

function tabCount(totals: JobTotals, status: JobStatus): number {
  return totals[status];
}

export function RipsView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requested = searchParams.get("status");
  const status: JobStatus = isStatus(requested) ? requested : "pending";
  const page = Math.max(1, Math.trunc(Number(searchParams.get("page")) || 1));
  const [discs, setDiscs] = useState<DiscCandidate[]>([]);
  const [jobs, setJobs] = useState<RemuxJobView[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState<JobTotals>({ pending: 0, running: 0, done: 0, failed: 0 });
  const [settings, setSettings] = useState({ startHour: 1, endHour: 7 });
  const [pause, setPause] = useState<RemuxBody["pause"]>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);

  const writeQuery = useCallback(
    (next: { status?: JobStatus; page?: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("status", next.status ?? status);
      params.set("page", String(next.page ?? (next.status && next.status !== status ? 1 : page)));
      router.replace(`/rips?${params.toString()}`);
    },
    [page, router, searchParams, status],
  );

  const load = useCallback(async () => {
    let response: Response;
    try {
      response = await fetch(`/api/remux?discs=1&status=${status}&page=${page}&pageSize=${PAGE_SIZE}`, { cache: "no-store" });
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
    setJobs(body.jobs ?? []);
    setTotal(body.total ?? 0);
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
    setLoading(false);
  }, [page, status]);

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

  useEffect(() => {
    if (loading || error) return;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > pages) writeQuery({ page: pages });
  }, [error, loading, page, total, writeQuery]);

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
      writeQuery({ status: "pending", page: 1 });
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
      writeQuery({ status: "pending", page: 1 });
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

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const pageStart = total === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(safePage * PAGE_SIZE, total);
  const tabLabel = TABS.find(([value]) => value === status)?.[1] ?? "Waiting";
  const allVisibleSelected = filteredDiscs.length > 0 && filteredDiscs.every((disc) => selected.has(disc.path));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-5">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Rips</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              Send ISO, DVD, and Blu-ray disc images for a high-quality MakeMKV remux. Every audio and subtitle track is copied into an MKV beside the disc; nothing is re-encoded, and the disc stays where it is.
            </p>
          </div>

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
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={() => toggleAllVisible()}
                    aria-label="Select all visible discs"
                  />
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

          <section className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium">Queue</h2>
                <p className="mt-1 text-sm text-muted-foreground">{queueSummary(totals, pause, settings)}</p>
              </div>
              {totals.pending > 0 ? (
                <Button size="sm" variant="outline" onClick={() => void clearQueue()} disabled={clearing}>
                  Clear waiting
                </Button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TABS.map(([value, label]) => (
                <Button key={value} size="sm" variant={status === value ? "default" : "outline"} onClick={() => writeQuery({ status: value, page: 1 })}>
                  {label}
                  <span className={cn("text-xs", status === value ? "text-primary-foreground/80" : "text-muted-foreground")}>
                    {tabCount(totals, value).toLocaleString("en")}
                  </span>
                </Button>
              ))}
            </div>
            {error ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-3 text-sm">
                <p>{error}</p>
                <Button className="mt-3" size="sm" variant="outline" onClick={() => void load()}>
                  Retry
                </Button>
              </div>
            ) : null}
            {loading && jobs.length === 0 ? <p className="text-sm text-muted-foreground">Loading queue…</p> : null}
            {!loading && jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{total === 0 ? `No ${tabLabel.toLowerCase()} remux jobs.` : "This page is empty."}</p>
            ) : null}
            <div className="flex flex-col gap-3">
              {jobs.map((job) => (
                <article key={job.id} className="space-y-1.5 rounded-lg border px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="min-w-0 text-sm font-medium">{job.label}</h3>
                    <span className={cn("shrink-0 text-xs", job.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                      {jobState(job)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{job.extras ? "Longest title and extras" : "Longest title only"}</p>
                  {job.message ? <p className="text-sm leading-6">{job.message}</p> : null}
                  <p className="text-xs leading-5 break-all text-muted-foreground">{job.path}</p>
                  <p className="text-xs text-muted-foreground">{when(job)}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
      {total > 0 ? (
        <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
          <p>
            {pageStart.toLocaleString("en")}–{pageEnd.toLocaleString("en")} of {total.toLocaleString("en")}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={safePage <= 1} onClick={() => writeQuery({ page: safePage - 1 })}>
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={safePage * PAGE_SIZE >= total} onClick={() => writeQuery({ page: safePage + 1 })}>
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
