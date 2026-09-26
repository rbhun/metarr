"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type RemuxStatusBody = {
  settings: { startHour: number; endHour: number };
  counts: { waiting: number; running: number };
  active: { label: string; progress: number | null; message: string | null } | null;
  pause: "window" | "plex" | "detect" | null;
  latest: { label: string; status: "done" | "failed"; message: string | null } | null;
};

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function RemuxStatus() {
  const [status, setStatus] = useState<RemuxStatusBody | null>(null);

  useEffect(() => {
    let stop = false;
    async function load() {
      const response = await fetch("/api/remux", { cache: "no-store" });
      if (!response.ok || stop) return;
      setStatus((await response.json()) as RemuxStatusBody);
    }
    void load();
    const timer = window.setInterval(() => void load(), 8_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!status) return null;
  const { counts, active, pause, latest, settings } = status;
  const waiting = counts.waiting;
  const idle = !active && waiting === 0 && counts.running === 0;
  if (idle && latest?.status !== "failed") return null;
  const parts = [
    active
      ? `Remuxing ${active.label}${active.progress != null && active.progress > 0 ? ` ${active.progress}%` : ""}`
      : null,
    !active && pause === "plex" && waiting ? `${waiting} waiting · Plex is busy` : null,
    !active && pause === "detect" && waiting ? `${waiting} waiting · language detection is using the disk` : null,
    !active && waiting && pause !== "plex" && pause !== "detect"
      ? `${waiting} waiting for ${hourLabel(settings.startHour)}–${hourLabel(settings.endHour)}`
      : null,
    idle && latest?.status === "failed" ? `Last remux failed: ${latest.label}${latest.message ? `. ${latest.message}` : ""}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {parts.join(" · ")}{" "}
      <Link href="/rips" className="underline underline-offset-2">
        Open Rips
      </Link>
    </p>
  );
}
