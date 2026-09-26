"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

type JobTotals = { pending: number; running: number; done: number; failed: number; skipped: number };

type DetectBody = {
  counts: { immediate: number; window: number; running: number };
  totals?: JobTotals;
};

export function toastDetection(message: string) {
  const index = message.indexOf("Tasks");
  if (index < 0) {
    toast.success(message);
    return;
  }
  toast.success(
    <span>
      {message.slice(0, index)}
      <Link href="/tasks" className="underline underline-offset-2">
        Tasks
      </Link>
      {message.slice(index + "Tasks".length)}
    </span>,
    { duration: 8000 },
  );
}

export function TaskCount({ bump, className }: { bump: () => void; className?: string }) {
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
      const totals = body.totals ?? {
        pending: body.counts.immediate + body.counts.window,
        running: body.counts.running,
        done: 0,
        failed: 0,
        skipped: 0,
      };
      setActive(totals.pending + totals.running);
      const finished = `${totals.done}:${totals.failed}:${totals.skipped}`;
      if (seen !== null && finished !== seen) bump();
      seen = finished;
    }
    void load();
    const timer = window.setInterval(() => void load(), 8_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [bump]);

  if (active < 1) return null;
  return <span className={className}>{active.toLocaleString("en")}</span>;
}
