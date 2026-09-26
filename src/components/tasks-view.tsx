"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

const PAGE_SIZE = 50;

const TABS = [
  ["failed", "Failed"],
  ["done", "Done"],
  ["pending", "Waiting"],
  ["running", "Running"],
  ["skipped", "Skipped"],
] as const;

type JobStatus = (typeof TABS)[number][0];

type DetectJobView = {
  id: number;
  path: string;
  label: string;
  kind: "audio" | "subtitle";
  ordinal: number;
  priority: "immediate" | "window";
  status: JobStatus;
  format: string | null;
  placement: string | null;
  streamLabel: string | null;
  message: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type JobTotals = { pending: number; running: number; done: number; failed: number; skipped: number };

type DetectBody = {
  counts: { immediate: number; window: number; running: number };
  totals?: JobTotals;
  jobs?: DetectJobView[];
  total?: number;
  error?: string;
};

function isStatus(value: string | null): value is JobStatus {
  return TABS.some(([status]) => status === value);
}

function queueSummary(totals: JobTotals): string {
  const parts = [
    totals.pending ? `${totals.pending.toLocaleString("en")} waiting` : null,
    totals.running ? `${totals.running.toLocaleString("en")} running` : null,
    totals.failed ? `${totals.failed.toLocaleString("en")} failed` : null,
    totals.done ? `${totals.done.toLocaleString("en")} done` : null,
    totals.skipped ? `${totals.skipped.toLocaleString("en")} skipped` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function taskState(job: DetectJobView): string {
  if (job.status === "running") return job.kind === "audio" ? "Listening" : "Reading";
  if (job.status === "pending" && job.priority === "window") return "Waiting for the window";
  if (job.status === "pending") return "Queued";
  if (job.status === "failed") return "Failed";
  if (job.status === "skipped") return "Skipped";
  return job.message && /[.!?]/.test(job.message) ? "No language" : "Done";
}

function trackLine(job: DetectJobView): string {
  return [
    job.kind === "audio" ? "Audio" : "Subtitle",
    job.format,
    job.placement,
    `track ${job.ordinal + 1}`,
    job.streamLabel,
  ]
    .filter(Boolean)
    .join(" · ");
}

function when(job: DetectJobView): string {
  const stamp = job.finishedAt ?? job.startedAt ?? job.createdAt;
  const date = new Date(stamp);
  const label = job.finishedAt ? "Finished" : job.startedAt ? "Started" : "Queued";
  if (Number.isNaN(date.getTime())) return label;
  return `${label} ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
}

function tabCount(totals: JobTotals, status: JobStatus): number {
  if (status === "pending") return totals.pending;
  return totals[status];
}

export function TasksView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requested = searchParams.get("status");
  const status: JobStatus = isStatus(requested) ? requested : "failed";
  const page = Math.max(1, Math.trunc(Number(searchParams.get("page")) || 1));
  const [jobs, setJobs] = useState<DetectJobView[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState<JobTotals>({ pending: 0, running: 0, done: 0, failed: 0, skipped: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const writeQuery = useCallback(
    (next: { status?: JobStatus; page?: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("status", next.status ?? status);
      params.set("page", String(next.page ?? (next.status && next.status !== status ? 1 : page)));
      router.replace(`/tasks?${params.toString()}`);
    },
    [page, router, searchParams, status],
  );

  const load = useCallback(async () => {
    let response: Response;
    try {
      response = await fetch(`/api/detect?status=${status}&page=${page}&pageSize=${PAGE_SIZE}`, { cache: "no-store" });
    } catch {
      setError("The task list could not be loaded.");
      setLoading(false);
      return;
    }
    const body = (await response.json().catch(() => null)) as DetectBody | null;
    if (!response.ok || !body) {
      setError(body?.error || "The task list could not be loaded.");
      setLoading(false);
      return;
    }
    setError(null);
    setJobs(body.jobs ?? []);
    setTotal(body.total ?? 0);
    setTotals(
      body.totals ?? {
        pending: body.counts.window + body.counts.immediate,
        running: body.counts.running,
        done: 0,
        failed: 0,
        skipped: 0,
      },
    );
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

  async function clearQueue() {
    if (totals.pending < 1 || clearing) return;
    const waiting = totals.pending.toLocaleString("en");
    if (!window.confirm(`Remove ${waiting} waiting tracks? The track already running will finish. Languages already found stay.`)) return;
    setClearing(true);
    try {
      const response = await fetch("/api/detect", { method: "DELETE" });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || "The queue could not be cleared.");
      toast.success("Queue cleared.");
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
  const tabLabel = TABS.find(([value]) => value === status)?.[1] ?? "Failed";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Tasks</h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                Language checks run one track at a time. Failed tracks stay here with the reason they were not read, including an SRT or MP3 whose file path this machine cannot open.
              </p>
            </div>
            {totals.pending > 0 ? (
              <Button size="sm" variant="outline" onClick={() => void clearQueue()} disabled={clearing}>
                Clear queue
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">{queueSummary(totals) || "No language checks yet."}</p>
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
          {loading && jobs.length === 0 ? <p className="text-sm text-muted-foreground">Loading tasks…</p> : null}
          {!loading && jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{total === 0 ? `No ${tabLabel.toLowerCase()} tracks.` : "This page is empty."}</p>
          ) : null}
          <div className="flex flex-col gap-3">
            {jobs.map((job) => (
              <article key={job.id} className="space-y-1.5 rounded-lg border px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="min-w-0 text-sm font-medium">{job.label}</h2>
                  <span className={cn("shrink-0 text-xs", job.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{taskState(job)}</span>
                </div>
                <p className="text-xs text-muted-foreground">{trackLine(job)}</p>
                {job.message ? <p className="text-sm leading-6">{job.message}</p> : null}
                <p className="text-xs leading-5 break-all text-muted-foreground">{job.path}</p>
                <p className="text-xs text-muted-foreground">{when(job)}</p>
              </article>
            ))}
          </div>
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
