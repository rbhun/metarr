"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

const PAGE_SIZE = 50;

const QUEUES = [
  ["all", "All"],
  ["language", "Languages"],
  ["remux", "Rips"],
] as const;

const TABS = [
  ["all", "All"],
  ["failed", "Failed"],
  ["done", "Done"],
  ["pending", "Waiting"],
  ["running", "Running"],
  ["skipped", "Skipped"],
] as const;

type QueueFilter = (typeof QUEUES)[number][0];
type JobStatus = Exclude<(typeof TABS)[number][0], "all">;
type StatusFilter = (typeof TABS)[number][0];

type TaskJob = {
  key: string;
  queue: "language" | "remux";
  id: number;
  path: string;
  label: string;
  status: JobStatus;
  message: string | null;
  priority: "immediate" | "window" | null;
  detail: string;
  progress: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  titleId?: number | null;
};

type JobTotals = { pending: number; running: number; done: number; failed: number; skipped: number };

type TasksBody = {
  totals?: JobTotals;
  allTotal?: number;
  jobs?: TaskJob[];
  total?: number;
  error?: string;
};

function isStatus(value: string | null): value is StatusFilter {
  return TABS.some(([status]) => status === value);
}

function totalsSum(totals: JobTotals): number {
  return totals.pending + totals.running + totals.done + totals.failed + totals.skipped;
}

