"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useEffect, useState } from "react";

type RewrapCardSettings = {
  firstLanguage: string;
  deleteOld: boolean;
};

export function RewrapSettingsCard() {
  const [settings, setSettings] = useState<RewrapCardSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/rewrap", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { settings?: RewrapCardSettings };
          if (body.settings) setSettings({ firstLanguage: body.settings.firstLanguage, deleteOld: body.settings.deleteOld === true });
        })
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (!settings) return null;

  async function saveDeleteOld(deleteOld: boolean) {
    if (!settings) return;
    const previous = settings.deleteOld;
    setSettings({ ...settings, deleteOld });
    setBusy(true);
    try {
      const response = await fetch("/api/rewrap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteOld }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; settings?: RewrapCardSettings } | null;
      if (!response.ok) throw new Error(body?.error || "Could not save MKV rewrap.");
      const saved = body?.settings?.deleteOld === true;
      setSettings((current) => (current ? { ...current, deleteOld: saved } : current));
    } catch (caught) {
      setSettings((current) => (current ? { ...current, deleteOld: previous } : current));
      toast.error(caught instanceof Error ? caught.message : "Could not save MKV rewrap.");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!settings) return;
    setBusy(true);
    try {
      const response = await fetch("/api/rewrap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstLanguage: settings.firstLanguage, deleteOld: settings.deleteOld }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; settings?: RewrapCardSettings } | null;
      if (!response.ok) throw new Error(body?.error || "Could not save MKV rewrap.");
      if (body?.settings) setSettings({ firstLanguage: body.settings.firstLanguage, deleteOld: body.settings.deleteOld === true });
      toast.success("MKV rewrap settings saved on this machine.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save MKV rewrap.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAll() {
    if (!window.confirm("Delete every original AVI or transport file that already has an MKV? Subtitle files stay. This cannot be undone.")) return;
    setBusy(true);
    try {
      const response = await fetch("/api/rewrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-old" }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; removed?: number; failed?: number } | null;
      if (!response.ok) throw new Error(body?.error || "Could not delete old files.");
      const removed = body?.removed ?? 0;
      const failed = body?.failed ?? 0;
      if (removed === 0 && failed === 0) toast.success("No old files were found.");
      else if (failed > 0) toast.error(`Removed ${removed} old ${removed === 1 ? "file" : "files"}. ${failed} could not be removed.`);
      else toast.success(`Removed ${removed} old ${removed === 1 ? "file" : "files"}.`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not delete old files.");
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
          same. The original stays unless Delete old files is on. The hours are set under Schedule.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="rewrap-first-language">Audio language first</Label>
          <Input
            id="rewrap-first-language"
            value={settings.firstLanguage}
            placeholder="Leave empty to keep the file's order"
            onChange={(event) => setSettings({ ...settings, firstLanguage: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">Tracks in this language move to the front and become the default. Tracks with no known language keep their place after them.</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="rewrap-delete-old" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="rewrap-delete-old"
              checked={settings.deleteOld}
              disabled={busy}
              onCheckedChange={(value) => void saveDeleteOld(value === true)}
            />
            Delete old files
          </label>
          <p className="text-xs text-muted-foreground">After an MKV is saved, remove the AVI or transport file it replaced. Off leaves the original in place.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void deleteAll()}>
            Delete all old files
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
