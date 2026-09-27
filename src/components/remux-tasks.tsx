"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

type JobTotals = { pending: number; running: number; done: number; failed: number };

type RemuxBody = {
  counts: { waiting: number; running: number };
  totals?: JobTotals;
};

export function toastRemux(message: string) {
  const index = message.indexOf("Rips");
  if (index < 0) {
    toast.success(message);
    return;
  }
  toast.success(
    <span>
      {message.slice(0, index)}
      <Link href="/rips" className="underline underline-offset-2">
        Rips
      </Link>
      {message.slice(index + "Rips".length)}
    </span>,
    { duration: 8000 },
  );
}

export function RemuxCount({ className }: { className?: string }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    let stop = false;
    async function load() {
      let response: Response;
      try {
        response = await fetch("/api/remux", { cache: "no-store" });
      } catch {
        return;
      }
      if (!response.ok || stop) return;
      const body = (await response.json()) as RemuxBody;
      const totals = body.totals ?? { pending: body.counts.waiting, running: body.counts.running, done: 0, failed: 0 };
      setActive(totals.pending + totals.running);
    }
    void load();
    const timer = window.setInterval(() => void load(), 8_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  if (active < 1) return null;
  return <span className={className}>{active.toLocaleString("en")}</span>;
}