function isQueue(value: string | null): value is QueueFilter {
  return QUEUES.some(([queue]) => queue === value);
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

function taskState(job: TaskJob): string {
  if (job.status === "running") {
    if (job.queue === "remux") {
      if (job.progress != null && job.progress > 0) return `Remuxing ${job.progress}%`;
      return job.message || "Remuxing";
    }
    return job.detail.startsWith("Audio") ? "Listening" : "Reading";
  }
  if (job.status === "pending") return job.priority === "window" ? "Waiting for the window" : "Starting";
  if (job.status === "failed") return "Failed";
  if (job.status === "skipped") return "Skipped";
  if (job.queue === "remux") return job.message?.startsWith("Dry run:") ? "Dry run" : "Saved";
  return job.message && /[.!?]/.test(job.message) ? "No language" : "Done";
}

function when(job: TaskJob): string {
  const stamp = job.finishedAt ?? job.startedAt ?? job.createdAt;
  const date = new Date(stamp);
  const label = job.finishedAt ? "Finished" : job.startedAt ? "Started" : "Queued";
  if (Number.isNaN(date.getTime())) return label;
  return `${label} ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date)}`;
}

function tabCount(totals: JobTotals, status: StatusFilter): number {
  if (status === "all") return totalsSum(totals);
  return totals[status];
}

function failureText(job: TaskJob): string {
  if (job.message?.trim()) return job.message;
  if (job.queue === "remux") return "Remux failed with no further detail from MakeMKV.";
  return "Language check failed with no further detail.";
}

function rowTone(status: JobStatus): string {
  if (status === "failed") return "border-rose-500/40 bg-rose-500/10";
  if (status === "running") return "border-amber-500/40 bg-amber-500/10";
  if (status === "done") return "border-emerald-500/30 bg-emerald-500/10";
  if (status === "skipped") return "bg-muted/40";
  return "";
}

function stateTone(status: JobStatus): string {
  if (status === "failed") return "text-rose-700 dark:text-rose-300";
  if (status === "running") return "text-amber-800 dark:text-amber-200";
  if (status === "done") return "text-emerald-700 dark:text-emerald-300";
  return "text-muted-foreground";
}

export function TasksView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requested = searchParams.get("status");
  const status: StatusFilter = isStatus(requested) ? requested : "all";
  const queue: QueueFilter = isQueue(searchParams.get("queue")) ? (searchParams.get("queue") as QueueFilter) : "all";
  const page = Math.max(1, Math.trunc(Number(searchParams.get("page")) || 1));
  const [jobs, setJobs] = useState<TaskJob[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState<JobTotals>({ pending: 0, running: 0, done: 0, failed: 0, skipped: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [redoing, setRedoing] = useState<string | null>(null);

  const writeQuery = useCallback(
    (next: { status?: StatusFilter; page?: number; queue?: QueueFilter }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("queue", next.queue ?? queue);
      params.set("status", next.status ?? status);
      params.set("page", String(next.page ?? ((next.status && next.status !== status) || (next.queue && next.queue !== queue) ? 1 : page)));
      router.replace(`/tasks?${params.toString()}`);
    },
    [page, queue, router, searchParams, status],
  );

  const load = useCallback(async () => {
    let response: Response;
    try {
      response = await fetch(`/api/tasks?queue=${queue}&status=${status}&page=${page}&pageSize=${PAGE_SIZE}`, { cache: "no-store" });
    } catch {
      setError("The task list could not be loaded.");
      setLoading(false);
      return;
    }
    const body = (await response.json().catch(() => null)) as TasksBody | null;
    if (!response.ok || !body) {
      setError(body?.error || "The task list could not be loaded.");
      setLoading(false);
      return;
    }
    setError(null);
    setJobs(body.jobs ?? []);
    setTotal(body.total ?? 0);
    setTotals(body.totals ?? { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 });
    setLoading(false);
  }, [page, queue, status]);

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

  async function redoJob(job: TaskJob) {
    if (job.status !== "failed" || redoing) return;
    setRedoing(job.key);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queue: job.queue, id: job.id }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; result?: string } | null;
      if (!response.ok) throw new Error(body?.error || "That task could not be redone.");
      toast.success(body?.result === "already" ? "That task is already queued." : "Queued again.");
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "That task could not be redone.");
    } finally {
      setRedoing(null);
    }
  }

  async function clearFiltered() {
    const count = tabCount(totals, status);
    if (count < 1 || clearing || status === "running" || status === "all") return;
    const name = (TABS.find(([value]) => value === status)?.[1] ?? status).toLowerCase();
    const noun = queue === "remux" ? (count === 1 ? "disc" : "discs") : queue === "language" ? (count === 1 ? "track" : "tracks") : count === 1 ? "job" : "jobs";
    const shown = count.toLocaleString("en");
    if (!window.confirm(`Remove ${shown} ${name} ${noun} from the list? Languages already found stay. A job that is already running will finish.`)) return;
    setClearing(true);
    try {
      const response = await fetch(`/api/tasks?queue=${queue}&status=${status}`, { method: "DELETE" });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || "Those jobs could not be cleared.");
      toast.success(`${shown} ${name} ${noun} removed.`);
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Those jobs could not be cleared.");
    } finally {
      setClearing(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const pageStart = total === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(safePage * PAGE_SIZE, total);
  const tabLabel = TABS.find(([value]) => value === status)?.[1] ?? "All";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Tasks</h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                Language checks and disc remuxes share this list. Failed jobs keep the reason they stopped, including a missing MakeMKV binary or a path this machine cannot open.
              </p>
            </div>
            {status !== "running" && status !== "all" && tabCount(totals, status) > 0 ? (
              <Button size="sm" variant="outline" onClick={() => void clearFiltered()} disabled={clearing}>
                Clear
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">{queueSummary(totals) || "No tasks yet."}</p>
          <div className="flex flex-wrap gap-1.5">
            {QUEUES.map(([value, label]) => (
              <Button key={value} size="sm" variant={queue === value ? "default" : "outline"} onClick={() => writeQuery({ queue: value, page: 1 })}>
                {label}
              </Button>
            ))}
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
          {loading && jobs.length === 0 ? <p className="text-sm text-muted-foreground">Loading tasks…</p> : null}
          {!loading && jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {total === 0 ? (status === "all" ? "No tasks yet." : `No ${tabLabel.toLowerCase()} tasks.`) : "This page is empty."}
            </p>
          ) : null}
          <div className="flex flex-col gap-3">
            {jobs.map((job) => (
              <article key={job.key} className={cn("space-y-1.5 rounded-lg border px-3 py-3", rowTone(job.status))}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="min-w-0 text-sm font-medium">
                      {job.titleId ? (
                        <Link href={`/?file=${encodeURIComponent(job.path)}`} className="hover:underline underline-offset-2">
                          {job.label}
                        </Link>
                      ) : (
                        job.label
                      )}
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {job.queue === "remux" ? "Rip" : "Language"}
                      {job.detail ? ` · ${job.detail}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {job.status === "failed" ? (
                      <Button size="sm" variant="outline" disabled={redoing === job.key} onClick={() => void redoJob(job)}>
                        {redoing === job.key ? "Queuing…" : "Redo"}
                      </Button>
                    ) : null}
                    <span className={cn("text-xs", stateTone(job.status))}>{taskState(job)}</span>
                  </div>
                </div>
                {job.status === "failed" ? (
                  <p className="text-sm leading-6">{failureText(job)}</p>
                ) : job.message ? (
                  <p className="text-sm leading-6">{job.message}</p>
                ) : null}
                <p className="text-xs leading-5 break-all text-muted-foreground">{job.path}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{when(job)}</span>
                  {job.queue === "remux" ? (
                    <Link href="/rips" className="underline underline-offset-2">
                      Open Rips
                    </Link>
                  ) : null}
                </div>
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
