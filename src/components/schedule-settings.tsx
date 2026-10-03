"use client";

import { useShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatWhen } from "@/lib/format";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useState } from "react";

type Hours = { enabled: boolean; startHour: number; endHour: number };

type Clock = { timeZone: string; now: string; setting: string | null };

function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return all.includes(current) || !current ? all : [current, ...all];
}

type SyncSchedule = { enabled: boolean; intervalHours: number };

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const INTERVALS = [
  { hours: 1, label: "Every hour" },
  { hours: 3, label: "Every 3 hours" },
  { hours: 6, label: "Every 6 hours" },
  { hours: 12, label: "Every 12 hours" },
  { hours: 24, label: "Every day" },
];

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function HourSelect({ id, value, onChange }: { id: string; value: number; onChange: (hour: number) => void }) {
  return (
    <select
      id={id}
      value={value}
      className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {HOURS.map((hour) => (
        <option key={hour} value={hour}>
          {hourLabel(hour)}
        </option>
      ))}
    </select>
  );
}

export function ScheduleSettings() {
  const { startSync, status } = useShell();
  const [sync, setSync] = useState<SyncSchedule | null>(null);
  const [detect, setDetect] = useState<Hours | null>(null);
  const [remux, setRemux] = useState<Hours | null>(null);
  const [rewrap, setRewrap] = useState<Hours | null>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState<Clock | null>(null);
  const [zone, setZone] = useState("");
  const [skipPlex, setSkipPlex] = useState<boolean | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void Promise.all([
        fetch("/api/clock", { cache: "no-store" }).then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as Clock;
          setClock(body);
          setZone(body.setting ?? body.timeZone);
        }),
        fetch("/api/sync", { cache: "no-store" }).then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { schedule?: SyncSchedule };
          if (body.schedule) setSync(body.schedule);
        }),
        fetch("/api/detect", { cache: "no-store" }).then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { settings?: Hours };
          if (body.settings) setDetect({ enabled: body.settings.enabled, startHour: body.settings.startHour, endHour: body.settings.endHour });
        }),
        fetch("/api/remux", { cache: "no-store" }).then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { settings?: Hours };
          if (body.settings) setRemux({ enabled: body.settings.enabled, startHour: body.settings.startHour, endHour: body.settings.endHour });
        }),
        fetch("/api/rewrap", { cache: "no-store" }).then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { settings?: Hours };
          if (body.settings) setRewrap({ enabled: body.settings.enabled, startHour: body.settings.startHour, endHour: body.settings.endHour });
        }),
        fetch("/api/preferences", { cache: "no-store" })
          .then(async (response) => {
            if (!response.ok) {
              setSkipPlex(false);
              return;
            }
            const body = (await response.json()) as { skipPlexWait?: boolean };
            setSkipPlex(body.skipPlexWait === true);
          })
          .catch(() => setSkipPlex(false)),
      ]).catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (!sync || !detect || !remux || !rewrap || skipPlex == null) return null;

  async function saveSkipPlex(value: boolean) {
    const previous = skipPlex;
    setSkipPlex(value);
    setBusy(true);
    try {
      const response = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipPlexWait: value }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Could not save the Plex wait.");
      }
      toast.success(value ? "Queues will not wait for Plex." : "Queues will wait while Plex is busy.");
    } catch (caught) {
      setSkipPlex(previous);
      toast.error(caught instanceof Error ? caught.message : "Could not save the Plex wait.");
    } finally {
      setBusy(false);
    }
  }

  async function saveOne(request: Promise<Response>, saved: string) {
    setBusy(true);
    try {
      const response = await request;
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || "Could not save the schedule.");
      }
      toast.success(saved);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save the schedule.");
    } finally {
      setBusy(false);
    }
  }

  async function saveZone(value: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/clock", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeZone: value }),
      });
      const body = (await response.json().catch(() => null)) as (Clock & { error?: string }) | null;
      if (!response.ok || !body) throw new Error(body?.error || "Could not save the time zone.");
      setClock(body);
      setZone(body.setting ?? body.timeZone);
      toast.success(`Schedules now use ${body.timeZone}.`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save the time zone.");
    } finally {
      setBusy(false);
    }
  }

  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {clock ? (
        <Card size="sm" className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Clock</CardTitle>
            <CardDescription>
              Every schedule below uses the server clock: {clock.timeZone}, now {clock.now}.
              {clock.timeZone !== browserZone ? ` This browser is on ${browserZone}.` : null}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1 space-y-1.5">
              <Label htmlFor="time-zone">Time zone</Label>
              <select
                id="time-zone"
                value={zone}
                className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                onChange={(event) => setZone(event.target.value)}
              >
                {timeZones(zone).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="button" size="sm" disabled={busy} onClick={() => void saveZone(zone)}>
              Save time zone
            </Button>
            {clock.timeZone !== browserZone ? (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void saveZone(browserZone)}>
                Use {browserZone}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Library resync</CardTitle>
          <CardDescription>
            Pulls metadata again after the interval. Sync now reads Plex, Radarr, Sonarr, and Bazarr immediately. A connector that fails keeps its last successful copy. Video files stay where they are.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <Label htmlFor="sync-enabled">Resync the library</Label>
            <Switch id="sync-enabled" checked={sync.enabled} onCheckedChange={(value) => setSync({ ...sync, enabled: value === true })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sync-interval">Interval</Label>
            <select
              id="sync-interval"
              value={sync.intervalHours}
              className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              onChange={(event) => setSync({ ...sync, intervalHours: Number(event.target.value) })}
            >
              {INTERVALS.map((interval) => (
                <option key={interval.hours} value={interval.hours}>
                  {interval.label}
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-muted-foreground">Last sync {formatWhen(status?.finishedAt)}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                void saveOne(
                  fetch("/api/sync", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(sync),
                  }),
                  "Library resync saved on this machine.",
                )
              }
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void startSync()}
              aria-label={status?.running ? "Show sync progress" : "Sync now"}
            >
              <RefreshCw className={status?.running ? "animate-spin" : undefined} />
              {status?.running ? "Syncing" : "Sync now"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Plex</CardTitle>
          <CardDescription>
            Language checks, disc remux, and rewrap wait while Plex is scanning or someone is playing. A job started with Detect now, Convert, or Rewrap now already starts right away.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <Label htmlFor="skip-plex-wait">Do not wait for Plex</Label>
            <Switch id="skip-plex-wait" checked={skipPlex} disabled={busy} onCheckedChange={(value) => void saveSkipPlex(value === true)} />
          </div>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Scan unknown tracks</CardTitle>
          <CardDescription>
            Queued tracks and the daily pass run from the start hour until the end hour, and wait while Plex is busy.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <Label htmlFor="schedule-detect">Scan unknown tracks</Label>
            <Switch
              id="schedule-detect"
              checked={detect.enabled}
              onCheckedChange={(value) => setDetect({ ...detect, enabled: value === true })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-detect-start">Start hour</Label>
              <HourSelect id="schedule-detect-start" value={detect.startHour} onChange={(startHour) => setDetect({ ...detect, startHour })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schedule-detect-end">End hour</Label>
              <HourSelect id="schedule-detect-end" value={detect.endHour} onChange={(endHour) => setDetect({ ...detect, endHour })} />
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() =>
              void saveOne(
                fetch("/api/detect", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(detect),
                }),
                "Language detection hours saved on this machine.",
              )
            }
          >
            Save
          </Button>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Run queued discs</CardTitle>
          <CardDescription>
            The queue runs from the start hour until the end hour, and waits while Plex is playing or language detection is using a file.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <Label htmlFor="schedule-remux">Run queued discs</Label>
            <Switch id="schedule-remux" checked={remux.enabled} onCheckedChange={(value) => setRemux({ ...remux, enabled: value === true })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-remux-start">Start hour</Label>
              <HourSelect id="schedule-remux-start" value={remux.startHour} onChange={(startHour) => setRemux({ ...remux, startHour })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schedule-remux-end">End hour</Label>
              <HourSelect id="schedule-remux-end" value={remux.endHour} onChange={(endHour) => setRemux({ ...remux, endHour })} />
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() =>
              void saveOne(
                fetch("/api/remux", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(remux),
                }),
                "Disc remux hours saved on this machine.",
              )
            }
          >
            Save
          </Button>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Run queued MKV rewraps</CardTitle>
          <CardDescription>
            A separate queue from the discs. It runs from the start hour until the end hour, and waits while a disc remux runs, Plex is playing, or
            language detection is using a file. Rewrap now in Rips or the library starts one right away.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <Label htmlFor="schedule-rewrap">Run queued MKV rewraps</Label>
            <Switch id="schedule-rewrap" checked={rewrap.enabled} onCheckedChange={(value) => setRewrap({ ...rewrap, enabled: value === true })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-rewrap-start">Start hour</Label>
              <HourSelect id="schedule-rewrap-start" value={rewrap.startHour} onChange={(startHour) => setRewrap({ ...rewrap, startHour })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schedule-rewrap-end">End hour</Label>
              <HourSelect id="schedule-rewrap-end" value={rewrap.endHour} onChange={(endHour) => setRewrap({ ...rewrap, endHour })} />
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() =>
              void saveOne(
                fetch("/api/rewrap", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(rewrap),
                }),
                "MKV rewrap hours saved on this machine.",
              )
            }
          >
            Save
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
