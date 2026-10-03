"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { toast } from "sonner";
import { useEffect, useState } from "react";

export function MergeSettingsCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/merge", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { settings?: { enabled: boolean } };
          if (body.settings) setEnabled(body.settings.enabled);
        })
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (enabled == null) return null;

  async function save(next: boolean) {
    setBusy(true);
    try {
      const response = await fetch("/api/merge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; settings?: { enabled: boolean } } | null;
      if (!response.ok) throw new Error(body?.error || "Could not save version merge.");
      if (body?.settings) setEnabled(body.settings.enabled);
      toast.success(next ? "Version merge (beta) is on." : "Version merge is off.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save version merge.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Version merge (beta)</CardTitle>
        <CardDescription>
          Manually combine two copies of the same edit that carry different audio or subtitle tracks. The higher-resolution or higher-bitrate file keeps its
          video; both files keep their audio and subtitles in a new{" "}
          <span className="font-mono text-[11px]">.combined.mkv</span>. Same runtime is required, and ffmpeg compares frames before writing. Nothing runs on a
          schedule.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <Label htmlFor="merge-enabled">Show Merge in the sidebar</Label>
            <p className="text-xs text-muted-foreground">Turn this off to hide the beta page and refuse new merge jobs.</p>
          </div>
          <Switch id="merge-enabled" checked={enabled} disabled={busy} onCheckedChange={(value) => void save(value)} />
        </div>
        {enabled ? (
          <Button type="button" size="sm" variant="outline" asChild>
            <Link href="/merge">Open Merge</Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
