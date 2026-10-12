"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatWhen } from "@/lib/format";
import type { TimingCounts, TimingPause, TimingProgress, TimingSettings } from "@/lib/subtitle-check/store";
import Link from "next/link";
import { toast } from "sonner";
import { useEffect, useState } from "react";

type Snapshot = { settings: TimingSettings; progress: TimingProgress; counts: TimingCounts };

const PAUSE_TEXT: Record<Exclude<TimingPause, null>, string> = {
  off: "Off.",
  window: "Waiting for the language detection hours.",
  plex: "Waiting while Plex is scanning or someone is playing.",
  remux: "Waiting for a remux or rewrap to finish.",
  merge: "Waiting for a version merge to finish.",
};

const OFF_FILTER = `/?rules=${encodeURIComponent(JSON.stringify([{ id: "timing", field: "timing", op: "eq", value: "off" }]))}`;

function statusText({ progress }: Snapshot): string {
  if (progress.running) {
    const counted = `Checked ${progress.done} of ${progress.total} videos.`;
    return progress.pause ? `${counted} ${PAUSE_TEXT[progress.pause]}` : counted;
  }
  if (progress.requested) return "Starting…";
  if (progress.pause === "off") return PAUSE_TEXT.off;
  return progress.finishedAt ? `Last full check ${formatWhen(progress.finishedAt)}.` : "No full check yet. The first one runs in the next language detection hours.";
}

export function SubtitleTimingSettingsCard() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const active = Boolean(snapshot && (snapshot.progress.running || snapshot.progress.requested));

  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/api/subtitle-timing", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok || !live) return;
          setSnapshot((await response.json()) as Snapshot);
        })
        .catch(() => undefined);
    const first = window.setTimeout(() => void load(), 0);
    const poll = active ? window.setInterval(() => void load(), 3_000) : undefined;
    return () => {
      live = false;
      window.clearTimeout(first);
      if (poll) window.clearInterval(poll);
    };
  }, [active]);

  if (snapshot == null) return null;
  const { settings, counts } = snapshot;

  async function send(method: "PUT" | "POST", body?: Partial<TimingSettings>, success?: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/subtitle-timing", {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = (await response.json().catch(() => null)) as (Snapshot & { error?: string }) | null;
      if (!response.ok || !payload) throw new Error(payload?.error || "Could not save subtitle timing.");
      setSnapshot(payload);
      if (success) toast.success(success);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save subtitle timing.");
    } finally {
      setBusy(false);
    }
  }

  const off = counts.longer + counts.shorter;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Subtitle timing</CardTitle>
        <CardDescription>
          Each SRT, VTT, ASS or SSA file beside a video is compared with the video’s length, one video at a time during the language detection hours. A
          subtitle that runs past the video, or stops early the way a 25 fps subtitle does on a 23.976 fps video, shows up under the{" "}
          <span className="font-medium">Subtitle timing off</span> filter. A file is only read again when it or its video changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <Label htmlFor="timing-enabled">Check subtitle timing</Label>
            <p className="text-xs text-muted-foreground">Waits while Plex is busy and while a remux, rewrap or merge runs.</p>
          </div>
          <Switch id="timing-enabled" checked={settings.enabled} disabled={busy} onCheckedChange={(value) => void send("PUT", { enabled: value }, "Subtitle timing settings saved.")} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <Label htmlFor="timing-autofix">Fix clear cases automatically</Label>
            <p className="text-xs text-muted-foreground">
              Only when the subtitle runs past the video, the video’s own frame rate is the one the fix expects, and afterwards the last line ends within 10
              seconds of the video. A subtitle that stops early is never changed on its own. The file as it was is kept as .metarr-orig.
            </p>
          </div>
          <Switch
            id="timing-autofix"
            checked={settings.autoFix}
            disabled={busy || !settings.enabled}
            onCheckedChange={(value) => void send("PUT", { autoFix: value }, "Subtitle timing settings saved.")}
          />
        </div>
        <div className="space-y-1 text-xs">
          <p>{statusText(snapshot)}</p>
          <p className="text-muted-foreground">
            {counts.checked} subtitle files checked · {off} off ({counts.longer} too long, {counts.shorter} may stop early) · {counts.retimed} retimed
            {counts.autoFixed ? `, ${counts.autoFixed} automatically` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy || !settings.enabled || active}
            onClick={() => void send("POST", undefined, "Checking every subtitle now.")}
            title="Check every subtitle now instead of waiting for the language detection hours. Still waits while Plex is busy."
          >
            {active ? "Checking…" : "Check now"}
          </Button>
          {off > 0 ? (
            <Button type="button" size="sm" variant="outline" asChild>
              <Link href={OFF_FILTER}>Show {off} in the library</Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
