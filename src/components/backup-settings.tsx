"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { defaultBackupNames, type BackupGroup, type BackupTable } from "@/lib/backup-tables";
import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";

const GROUP_LABEL: Record<BackupGroup, string> = {
  settings: "Settings",
  tasks: "Tasks",
  library: "Library",
  other: "Other",
};

const GROUPS: BackupGroup[] = ["settings", "tasks", "library", "other"];

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `Request failed (${response.status}).`;
}

export function BackupSettingsCard() {
  const [tables, setTables] = useState<BackupTable[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<"download" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let gone = false;
    void (async () => {
      const response = await fetch("/api/backup", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { error?: string; tables?: BackupTable[] } | null;
      if (gone) return;
      if (!response.ok || !body?.tables) {
        setError(body?.error || "The table list could not be loaded.");
        return;
      }
      setTables(body.tables);
      setSelected(defaultBackupNames(body.tables));
      setReady(true);
    })();
    return () => {
      gone = true;
    };
  }, []);

  const all = tables.length > 0 && selected.length === tables.length;
  const some = selected.length > 0 && !all;

  function toggleAll(checked: boolean) {
    setSelected(checked ? tables.map((table) => table.name) : []);
  }

  function toggle(name: string, checked: boolean) {
    setSelected((current) => (checked ? [...current, name] : current.filter((item) => item !== name)));
  }

  async function download() {
    setBusy("download");
    setError(null);
    try {
      const response = await fetch("/api/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tables: selected }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const match = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = match?.[1] || "metarr-backup.db";
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The backup could not be written.";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }

  async function restore(file: File) {
    const confirmed = window.confirm(
      `Restore tables from ${file.name}? Tables in the file are replaced. Tables that are not in the file stay.`,
    );
    if (!confirmed) return;
    setBusy("restore");
    setError(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const response = await fetch("/api/backup/restore", { method: "POST", body });
      const result = (await response.json().catch(() => null)) as { error?: string; restored?: string[] } | null;
      if (!response.ok) throw new Error(result?.error || `Request failed (${response.status}).`);
      const count = result?.restored?.length ?? 0;
      toast.success(count === 1 ? "Restored 1 table." : `Restored ${count} tables.`);
      window.setTimeout(() => window.location.reload(), 400);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The backup could not be restored.";
      setError(message);
      toast.error(message);
      setBusy(null);
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Backup</CardTitle>
        <CardDescription>
          Settings and task history are checked. All tables also includes the library list, which a sync builds again. Download saves the checked tables. Restore replaces each table in the file you upload and leaves the others.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={all ? true : some ? "indeterminate" : false}
            disabled={!ready || busy !== null}
            onCheckedChange={(checked) => toggleAll(checked === true)}
          />
          All tables
        </label>
        {GROUPS.map((group) => {
          const items = tables.filter((table) => table.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{GROUP_LABEL[group]}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {items.map((table) => (
                  <label key={table.name} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={selected.includes(table.name)}
                      disabled={busy !== null}
                      onCheckedChange={(checked) => toggle(table.name, checked === true)}
                    />
                    {table.label}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        {error ? <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void download()} disabled={!ready || selected.length === 0 || busy !== null}>
            {busy === "download" ? "Preparing…" : "Download"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => input.current?.click()} disabled={!ready || busy !== null}>
            {busy === "restore" ? "Restoring…" : "Restore"}
          </Button>
          <input
            ref={input}
            type="file"
            accept=".db,.sqlite,application/octet-stream"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void restore(file);
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
