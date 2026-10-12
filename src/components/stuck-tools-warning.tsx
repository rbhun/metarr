"use client";

import type { StuckTool } from "@/lib/stuck-tools";
import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

function since(iso: string): string {
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 120) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

export function StuckToolsWarning() {
  const [tools, setTools] = useState<StuckTool[]>([]);

  useEffect(() => {
    let stop = false;
    async function load() {
      const response = await fetch("/api/stuck", { cache: "no-store" }).catch(() => null);
      if (!response?.ok || stop) return;
      const body = (await response.json()) as { tools: StuckTool[] };
      setTools(body.tools);
    }
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  if (tools.length === 0) return null;
  return (
    <div role="alert" className="flex gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs leading-5 text-amber-900 dark:text-amber-200">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 space-y-1">
        {tools.map((tool) => (
          <p key={tool.id} className="break-words">
            {tool.command}
            {tool.pid ? ` (pid ${tool.pid})` : ""} was stopped {since(tool.killedAt)} ago but has not exited
            {tool.file ? ` while working on ${tool.file}` : ""}. It is waiting on the NAS, usually because the NFS share stopped answering. Metarr stopped waiting
            for it and moved on. The process ends when the NAS answers again; if it does not, restart the machine Metarr runs on, since Docker cannot
            stop it either.
          </p>
        ))}
      </div>
    </div>
  );
}
