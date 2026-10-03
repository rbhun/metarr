"use client";

import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

type Reading = { host: number | null; docker: number | null };

function format(value: number | null): string {
  return value == null ? "—" : `${value}%`;
}

export function CpuReadout({ compact = false, className }: { compact?: boolean; className?: string }) {
  const [reading, setReading] = useState<Reading>({ host: null, docker: null });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/cpu", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { host?: number | null; percent?: number | null; docker?: number | null };
        if (cancelled) return;
        setReading({
          host: typeof body.host === "number" ? body.host : typeof body.percent === "number" ? body.percent : null,
          docker: typeof body.docker === "number" ? body.docker : null,
        });
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

  const host = format(reading.host);
  const docker = format(reading.docker);
  const title = "Whole machine, then this container. Both are a share of every core.";
  const label =
    reading.host == null && reading.docker == null
      ? "CPU usage unavailable"
      : `Machine ${reading.host ?? "unknown"} percent, container ${reading.docker ?? "unknown"} percent`;

  if (compact) {
    return (
      <p className={cn("text-center text-[11px] leading-tight tabular-nums text-muted-foreground", className)} aria-label={label} title={title}>
        VM {host}
        <span className="block">Ctr {docker}</span>
      </p>
    );
  }

  return (
    <p className={cn("text-xs tabular-nums text-muted-foreground", className)} aria-label={label} title={title}>
      VM {host}
      <span className="mx-1 text-muted-foreground/60">·</span>
      Ctr {docker}
    </p>
  );
}
