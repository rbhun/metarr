"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

type DetectStatusBody = {
  counts: { immediate: number; window: number; running: number };
  totals?: { pending: number; running: number; done: number; failed: number; skipped: number };
  active: { label: string; kind: "audio" | "subtitle" } | null;
};

export function DetectStatus() {
  const [status, setStatus] = useState<DetectStatusBody | null>(null);

  useEffect(() => {
    let stop = false;
    async function load() {
      const response = await fetch("/api/detect", { cache: "no-store" });
      if (!response.ok || stop) return;
      setStatus((await response.json()) as DetectStatusBody);
    }
    void load();
    const timer = window.setInterval(() => void load(), 8_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!status) return null;
  const { counts, active } = status;
  const failed = status.totals?.failed ?? 0;
  if (counts.running === 0 && counts.immediate === 0 && counts.window === 0 && !active && failed === 0) return null;
  const parts: ReactNode[] = [
    active ? `${active.kind === "audio" ? "Listening to" : "Reading"} ${active.label}` : null,
    counts.immediate ? `${counts.immediate} waiting to start` : null,
    counts.window ? `${counts.window} waiting for the window` : null,
    failed ? (
      <Link href="/tasks?queue=language&status=failed" className="underline underline-offset-2">
        {failed === 1 ? "1 failed language check" : `${failed.toLocaleString("en")} failed language checks`}
      </Link>
    ) : null,
  ].filter((part) => part != null);
  return (
    <p className="text-xs text-muted-foreground">
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? " · " : null}
          {part}
        </span>
      ))}
    </p>
  );
}
