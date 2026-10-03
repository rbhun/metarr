"use client";

import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

export function CpuReadout({ compact = false, className }: { compact?: boolean; className?: string }) {
  const [percent, setPercent] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/cpu", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { percent?: number | null };
        if (!cancelled && typeof body.percent === "number") setPercent(body.percent);
      } catch {
        // The drawer stays usable if the meter misses a sample.
      }
    }
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const label = percent == null ? "—" : `${percent}%`;
  return (
    <p
      className={cn("text-xs tabular-nums text-muted-foreground", compact && "text-[11px] leading-none", className)}
      aria-label={percent == null ? "CPU usage unavailable" : `CPU ${percent} percent`}
      title="CPU use on this machine"
    >
      {compact ? label : `CPU ${label}`}
    </p>
  );
}
