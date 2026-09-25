"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useEffect, useState } from "react";

type PathMap = { from: string; to: string };

type DetectSettings = {
  enabled: boolean;
  startHour: number;
  endHour: number;
  pathMaps: PathMap[];
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function DetectSettingsCard() {
  const [settings, setSettings] = useState<DetectSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/detect", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { settings?: DetectSettings };
          if (body.settings) setSettings(body.settings);
        })
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (!settings) return null;

  async function save() {
    if (!settings) return;
    setBusy(true);
    try {
      const response = await fetch("/api/detect", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; settings?: DetectSettings } | null;
      if (!response.ok) throw new Error(body?.error || "Could not save language detection.");
      if (body?.settings) setSettings(body.settings);
      toast.success("Language detection settings saved on this machine.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save language detection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Language detection</CardTitle>
        <CardDescription>
          Listens to unknown audio with Whisper and reads unknown subtitles. Start now runs immediately. Queued tracks and the daily library scan run only between the start and end hour, and wait while Plex is scanning or transcoding. Results stay in Metarr.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
          <Label htmlFor="detect-enabled">Scan unknown tracks every day</Label>
          <Switch
            id="detect-enabled"
            checked={settings.enabled}
            onCheckedChange={(value) => setSettings({ ...settings, enabled: value === true })}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="detect-start">Start hour</Label>
            <select
              id="detect-start"
              value={settings.startHour}
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              onChange={(event) => setSettings({ ...settings, startHour: Number(event.target.value) })}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={hour}>
                  {hourLabel(hour)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="detect-end">End hour</Label>
            <select
              id="detect-end"
              value={settings.endHour}
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              onChange={(event) => setSettings({ ...settings, endHour: Number(event.target.value) })}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={hour}>
                  {hourLabel(hour)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">Path mapping</p>
            <p className="text-xs leading-5 text-muted-foreground">
              When a Plex path is not a file on this machine, map its prefix to the local prefix. Audio needs ffmpeg and faster-whisper. Text subtitles are read directly. Picture subtitles (PGS, VobSub) need tesseract.
            </p>
          </div>
          {settings.pathMaps.map((map, index) => (
            <div key={`${map.from}-${index}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Input
                value={map.from}
                placeholder="/mnt/media"
                aria-label={`Plex path prefix ${index + 1}`}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    pathMaps: settings.pathMaps.map((item, itemIndex) => (itemIndex === index ? { ...item, from: event.target.value } : item)),
                  })
                }
              />
              <Input
                value={map.to}
                placeholder="/Volumes/media"
                aria-label={`Local path prefix ${index + 1}`}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    pathMaps: settings.pathMaps.map((item, itemIndex) => (itemIndex === index ? { ...item, to: event.target.value } : item)),
                  })
                }
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setSettings({ ...settings, pathMaps: settings.pathMaps.filter((_, itemIndex) => itemIndex !== index) })}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={() => setSettings({ ...settings, pathMaps: [...settings.pathMaps, { from: "", to: "" }] })}>
            Add path mapping
          </Button>
        </div>
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          Save language detection
        </Button>
      </CardContent>
    </Card>
  );
}
