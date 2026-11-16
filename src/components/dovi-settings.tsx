"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { useEffect, useState } from "react";

type DoviCardSettings = {
  doviWatch: boolean;
  doviDeleteOld: boolean;
};

export function DoviSettingsCard() {
  const [settings, setSettings] = useState<DoviCardSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/rewrap", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { settings?: DoviCardSettings };
          if (body.settings) setSettings({ doviWatch: body.settings.doviWatch === true, doviDeleteOld: body.settings.doviDeleteOld === true });
        })
        .catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (!settings) return null;

  async function save(patch: Partial<DoviCardSettings>) {
    if (!settings) return;
    const previous = settings;
    const next = { ...settings, ...patch };
    setSettings(next);
    setBusy(true);
    try {
      const response = await fetch("/api/rewrap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; settings?: DoviCardSettings } | null;
      if (!response.ok) throw new Error(body?.error || "Could not save Dolby Vision.");
      if (body?.settings) setSettings({ doviWatch: body.settings.doviWatch === true, doviDeleteOld: body.settings.doviDeleteOld === true });
    } catch (caught) {
      setSettings(previous);
      toast.error(caught instanceof Error ? caught.message : "Could not save Dolby Vision.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteLeftovers() {
    if (!window.confirm("Delete every .DV7 file that already has its Dolby Vision 8 movie beside it? This cannot be undone.")) return;
    setBusy(true);
    try {
      const response = await fetch("/api/rewrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-dovi-old" }),
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
        <CardTitle>Dolby Vision</CardTitle>
        <CardDescription>
          A Dolby Vision 7 file is copied to 8.1 without re-encoding the picture, so an Apple TV can play it. The new file takes the original&apos;s name.
          The original stays as .DV7 unless Delete old files is on. The hours are set under Schedule.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="space-y-1.5">
          <label htmlFor="dovi-watch" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="dovi-watch"
              checked={settings.doviWatch}
              disabled={busy}
              onCheckedChange={(value) => void save({ doviWatch: value === true })}
            />
            Watch and convert
          </label>
          <p className="text-xs text-muted-foreground">
            Dolby Vision 7 files already in the library, and ones that show up later, are converted to 8.1. They run in the rewrap hours.
          </p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="dovi-delete-old" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="dovi-delete-old"
              checked={settings.doviDeleteOld}
              disabled={busy}
              onCheckedChange={(value) => void save({ doviDeleteOld: value === true })}
            />
            Delete old files
          </label>
          <p className="text-xs text-muted-foreground">After the 8.1 file takes the movie&apos;s name, remove the .DV7 original. Off leaves that file beside it.</p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void deleteLeftovers()}>
          Delete leftover old files
        </Button>
      </CardContent>
    </Card>
  );
}
