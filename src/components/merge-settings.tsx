"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import Link from "next/link";
import { toast } from "sonner";
import { useEffect, useState } from "react";

type Settings = { enabled: boolean; maxDurationDeltaMinutes: number; frameSampleCount: number };

export function MergeSettingsCard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [deltaText, setDeltaText] = useState("1");
  const [framesText, setFramesText] = useState("12");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/merge", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { settings?: Settings };
          if (body.settings) {
            setSettings(body.settings);
            setDeltaText(String(body.settings.maxDurationDeltaMinutes));
            setFramesText(String(body.settings.frameSampleCount));
          }
        })
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (settings == null) return null;

  async function save(patch: Partial<Settings>) {
    setBusy(true);
    try {
      const response = await fetch("/api/merge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: patch.enabled ?? settings!.enabled,
          maxDurationDeltaMinutes: patch.maxDurationDeltaMinutes ?? settings!.maxDurationDeltaMinutes,
          frameSampleCount: patch.frameSampleCount ?? settings!.frameSampleCount,
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; settings?: Settings } | null;
      if (!response.ok) throw new Error(body?.error || "Could not save version merge.");
      if (body?.settings) {
        setSettings(body.settings);
        setDeltaText(String(body.settings.maxDurationDeltaMinutes));
        setFramesText(String(body.settings.frameSampleCount));
      }
      toast.success("Version merge settings saved.");
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
          <span className="font-mono text-[11px]">.combined.mkv</span>. ffmpeg compares frames before writing. A runtime gap can be PAL speed, titles, or a
          missing open; Check frames looks for a constant start offset and Merge delays or trims the other file's audio to match. The pictures decide. Nothing
          runs on a schedule.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <Label htmlFor="merge-enabled">Show Merge in the sidebar</Label>
            <p className="text-xs text-muted-foreground">Turn this off to hide the beta page and refuse new merge jobs.</p>
          </div>
          <Switch
            id="merge-enabled"
            checked={settings.enabled}
            disabled={busy}
            onCheckedChange={(value) => void save({ enabled: value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="merge-duration-delta">Max runtime difference (minutes)</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="merge-duration-delta"
              type="number"
              min={0}
              max={120}
              step={0.5}
              value={deltaText}
              disabled={busy}
              className="w-28"
              onChange={(event) => setDeltaText(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => {
                const value = Number(deltaText);
                if (!Number.isFinite(value)) {
                  toast.error("Use a runtime difference between 0 and 120 minutes.");
                  return;
                }
                void save({ maxDurationDeltaMinutes: value });
              }}
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Two versions can differ by up to this many minutes and still appear on the list. Check frames, not this number, decides if they are the same edit.
            Default is 1.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="merge-frame-count">Frame samples</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="merge-frame-count"
              type="number"
              min={4}
              max={24}
              step={1}
              value={framesText}
              disabled={busy}
              className="w-28"
              onChange={(event) => setFramesText(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => {
                const value = Number(framesText);
                if (!Number.isInteger(value) || value < 4 || value > 24) {
                  toast.error("Use between 4 and 24 frame samples.");
                  return;
                }
                void save({ frameSampleCount: value });
              }}
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">How many pictures Check frames compares. Default is 12. About 80% must match.</p>
        </div>
        {settings.enabled ? (
          <Button type="button" size="sm" variant="outline" asChild>
            <Link href="/merge">Open Merge</Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
