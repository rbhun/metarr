"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useEffect, useState } from "react";

type RemuxSettings = {
  startHour: number;
  endHour: number;
  binary: string;
  hasKey: boolean;
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function RemuxSettingsCard() {
  const [settings, setSettings] = useState<RemuxSettings | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/remux", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { settings?: RemuxSettings };
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
      const response = await fetch("/api/remux", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startHour: settings.startHour,
          endHour: settings.endHour,
          binary: settings.binary,
          licenseKey: licenseKey.trim() || undefined,
          clearKey,
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; settings?: RemuxSettings } | null;
      if (!response.ok) throw new Error(body?.error || "Could not save disc remux.");
      if (body?.settings) setSettings(body.settings);
      setLicenseKey("");
      setClearKey(false);
      toast.success("Disc remux settings saved on this machine.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save disc remux.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Disc remux</CardTitle>
        <CardDescription>
          Queued discs run one at a time, and the next starts when the previous one finishes. The queue runs from the start hour until the end hour, and waits while Plex is scanning or playing, or while language detection is using a file. MakeMKV copies every audio and subtitle track into an MKV and leaves the disc in place. The 3D video track is left out. Install makemkvcon on this machine. Path mapping from language detection applies when a Plex path is not local.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="remux-start">Start hour</Label>
            <select
              id="remux-start"
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
            <Label htmlFor="remux-end">End hour</Label>
            <select
              id="remux-end"
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
        <div className="space-y-1.5">
          <Label htmlFor="remux-binary">makemkvcon</Label>
          <Input
            id="remux-binary"
            value={settings.binary}
            placeholder="makemkvcon"
            onChange={(event) => setSettings({ ...settings, binary: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="remux-key">MakeMKV key</Label>
          <Input
            id="remux-key"
            type="password"
            value={licenseKey}
            placeholder={settings.hasKey ? "A key is saved. Enter a new one to replace it." : "Paste the beta or registration key"}
            autoComplete="off"
            onChange={(event) => setLicenseKey(event.target.value)}
          />
          {settings.hasKey ? (
            <label htmlFor="remux-clear-key" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox id="remux-clear-key" checked={clearKey} onCheckedChange={(value) => setClearKey(value === true)} />
              Remove the saved key
            </label>
          ) : null}
        </div>
        <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}
