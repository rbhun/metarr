"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ListTodo } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type DetectJobView = {
  id: number;
  label: string;
  kind: "audio" | "subtitle";
  priority: "immediate" | "window";
  status: "pending" | "running" | "done" | "failed" | "skipped";
  format: string | null;
  message: string | null;
};

type JobTotals = { pending: number; running: number; done: number; failed: number; skipped: number };

type DetectBody = {
  counts: { immediate: number; window: number; running: number };
  totals?: JobTotals;
  jobs?: DetectJobView[];
};

function queueSummary(totals: JobTotals): string {
  const parts = [
    totals.pending ? `${totals.pending.toLocaleString("en")} waiting` : null,
    totals.running ? `${totals.running} running` : null,
    totals.failed ? `${totals.failed.toLocaleString("en")} failed` : null,
    totals.done ? `${totals.done.toLocaleString("en")} done` : null,
    totals.skipped ? `${totals.skipped.toLocaleString("en")} skipped` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

const taskDialogOpeners = new Set<() => void>();

export function openTasksDialog() {
  for (const open of taskDialogOpeners) open();
}

export function toastDetection(message: string) {
  const index = message.indexOf("Tasks");
  if (index < 0) {
    toast.success(message);
    return;
  }
  const handle: { id: string | number } = { id: 0 };
  handle.id = toast.success(
    <span>
      {message.slice(0, index)}
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={(event) => {
          event.stopPropagation();
          openTasksDialog();
          toast.dismiss(handle.id);
        }}
      >
        Tasks
      </button>
      {message.slice(index + "Tasks".length)}
    </span>,
    { duration: 8000 },
  );
}

function taskState(job: DetectJobView): string {
  if (job.status === "running") return job.kind === "audio" ? "Listening" : "Reading";
  if (job.status === "pending" && job.priority === "window") return "Waiting for the window";
  if (job.status === "pending") return "Queued";
  if (job.status === "failed") return "Failed";
  if (job.status === "skipped") return "Skipped";
  return job.message && /[.!?]/.test(job.message) ? "No language" : "Done";
}

export function DetectTasks({
  collapsed = false,
  compact = false,
  dialog = false,
  className,
  bump,
}: {
  collapsed?: boolean;
  compact?: boolean;
  dialog?: boolean;
  className?: string;
  bump: () => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!dialog) return;
    const openDialog = () => setOpen(true);
    taskDialogOpeners.add(openDialog);
    return () => {
      taskDialogOpeners.delete(openDialog);
    };
  }, [dialog]);

  function showTasks() {
    if (dialog) setOpen(true);
    else openTasksDialog();
  }
  const [jobs, setJobs] = useState<DetectJobView[]>([]);
  const [totals, setTotals] = useState<JobTotals>({ pending: 0, running: 0, done: 0, failed: 0, skipped: 0 });
  const [clearing, setClearing] = useState(false);
  const [active, setActive] = useState(0);

  function applyBody(body: DetectBody) {
    const next = body.jobs ?? [];
    setTotals(body.totals ?? { pending: body.counts.window + body.counts.immediate, running: body.counts.running, done: 0, failed: 0, skipped: 0 });
    setActive(body.counts.running + body.counts.immediate + body.counts.window);
    setJobs(next);
    return next;
  }

  async function clearQueue() {
    if (totals.pending < 1 || clearing) return;
    const waiting = totals.pending.toLocaleString("en");
    if (!window.confirm(`Remove ${waiting} waiting tracks? The track already running will finish. Languages already found stay.`)) return;
    setClearing(true);
    try {
      const response = await fetch("/api/detect", { method: "DELETE" });
      const body = (await response.json().catch(() => null)) as (DetectBody & { error?: string }) | null;
      if (!response.ok || !body) throw new Error(body?.error || "The queue could not be cleared.");
      applyBody(body);
      toast.success("Queue cleared.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The queue could not be cleared.");
    } finally {
      setClearing(false);
    }
  }

  useEffect(() => {
    let stop = false;
    let seen: string | null = null;
    async function load() {
      let response: Response;
      try {
        response = await fetch("/api/detect", { cache: "no-store" });
      } catch {
        return;
      }
      if (!response.ok || stop) return;
      const body = (await response.json()) as DetectBody;
      const next = applyBody(body);
      const finished = next
        .filter((job) => job.status === "done" || job.status === "failed" || job.status === "skipped")
        .map((job) => `${job.id}:${job.status}`)
        .join(",");
      if (seen !== null && finished !== seen) bump();
      seen = finished;
    }
    void load();
    const timer = window.setInterval(() => void load(), open ? 2_000 : 8_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [open, bump]);

  return (
    <>
      {compact ? (
        <Button variant="ghost" size="sm" title="Tasks" aria-label="Tasks" className="text-muted-foreground" onClick={showTasks}>
          <ListTodo />
          Tasks
          {active > 0 ? <span className="text-xs">{active}</span> : null}
        </Button>
      ) : (
        <button type="button" title={collapsed ? "Tasks" : undefined} aria-label="Tasks" className={className} onClick={showTasks}>
          <ListTodo />
          {collapsed ? <span className="sr-only">Tasks</span> : "Tasks"}
          {!collapsed && active > 0 ? <span className="ml-auto text-xs">{active}</span> : null}
        </button>
      )}
      {dialog ? <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Tasks</DialogTitle>
            <DialogDescription>Language checks run one track at a time. Finished and failed tracks stay listed here. A failed line says why the label stayed Unknown.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{queueSummary(totals) || "No language checks yet."}</p>
            {totals.pending > 0 ? (
              <Button size="sm" variant="outline" onClick={() => void clearQueue()} disabled={clearing}>
                Clear queue
              </Button>
            ) : null}
          </div>
          <div className="flex max-h-96 flex-col gap-3 overflow-auto">
            {jobs.length === 0 ? <p className="text-sm text-muted-foreground">{totals.pending > 0 ? "Nothing has finished yet." : "No language checks yet."}</p> : null}
            {jobs.map((job) => (
              <div key={job.id} className="space-y-1">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-medium">{job.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{taskState(job)}</span>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {job.kind === "audio" ? "Audio" : "Subtitle"}
                  {job.format ? ` · ${job.format}` : ""}
                  {job.message ? ` · ${job.message}` : ""}
                </p>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog> : null}
    </>
  );
}
