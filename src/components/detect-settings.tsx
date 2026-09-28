"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useEffect, useState } from "react";

type PathMap = { from: string; to: string };

type DetectSettings = {
  enabled: boolean;
  startHour: number;
  endHour: number;
  pathMaps: PathMap[];
};

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
        body: JSON.stringify({ pathMaps: settings.pathMaps }),
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
          Listens to unknown audio with Whisper and reads unknown subtitles. A recognized language is written into the file. Plex, Radarr, and Sonarr are asked to re-read it, and Bazarr is asked when the track is a subtitle. The daily hours are set under Schedule.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">Path mapping</p>
            <p className="text-xs leading-5 text-muted-foreground">
              When a Plex path is not a file on this machine, map its prefix to the local prefix. Audio needs ffmpeg and faster-whisper. Text subtitles are read directly. Picture subtitles (PGS, VobSub) need tesseract. Writing the language into a Matroska file needs mkvpropedit.
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
