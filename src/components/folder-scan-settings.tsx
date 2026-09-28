"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useEffect, useState } from "react";

type FolderScanSettings = {
  enabled: boolean;
  roots: string[];
};

type PlexFolder = { path: string; library: string };

export function FolderScanCard() {
  const [settings, setSettings] = useState<FolderScanSettings | null>(null);
  const [roots, setRoots] = useState("");
  const [plexFolders, setPlexFolders] = useState<PlexFolder[]>([]);
  const [filledFromPlex, setFilledFromPlex] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch("/api/folder-scan", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { settings?: FolderScanSettings; plexFolders?: PlexFolder[] };
          if (!body.settings) return;
          const suggested = body.plexFolders ?? [];
          setSettings(body.settings);
          setPlexFolders(suggested);
          if (body.settings.roots.length) {
            setRoots(body.settings.roots.join("\n"));
            setFilledFromPlex(false);
          } else if (suggested.length) {
            setRoots(suggested.map((folder) => folder.path).join("\n"));
            setFilledFromPlex(true);
          }
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
      const response = await fetch("/api/folder-scan", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: settings.enabled, roots: roots.split(/\r?\n/) }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; settings?: FolderScanSettings } | null;
      if (!response.ok) throw new Error(body?.error || "Could not save folder scan.");
      if (body?.settings) {
        setSettings(body.settings);
        setRoots(body.settings.roots.join("\n"));
        setFilledFromPlex(false);
      }
      toast.success(settings.enabled ? "Folder scan is on. The next sync reads those folders." : "Folder scan is off.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not save folder scan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Folder scan</CardTitle>
        <CardDescription>
          Reads the language tags stored in each video file and compares them with Plex, Radarr, and Sonarr. A mismatch stays visible on the track. Off until you enable it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
          <Label htmlFor="folder-scan-enabled">Include in sync</Label>
          <Switch
            id="folder-scan-enabled"
            checked={settings.enabled}
            onCheckedChange={(checked) => setSettings({ ...settings, enabled: checked })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="folder-scan-roots">Folders</Label>
          <textarea
            id="folder-scan-roots"
            value={roots}
            placeholder={"/mnt/media/Movies\n/mnt/media/TV"}
            aria-label="Folders to scan"
            rows={4}
            onChange={(event) => setRoots(event.target.value)}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <p className="text-xs leading-5 text-muted-foreground">
            {filledFromPlex
              ? `Filled from Plex: ${[...new Set(plexFolders.map((folder) => folder.library))].join(", ")}. Save to keep them.`
              : "One full path per line. The scan uses the paths this machine can open."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void save()} disabled={busy} className="self-start">
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || plexFolders.length === 0}
            onClick={() => {
              setRoots(plexFolders.map((folder) => folder.path).join("\n"));
              setFilledFromPlex(true);
            }}
          >
            Use Plex folders
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
