"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { SubtitleTimingRow } from "@/lib/subtitle-fix";
import { formatClock, isIdentity, parseClock, TIMING_PRESETS, timingMapProblem, twoPointMap, type TimingMap } from "@/lib/subtitle-timing";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const selectClass = "h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30";

const statusClass: Record<SubtitleTimingRow["status"], string> = {
  fits: "text-muted-foreground",
  unknown: "text-muted-foreground",
  longer: "text-amber-800 dark:text-amber-200",
  shorter: "text-amber-800 dark:text-amber-200",
};

async function post<T>(catalogId: number, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/library/${catalogId}/subtitle-timing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "The subtitle timing request failed.");
  return payload;
}

function changeText(map: TimingMap | null): string {
  if (!map) return "Enter two times at least a second apart.";
  if (isIdentity(map)) return "No change yet.";
  const parts: string[] = [];
  if (Math.abs(map.scale - 1) >= 1e-6) parts.push(`${map.scale > 1 ? "Stretch" : "Shrink"} ${(Math.abs(map.scale - 1) * 100).toFixed(2)}%`);
  if (Math.abs(map.offset) >= 0.0005) parts.push(`shift ${map.offset > 0 ? "+" : "−"}${Math.abs(map.offset).toFixed(3)} s`);
  return parts.join(", ");
}

function TimingRow({ row, catalogId, episodeId, onChanged }: { row: SubtitleTimingRow; catalogId: number; episodeId: number | null; onChanged: () => void }) {
  const first = row.firstStart ?? 0;
  const last = row.lastEnd ?? 0;
  const [presetId, setPresetId] = useState(row.preset ?? "");
  const [firstAt, setFirstAt] = useState(() => formatClock(first * (TIMING_PRESETS.find((item) => item.id === row.preset)?.scale ?? 1)));
  const [lastAt, setLastAt] = useState(() => formatClock(last * (TIMING_PRESETS.find((item) => item.id === row.preset)?.scale ?? 1)));
  const [busy, setBusy] = useState<"fix" | "restore" | null>(null);
  const timed = row.firstStart != null && row.lastEnd != null;
  const firstValue = parseClock(firstAt);
  const lastValue = parseClock(lastAt);
  const map = timed && firstValue != null && lastValue != null ? twoPointMap(first, firstValue, last, lastValue) : null;
  const problem = map ? timingMapProblem(map) : null;

  function choosePreset(id: string) {
    setPresetId(id);
    const scale = TIMING_PRESETS.find((item) => item.id === id)?.scale ?? 1;
    setFirstAt(formatClock(first * scale));
    setLastAt(formatClock(last * scale));
  }

  async function run(action: "fix" | "restore") {
    if (action === "fix" && !map) return;
    if (action === "restore" && !window.confirm(`Put back the original timing of ${row.name}?`)) return;
    setBusy(action);
    try {
      const result = await post<{ message: string }>(catalogId, { action, episodeId, file: row.file, ...(action === "fix" && map ? map : {}) });
      toast.success(result.message);
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "The subtitle timing could not be changed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div>
        <p className="font-medium break-all">{row.name}</p>
        <p className="text-xs text-muted-foreground">
          Video {row.videoSeconds != null ? formatClock(row.videoSeconds) : "length unknown"}
          {row.fps ? ` · ${row.fps.toFixed(3)} fps` : ""}
          {row.videoSource === "runtime" ? " (stored runtime)" : ""}
          {timed ? ` · Subtitle ${formatClock(first)} to ${formatClock(last)} · ${row.cues} lines` : ""}
        </p>
        <p className={`text-xs ${statusClass[row.status]}`}>{row.message}</p>
      </div>
      {timed ? (
        <>
          <select className={selectClass} aria-label="Frame rate change" value={presetId} onChange={(event) => choosePreset(event.target.value)}>
            <option value="">Set the first and last line by hand</option>
            {TIMING_PRESETS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-[1fr_8.5rem] items-center gap-x-2 gap-y-1 text-xs">
            <span className="truncate" title={row.firstText}>
              First line at {formatClock(first)}: <span className="text-muted-foreground">{row.firstText || "—"}</span>
            </span>
            <Input aria-label="First line new time" value={firstAt} onChange={(event) => { setPresetId(""); setFirstAt(event.target.value); }} className="h-7 font-mono text-xs" />
            <span className="truncate" title={row.lastText}>
              Last line ends {formatClock(last)}: <span className="text-muted-foreground">{row.lastText || "—"}</span>
            </span>
            <Input aria-label="Last line new time" value={lastAt} onChange={(event) => { setPresetId(""); setLastAt(event.target.value); }} className="h-7 font-mono text-xs" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={`text-xs ${problem ? "text-destructive" : "text-muted-foreground"}`}>{problem ?? changeText(map)}</span>
            <div className="flex gap-2">
              {row.hasOriginal ? (
                <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void run("restore")} title="Put back the file as it was before Metarr first changed it">
                  {busy === "restore" ? "Restoring…" : "Restore original"}
                </Button>
              ) : null}
              <Button size="sm" disabled={busy != null || !map || isIdentity(map) || problem != null} onClick={() => void run("fix")}>
                {busy === "fix" ? "Saving…" : "Apply"}
              </Button>
            </div>
          </div>
        </>
      ) : row.hasOriginal ? (
        <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void run("restore")}>
          {busy === "restore" ? "Restoring…" : "Restore original"}
        </Button>
      ) : null}
    </div>
  );
}

export function SubtitleTimingDialog({
  catalogId,
  episodeId,
  open,
  onOpenChange,
}: {
  catalogId: number;
  episodeId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [rows, setRows] = useState<SubtitleTimingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    post<{ rows: SubtitleTimingRow[] }>(catalogId, { action: "inspect", episodeId })
      .then((result) => {
        if (!live) return;
        setError(null);
        setRows(result.rows);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof Error ? caught.message : "The subtitles could not be read.");
      });
    return () => {
      live = false;
    };
  }, [open, catalogId, episodeId, round]);

  const videos = new Set(rows?.map((row) => row.videoName));
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setRows(null);
          setError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Subtitle timing</DialogTitle>
          <DialogDescription>
            Each SRT, VTT, ASS or SSA file beside the video is compared with the video’s length. A subtitle made for a 25 fps copy drifts about 4% against a 23.976 fps video. Pick the frame rate change, or type where the first and last line should be. The file as it was is kept beside it as .metarr-orig.
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-destructive">{error}</p> : null}
        {!rows && !error ? <p className="text-muted-foreground">Reading the subtitles and the video length…</p> : null}
        {rows && rows.length === 0 ? <p className="text-muted-foreground">No SRT, VTT, ASS or SSA file was found beside this video.</p> : null}
        {rows?.map((row) => (
          <div key={`${row.file}-${row.firstStart}-${row.lastEnd}-${row.hasOriginal}`} className="space-y-1">
            {videos.size > 1 ? <p className="text-xs break-all text-muted-foreground">For {row.videoName}</p> : null}
            <TimingRow row={row} catalogId={catalogId} episodeId={episodeId} onChanged={() => setRound((value) => value + 1)} />
          </div>
        ))}
      </DialogContent>
    </Dialog>
  );
}
