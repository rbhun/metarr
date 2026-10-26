"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useEffect, useState } from "react";

export function RewrapSettingsCard() {
  const [firstLanguage, setFirstLanguage] = useState<string | null>(null);
  const [deinterlace, setDeinterlace] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/rewrap", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { settings?: { firstLanguage: string; deinterlace: boolean } };
          if (body.settings) {
            setFirstLanguage(body.settings.firstLanguage);
            setDeinterlace(body.settings.deinterlace);
          }
        })
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (firstLanguage == null) return null;

  async function save() {
    setBusy(true);
    try {
      const response = await fetch("/api/rewrap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstLanguage: firstLanguage ?? "", deinterlace }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; settings?: { firstLanguage: string; deinterlace: boolean } } | null;
      if (!response.ok) throw new Error(body?.error || "Could not save MKV rewrap.");
      if (body?.settings) {
        setFirstLanguage(body.settings.firstLanguage);
        setDeinterlace(body.settings.deinterlace);
      }
      toast.success("MKV rewrap settings saved on this machine.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save MKV rewrap.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>MKV rewrap</CardTitle>
        <CardDescription>
          ffmpeg copies an AVI or a loose M2TS or TS file into an MKV with the same name beside it, without re-encoding. Every video and audio track is
          kept. Audio and subtitle languages Metarr already knows are written onto the tracks. Sidecar subtitles keep matching because the name stays the
          same. The original is never removed. The hours are set under Schedule.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="rewrap-first-language">Audio language first</Label>
          <Input
            id="rewrap-first-language"
            value={firstLanguage}
            placeholder="Leave empty to keep the file's order"
            onChange={(event) => setFirstLanguage(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">Tracks in this language move to the front and become the default. Tracks with no known language keep their place after them.</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="rewrap-deinterlace" className="flex items-center gap-2 text-sm font-medium">
            <Checkbox id="rewrap-deinterlace" checked={deinterlace} onCheckedChange={(value) => setDeinterlace(value === true)} />
            Deinterlace AVIs that need it
          </label>
          <p className="text-xs text-muted-foreground">
            Before each AVI is rewrapped, ffmpeg looks at a few hundred frames in three places. When the picture is interlaced or telecined, it is
            deinterlaced and re-encoded as H.264 (CRF 18), which takes much longer than a copy. Audio and subtitles are still copied. Progressive AVIs are
            copied as before. Tasks says what was found for each file.
          </p>
        </div>
        <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}
