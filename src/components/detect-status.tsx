"use client";

import { useEffect, useState } from "react";

type DetectStatusBody = {
  counts: { immediate: number; window: number; running: number };
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
  if (counts.running === 0 && counts.immediate === 0 && counts.window === 0 && !active) return null;
  const parts = [
    active ? `${active.kind === "audio" ? "Listening to" : "Reading"} ${active.label}` : null,
    counts.immediate ? `${counts.immediate} waiting to start` : null,
    counts.window ? `${counts.window} waiting for the window` : null,
  ].filter(Boolean);
  return <p className="text-xs text-muted-foreground">{parts.join(" · ")}</p>;
}
