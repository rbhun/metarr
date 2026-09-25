"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ListTodo } from "lucide-react";
import { useEffect, useState } from "react";

type DetectJobView = {
  id: number;
  label: string;
  kind: "audio" | "subtitle";
  priority: "immediate" | "window";
  status: "pending" | "running" | "done" | "failed" | "skipped";
  message: string | null;
};

type DetectBody = {
  counts: { immediate: number; window: number; running: number };
  jobs?: DetectJobView[];
};

function taskState(job: DetectJobView): string {
  if (job.status === "running") return job.kind === "audio" ? "Listening" : "Reading";
  if (job.status === "pending" && job.priority === "window") return "Waiting for the window";
  if (job.status === "pending") return "Queued";
  if (job.status === "failed") return "Failed";
  if (job.status === "skipped") return "Skipped";
  return job.message && /[.!?]/.test(job.message) ? "No language" : "Done";
}

export function DetectTasks({ collapsed = false, compact = false, bump }: { collapsed?: boolean; compact?: boolean; bump: () => void }) {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<DetectJobView[]>([]);
  const [active, setActive] = useState(0);

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
      const next = body.jobs ?? [];
      const finished = next
        .filter((job) => job.status === "done" || job.status === "failed" || job.status === "skipped")
        .map((job) => `${job.id}:${job.status}`)
        .join(",");
      if (seen !== null && finished !== seen) bump();
      seen = finished;
      setActive(body.counts.running + body.counts.immediate + body.counts.window);
      setJobs(next);
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
      <Button variant="outline" size={compact ? "sm" : "default"} title="Tasks" className={collapsed ? "w-full px-0" : compact ? "" : "w-full"} aria-label="Tasks" onClick={() => setOpen(true)}>
        <ListTodo />
        {collapsed ? <span className="sr-only">Tasks</span> : "Tasks"}
        {!collapsed && active > 0 ? <span className="text-xs text-muted-foreground">{active}</span> : null}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Tasks</DialogTitle>
            <DialogDescription>Language checks run one track at a time. A failed line says why the label stayed Unknown.</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-96 flex-col gap-3 overflow-auto">
            {jobs.length === 0 ? <p className="text-sm text-muted-foreground">No language checks yet.</p> : null}
            {jobs.map((job) => (
              <div key={job.id} className="space-y-1">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-medium">{job.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{taskState(job)}</span>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {job.kind === "audio" ? "Audio" : "Subtitle"}
                  {job.message ? ` · ${job.message}` : ""}
                </p>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
