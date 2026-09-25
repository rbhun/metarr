"use client";

import { AudioTracks } from "@/components/audio-tracks";
import { SubtitleRows } from "@/components/subtitle-rows";
import { enqueueDetection } from "@/components/detect-actions";
import { toastDetection } from "@/components/detect-tasks";
import { DetectStatus } from "@/components/detect-status";
import { enqueueRemux } from "@/components/remux-actions";
import { RemuxStatus } from "@/components/remux-status";
import { CellScroll } from "@/components/line-scroll";
import { MediaPills } from "@/components/media-pills";
import { useShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { arrPresence, differingLength, episodeCode, formatBitrate, formatBytes, formatRating, formatRuntime, formatWhen, hdrText, playableText } from "@/lib/format";
import type { FilterRule } from "@/lib/filters";
import { displayGenres, displayRating } from "@/lib/online";
import { CONNECTOR_LABEL, type ConnectorId, type HdrLabel, type LibraryEpisode, type LibraryResponse, type LibraryTitle, type MediaVersion, type PlayableLabel, type TitleKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Search } from "lucide-react";
import { LibraryFilters } from "@/components/library-filters";
import { GenreLines, TitleDetail } from "@/components/title-detail";
import { VersionAudio, VersionLines, VersionSubtitles } from "@/components/versions";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { openService, type ServiceApp } from "@/components/open-service";
import { toast } from "sonner";

type KindFilter = "all" | TitleKind;

type SelectedRow = {
  key: string;
  label: string;
  path: string | null;
};

const COLUMNS = 8;

function titleSelection(title: LibraryTitle): SelectedRow {
  return {
    key: `title:${title.id}`,
    label: title.year ? `${title.title} (${title.year})` : title.title,
    path: title.versions.length > 1 ? title.versions.map((version) => version.path).filter(Boolean).join(" | ") : title.path,
  };
}

function episodeSelection(series: LibraryTitle, episode: LibraryEpisode): SelectedRow {
  return {
    key: `episode:${episode.id}`,
    label: `${series.title} ${episodeCode(episode.season, episode.episode)} ${episode.title}`.trim(),
    path: episode.versions.length > 1 ? episode.versions.map((version) => version.path).filter(Boolean).join(" | ") : episode.path,
  };
}

function playableClass(label: PlayableLabel): string {
  if (label === "missing") return "text-rose-700 dark:text-rose-300";
  if (label !== "video") return "text-amber-800 dark:text-amber-300";
  return "text-foreground";
}

function Presence({ yes, label, onOpen }: { yes: boolean; label: string; onOpen?: () => void }) {
  const className = yes
    ? "border-emerald-600/40 bg-emerald-500/15 text-emerald-900 dark:text-emerald-100"
    : "border-rose-600/40 bg-rose-500/10 text-rose-800 dark:text-rose-200";
  if (yes && onOpen) {
    return (
      <Badge variant="outline" asChild className={cn(className, "cursor-pointer hover:underline")}>
        <button type="button" onClick={onOpen} aria-label={`Open in ${label}`}>
          {label}
        </button>
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={className}>
      {yes ? label : `No ${label}`}
    </Badge>
  );
}

function SubtitleCell({
  tracks,
  present,
  wanted,
  path,
  label,
}: {
  tracks: LibraryTitle["subtitleTracks"];
  present: string[];
  wanted: string[];
  path: string | null;
  label: string;
}) {
  return (
    <CellScroll>
      <SubtitleRows tracks={tracks} languages={present} path={path} label={label} />
      {wanted.length ? <p className="text-xs text-amber-800 dark:text-amber-300">Bazarr missing: {wanted.join(", ")}</p> : null}
    </CellScroll>
  );
}

function Poster({ title, className }: { title: LibraryTitle; className?: string }) {
  const src = title.online?.posterUrl || (title.posterPath ? `/api/library/${title.id}/poster` : null);
  if (!src) {
    return <div className={cn("shrink-0 rounded-md bg-muted", className)} aria-hidden />;
  }
  return (
    // Posters come from TMDB or OMDb and are not known at build time.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className={cn("shrink-0 rounded-md object-cover", className)} />
  );
}

function TitleCell({ title, onOpen, action }: { title: LibraryTitle; onOpen: () => void; action?: React.ReactNode }) {
  const rating = displayRating(title.rating, title.online);
  const runtime = formatRuntime(title.runtimeMinutes ?? title.online?.runtimeMinutes);
  return (
    <div className="flex w-full min-w-0 items-start gap-3">
      <Poster title={title} className="h-16 w-11" />
      <div className="min-w-0">
        <button type="button" className="block text-left" onClick={onOpen}>
          <p className="font-medium">
            {title.title}
            {title.year ? <span className="ml-1.5 font-normal text-muted-foreground">{title.year}</span> : null}
          </p>
          {title.localTitle ? <p className="text-xs text-muted-foreground">{title.localTitle}</p> : null}
          <p className="text-xs text-muted-foreground">
            {title.kind === "movie" ? "Movie" : `${title.episodeFileCount} of ${title.episodeCount} episodes on disk`}
            {rating.value != null ? ` · ${formatRating(rating.value)}` : ""}
            {runtime !== "—" ? ` · ${runtime}` : ""}
          </p>
          {title.missingReason ? <p className="text-xs text-rose-700 dark:text-rose-300">{title.missingReason}</p> : null}
        </button>
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

function lengthText(version: MediaVersion, kind: "runtime" | "size" | null): string | null {
  if (kind === "runtime") return formatRuntime(version.durationMinutes);
  if (kind === "size") return formatBytes(version.fileBytes);
  return null;
}

function VideoSummary({
  container,
  resolution,
  is3d,
  hdr,
  qualityName,
  bitrateKbps,
  playableLabel,
  missing,
  flags,
  note,
  length,
}: {
  container: string | null;
  resolution: string | null;
  is3d: boolean;
  hdr: HdrLabel;
  qualityName: string | null;
  bitrateKbps: number | null;
  playableLabel?: PlayableLabel | null;
  missing?: string[];
  flags?: string[];
  note?: string | null;
  length?: string | null;
}) {
  return (
    <div>
      {playableLabel && playableLabel !== "video" ? (
        <p className={cn("whitespace-nowrap", playableClass(playableLabel))}>{playableText(playableLabel)}</p>
      ) : null}
      <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        <MediaPills container={container} resolution={resolution} threeD={is3d} />
        {hdr !== "none" ? <span>{hdrText(hdr)}</span> : null}
        {[qualityName, bitrateKbps ? formatBitrate(bitrateKbps) : null].filter(Boolean).join(" · ")}
      </p>
      {length ? <p className="text-[11px] text-muted-foreground">{length}</p> : null}
      {flags?.length ? (
        <p className="text-[11px] text-amber-800/80 dark:text-amber-200/80">{flags.map((flag) => (flag === "sample" ? "Sample" : "Short")).join(" · ")}</p>
      ) : null}
      {missing?.length ? <p className="text-[11px] text-amber-800/80 dark:text-amber-200/80">Missing {missing.join(", ")}</p> : null}
      {note ? <p className="text-[11px] text-amber-800/80 dark:text-amber-200/80">{note}</p> : null}
    </div>
  );
}

function VersionBands({ versions, wanted }: { versions: MediaVersion[]; wanted: string[] }) {
  const length = differingLength(versions);
  return (
    <div className="divide-y">
      {versions.map((version, index) => (
        <div key={`${version.path ?? version.name}-${index}`} className="grid grid-cols-3 gap-3 py-2 first:pt-0 last:pb-0">
          <VideoSummary
            container={version.container}
            resolution={version.resolution}
            is3d={version.is3d}
            hdr={version.hdr}
            qualityName={version.qualityName}
            bitrateKbps={version.bitrateKbps}
            playableLabel={version.playableLabel}
            missing={version.missing}
            flags={version.flags}
            length={lengthText(version, length)}
          />
          <AudioTracks tracks={version.audioTracks} languages={version.audioLanguages} path={version.path} label={version.name} />
          <div>
            <SubtitleRows tracks={version.subtitleTracks} languages={version.subtitleLanguages} path={version.path} label={version.name} />
            {index === 0 && wanted.length ? <p className="text-xs text-amber-800 dark:text-amber-300">Bazarr missing: {wanted.join(", ")}</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function episodeStatus(episode: LibraryEpisode): { label: string; className: string } | null {
  if (episode.playableLabel === "video") return null;
  if (episode.playableLabel !== "missing") return { label: playableText(episode.playableLabel), className: "text-amber-800 dark:text-amber-300" };
  if (!episode.wanted && episode.airDate && Date.parse(episode.airDate) > Date.now()) {
    return { label: "Not aired", className: "text-muted-foreground" };
  }
  return { label: "Missing file", className: "text-rose-700 dark:text-rose-300" };
}

export function LibraryView({ initial }: { initial?: LibraryResponse }) {
  const { epoch, bump, status } = useShell();
  const [kind, setKind] = useState<KindFilter>("all");
  const [rules, setRules] = useState<FilterRule[]>([]);
  const [selected, setSelected] = useState<Map<string, SelectedRow>>(() => new Map());
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<LibraryResponse | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initial);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<LibraryTitle | null>(null);
  const [detailEpisode, setDetailEpisode] = useState<LibraryEpisode | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [remuxExtras, setRemuxExtras] = useState(false);
  const [episodes, setEpisodes] = useState<Record<number, LibraryEpisode[] | "loading" | "error">>({});

  function openIn(titleId: number, app: ServiceApp, episodeId?: number) {
    void openService(titleId, app, episodeId)
      .then((message) => toast.success(message))
      .catch((caught: unknown) => toast.error(caught instanceof Error ? caught.message : "The request failed."));
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(search);
      setOffset(0);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ kind, offset: String(offset), limit: "50" });
    if (rules.length) params.set("rules", JSON.stringify(rules));
    if (debounced.trim()) params.set("q", debounced.trim());
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/library?${params.toString()}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("The library could not be loaded.");
          const body = (await response.json()) as LibraryResponse;
          setData(body);
          setError(null);
        } catch (caught) {
          if (controller.signal.aborted) return;
          setError(caught instanceof Error ? caught.message : "The library could not be loaded.");
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      })();
    }, 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [kind, rules, debounced, offset, epoch]);

  async function toggleEpisodes(title: LibraryTitle) {
    if (title.kind !== "series") return;
    if (openId === title.id) {
      setOpenId(null);
      return;
    }
    setOpenId(title.id);
    if (episodes[title.id] && episodes[title.id] !== "error") return;
    setEpisodes((current) => ({ ...current, [title.id]: "loading" }));
    try {
      const response = await fetch(`/api/library/${title.id}/episodes`, { cache: "no-store" });
      if (!response.ok) throw new Error("episodes");
      const body = (await response.json()) as { episodes: LibraryEpisode[] };
      setEpisodes((current) => ({ ...current, [title.id]: body.episodes }));
    } catch {
      setEpisodes((current) => ({ ...current, [title.id]: "error" }));
    }
  }

  async function clearLibrary() {
    if (!window.confirm("Remove every title stored in Metarr? Addresses and keys stay. Nothing is deleted on Plex or the *arr apps.")) return;
    const response = await fetch("/api/library", { method: "DELETE" });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      toast.error(body?.error || "The library could not be cleared.");
      return;
    }
    setSelected(new Map());
    setDetail(null);
    setDetailEpisode(null);
    setOffset(0);
    bump();
    toast.success("Library cleared. Server settings were kept.");
  }

  async function loadDemo() {
    const response = await fetch("/api/demo", { method: "POST" });
    if (response.ok) bump();
  }

  const titles = data?.titles ?? [];
  const detailTitle = detail ? titles.find((title) => title.id === detail.id) ?? detail : null;
  const filtered = data?.page.filtered ?? 0;
  const pageStart = filtered === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + (data?.page.limit ?? 50), filtered);
  const failedNotes = (data?.syncNotes ?? []).filter((note) => note.ok === false);
  const filtersActive = kind !== "all" || rules.length > 0 || debounced.trim().length > 0;
  const pageAllSelected = titles.length > 0 && titles.every((title) => selected.has(titleSelection(title).key));
  const pageSomeSelected = titles.some((title) => selected.has(titleSelection(title).key));

  function toggleSelected(row: SelectedRow, on: boolean) {
    setSelected((current) => {
      const next = new Map(current);
      if (on) next.set(row.key, row);
      else next.delete(row.key);
      return next;
    });
  }

  function togglePage(on: boolean) {
    setSelected((current) => {
      const next = new Map(current);
      for (const title of titles) {
        const row = titleSelection(title);
        if (on) next.set(row.key, row);
        else next.delete(row.key);
      }
      return next;
    });
  }

  async function lookup(ids: number[] | null) {
    if (ids && ids.length === 0) {
      toast.error("Select a movie or series. Episode rows are not looked up on their own.");
      return;
    }
    setLookupBusy(true);
    let pending = ids ? [...ids] : null;
    let found = 0;
    let missing = 0;
    let errors = 0;
    let limitNote: string | null = null;
    try {
      for (let step = 0; step < 40; step += 1) {
        const response = await fetch("/api/enrich", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pending ? { ids: pending } : {}),
        });
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          found?: number;
          missing?: number;
          errors?: number;
          remaining?: number;
          processedIds?: number[];
          processed?: number;
          message?: string | null;
          omdbStopped?: boolean;
        } | null;
        if (!response.ok) throw new Error(body?.error || "Lookup failed.");
        found += body?.found ?? 0;
        missing += body?.missing ?? 0;
        errors += body?.errors ?? 0;
        if (body?.message) limitNote = body.message;
        if (body?.omdbStopped) break;
        if (!body?.processed) break;
        if (pending) {
          const done = new Set(body.processedIds ?? []);
          pending = pending.filter((id) => !done.has(id));
          if (pending.length === 0) break;
        } else if (!body.remaining) {
          break;
        }
      }
      bump();
      const parts = [`${found} found`, missing ? `${missing} unmatched` : "", errors ? `${errors} failed` : ""].filter(Boolean);
      toast.success(
        `Lookup finished. ${parts.join(", ")}.${limitNote ? ` ${limitNote}` : ""} Nothing was written back to Plex or the *arr apps.`,
      );
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Lookup failed.");
    } finally {
      setLookupBusy(false);
    }
  }

  async function detectSelected(mode: "now" | "queue") {
    const titles: number[] = [];
    const episodes: number[] = [];
    for (const row of selected.values()) {
      const title = row.key.match(/^title:(\d+)$/);
      const episode = row.key.match(/^episode:(\d+)$/);
      if (title) titles.push(Number(title[1]));
      if (episode) episodes.push(Number(episode[1]));
    }
    try {
      toastDetection(await enqueueDetection(mode, titles, episodes));
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not queue language detection.");
    }
  }

  async function remuxSelected() {
    const titles: number[] = [];
    const episodeIds: number[] = [];
    for (const row of selected.values()) {
      const title = row.key.match(/^title:(\d+)$/);
      const episode = row.key.match(/^episode:(\d+)$/);
      if (title) titles.push(Number(title[1]));
      if (episode) episodeIds.push(Number(episode[1]));
    }
    try {
      toast.success(await enqueueRemux(titles, episodeIds, remuxExtras));
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not queue the disc remux.");
    }
  }

  async function copySelected() {
    const rows = [...selected.values()];
    const text = rows.map((row) => `${row.label}\t${row.path ?? "no file"}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(
        rows.length === 1
          ? "Copied 1 row. Nothing was sent to Plex or the *arr apps."
          : `Copied ${rows.length} rows. Nothing was sent to Plex or the *arr apps.`,
      );
    } catch {
      toast.error("The browser blocked clipboard access.");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Library</h1>
            <p className="text-xs text-muted-foreground">
              {data?.demo ? "Demo library — sample titles, not your servers. " : ""}
              Last sync {formatWhen(data?.lastSyncAt ?? status?.finishedAt)}
              {status?.running ? " · sync in progress" : ""}
            </p>
            <DetectStatus />
            <RemuxStatus />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{data?.stats.total ?? 0} titles</span>
              <span>{data?.stats.missing ?? 0} missing</span>
              <span>{data?.stats.notInPlex ?? 0} not in Plex</span>
              <span>{data?.stats.notPlayable ?? 0} not playable</span>
            </div>
            <Button size="sm" variant="outline" disabled={lookupBusy || (data?.stats.total ?? 0) === 0} onClick={() => void lookup(null)}>
              {lookupBusy ? "Looking up…" : "Fill missing metadata"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={(data?.stats.total ?? 0) === 0 || status?.running}
              onClick={() => void clearLibrary()}
            >
              Clear library
            </Button>
          </div>
        </div>
        {data?.demo ? (
          <p className="rounded-lg border border-amber-700/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-950 dark:text-amber-100">
            Demo library. These rows are built-in samples so you can try filters before a server answers. Saved settings are untouched.
          </p>
        ) : null}
        {failedNotes.length ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-5">
            {failedNotes.map((note) => (
              <p key={note.id}>
                <span className="font-medium capitalize">{note.id}: </span>
                {note.message}
              </p>
            ))}
          </div>
        ) : null}
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search titles"
              aria-label="Search titles"
              className="pl-8"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["all", "All"],
                ["movie", "Movies"],
                ["series", "Series"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={kind === value ? "default" : "outline"}
                onClick={() => {
                  setKind(value);
                  setOffset(0);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        <LibraryFilters
          rules={rules}
          onChange={(next) => {
            setRules(next);
            setOffset(0);
          }}
        />
        {selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
            <span className="font-medium">{selected.size} selected</span>
            <span className="text-muted-foreground">Marks rows in this browser only.</span>
            <Button size="sm" variant="outline" onClick={() => void copySelected()}>
              Copy titles and paths
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={lookupBusy}
              onClick={() => void lookup([...selected.values()].flatMap((row) => {
                const match = row.key.match(/^title:(\d+)$/);
                return match ? [Number(match[1])] : [];
              }))}
            >
              Look up selected
            </Button>
            <Button size="sm" variant="outline" onClick={() => void detectSelected("now")}>
              Detect languages now
            </Button>
            <Button size="sm" variant="outline" onClick={() => void detectSelected("queue")}>
              Queue language detection
            </Button>
            <label htmlFor="remux-extras" className="flex items-center gap-2">
              <Checkbox id="remux-extras" checked={remuxExtras} onCheckedChange={(value) => setRemuxExtras(value === true)} />
              Keep extras
            </label>
            <Button size="sm" variant="outline" onClick={() => void remuxSelected()}>
              Queue disc remux
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Map())}>
              Clear
            </Button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3 [&_[data-slot=table-container]]:overflow-visible">
        {loading && !data ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Loading the library…</p>
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="mx-auto mt-10 max-w-md rounded-xl border px-4 py-5 text-sm">
            <p className="font-medium">Library unavailable</p>
            <p className="mt-1 text-muted-foreground">{error}</p>
            <Button className="mt-4" size="sm" variant="outline" onClick={() => bump()}>
              Retry
            </Button>
          </div>
        ) : data && data.stats.total === 0 ? (
          <div className="mx-auto mt-10 max-w-lg rounded-xl border px-4 py-6">
            <p className="font-medium">Nothing synced yet</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Connect Plex or an *arr app in Settings and run a sync. Metarr stores titles, quality, languages, and what is missing.
              Sync does not copy video files. You can also load a demo library to click through the table first.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" asChild>
                <Link href="/settings">Open Settings</Link>
              </Button>
              <Button size="sm" variant="outline" onClick={() => void loadDemo()}>
                Load demo library
              </Button>
            </div>
          </div>
        ) : titles.length === 0 ? (
          <div className="mx-auto mt-10 max-w-md text-sm">
            <p className="font-medium">No titles match</p>
            <p className="mt-1 text-muted-foreground">
              {filtersActive ? "Clear a filter or try another title." : "The library is empty for this page."}
            </p>
          </div>
        ) : (
          <>
            <div className="hidden md:block">
              <Table className="table-fixed">
                <colgroup>
                  <col className="w-10" />
                  <col />
                  <col className="w-28" />
                  <col className="w-16" />
                  <col className="w-32" />
                  <col className="w-[176px]" />
                  <col className="w-[229px]" />
                  <col className="w-[232px]" />
                </colgroup>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={pageAllSelected ? true : pageSomeSelected ? "indeterminate" : false}
                        onCheckedChange={(value) => togglePage(value === true)}
                        aria-label="Select all titles on this page"
                      />
                    </TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Where</TableHead>
                    <TableHead>Rating</TableHead>
                    <TableHead>Genres</TableHead>
                    <TableHead className="w-[176px]">Video</TableHead>
                    <TableHead className="w-[229px]">Audio</TableHead>
                    <TableHead className="w-[232px]">Subtitles</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {titles.map((title) => {
                    const arr = arrPresence(title, data?.configured ?? []);
                    const open = openId === title.id;
                    const detail = episodes[title.id];
                    return (
                      <Fragment key={title.id}>
                        {(title.versions.length > 1 ? title.versions : [null]).map((version, index) => (
                        <TableRow key={`${title.id}-${version?.path ?? index}`} className="align-top">
                          {index === 0 ? (
                          <>
                          <TableCell rowSpan={title.versions.length > 1 ? title.versions.length : undefined}>
                            <Checkbox
                              checked={selected.has(titleSelection(title).key)}
                              onCheckedChange={(value) => toggleSelected(titleSelection(title), value === true)}
                              aria-label={`Select ${title.title}`}
                            />
                          </TableCell>
                          <TableCell rowSpan={title.versions.length > 1 ? title.versions.length : undefined} className="whitespace-normal">
                            <TitleCell
                              title={title}
                              onOpen={() => { setDetailEpisode(null); setDetail(title); }}
                              action={title.kind === "series" ? (
                                <Button size="lg" variant="outline" className="w-full px-2" onClick={() => void toggleEpisodes(title)}>
                                  {open ? "Hide episodes" : "Show episodes"}
                                </Button>
                              ) : null}
                            />
                          </TableCell>
                          <TableCell rowSpan={title.versions.length > 1 ? title.versions.length : undefined}>
                            <div className="flex max-w-48 flex-wrap gap-1">
                              <Presence yes={title.inPlex} label="Plex" onOpen={title.inPlex ? () => openIn(title.id, "plex") : undefined} />
                              {arr.apps.map((app) => (
                                <Presence key={app.id} yes={app.present} label={app.label} onOpen={app.present ? () => openIn(title.id, app.id) : undefined} />
                              ))}
                            </div>
                          </TableCell>
                          <TableCell rowSpan={title.versions.length > 1 ? title.versions.length : undefined}>
                            {formatRating(displayRating(title.rating, title.online).value)}
                            {title.contentRating || title.online?.contentRating ? (
                              <p className="text-[11px] text-muted-foreground">{title.contentRating || title.online?.contentRating}</p>
                            ) : null}
                            {title.rating == null && title.online?.rating != null ? (
                              <p className="text-[11px] text-muted-foreground">{displayRating(title.rating, title.online).source}</p>
                            ) : null}
                          </TableCell>
                          <TableCell rowSpan={title.versions.length > 1 ? title.versions.length : undefined} className="max-w-48 whitespace-normal">
                            <CellScroll>
                            <GenreLines genres={displayGenres(title.genres, title.online).genres} />
                            {displayGenres(title.genres, title.online).filled ? (
                              <p className="text-[11px] text-muted-foreground">Filled online</p>
                            ) : null}
                            </CellScroll>
                          </TableCell>
                          </>
                          ) : null}
                          {version ? (
                            <>
                              <TableCell className="whitespace-normal">
                                <CellScroll>
                                <VideoSummary
                                  container={version.container}
                                  resolution={version.resolution}
                                  is3d={version.is3d}
                                  hdr={version.hdr}
                                  qualityName={version.qualityName}
                                  bitrateKbps={version.bitrateKbps}
                                  playableLabel={version.playableLabel}
                                  missing={version.missing}
                                  length={lengthText(version, differingLength(title.versions))}
                                />
                                </CellScroll>
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                <CellScroll>
                                  <AudioTracks tracks={version.audioTracks} languages={version.audioLanguages} path={version.path} label={`${title.title} · ${version.name}`} scroll={false} />
                                </CellScroll>
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                <SubtitleCell tracks={version.subtitleTracks} present={version.subtitleLanguages} wanted={index === 0 ? title.subtitleWanted : []} path={version.path} label={`${title.title} · ${version.name}`} />
                              </TableCell>
                            </>
                          ) : (
                            <>
                              <TableCell className="whitespace-normal">
                                <CellScroll>
                                <VideoSummary
                                  container={title.container}
                                  resolution={title.resolution}
                                  is3d={title.is3d}
                                  hdr={title.hdr}
                                  qualityName={title.qualityName}
                                  bitrateKbps={title.bitrateKbps}
                                  playableLabel={title.playableLabel}
                                  missing={title.versions[0]?.missing}
                                  note={title.playableNote}
                                />
                                </CellScroll>
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                <CellScroll>
                                  <AudioTracks tracks={title.audioTracks} languages={title.audioLanguages} path={title.path} label={title.title} scroll={false} />
                                </CellScroll>
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                <SubtitleCell tracks={title.subtitleTracks} present={title.subtitleLanguages} wanted={title.subtitleWanted} path={title.path} label={title.title} />
                              </TableCell>
                            </>
                          )}
                        </TableRow>
                        ))}
                        {open ? (
                          <EpisodeRows
                            series={title}
                            detail={detail}
                            configured={data?.configured ?? []}
                            selected={selected}
                            onToggle={toggleSelected}
                            onOpen={(episode) => {
                              setDetail(title);
                              setDetailEpisode(episode);
                            }}
                            onOpenIn={(app, episodeId) => openIn(title.id, app, episodeId)}
                          />
                        ) : null}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="grid gap-3 md:hidden">
              {titles.map((title) => {
                const arr = arrPresence(title, data?.configured ?? []);
                const open = openId === title.id;
                return (
                  <article key={title.id} className="rounded-xl border p-3">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        className="mt-1"
                        checked={selected.has(titleSelection(title).key)}
                        onCheckedChange={(value) => toggleSelected(titleSelection(title), value === true)}
                        aria-label={`Select ${title.title}`}
                      />
                      <div className="min-w-0">
                        <TitleCell
                          title={title}
                          onOpen={() => { setDetailEpisode(null); setDetail(title); }}
                          action={title.kind === "series" ? (
                            <Button size="lg" variant="outline" onClick={() => void toggleEpisodes(title)}>
                              {open ? "Hide episodes" : "Show episodes"}
                            </Button>
                          ) : null}
                        />
                        {open ? (
                          <div className="mt-3">
                            <EpisodeList
                              series={title}
                              detail={episodes[title.id]}
                              selected={selected}
                              onToggle={toggleSelected}
                              onOpen={(episode) => {
                                setDetail(title);
                                setDetailEpisode(episode);
                              }}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">Rating</dt>
                        <dd>{formatRating(displayRating(title.rating, title.online).value)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Genres</dt>
                        <dd><GenreLines genres={displayGenres(title.genres, title.online).genres} /></dd>
                      </div>
                      {title.versions.length > 1 ? (
                        <div className="col-span-2">
                          <VersionBands versions={title.versions} wanted={title.subtitleWanted} />
                        </div>
                      ) : (
                        <>
                          <div className="col-span-2">
                            <dt className="text-muted-foreground">Video</dt>
                            <dd className="mt-1">
                              <VideoSummary
                                container={title.container}
                                resolution={title.resolution}
                                is3d={title.is3d}
                                hdr={title.hdr}
                                qualityName={title.qualityName}
                                bitrateKbps={title.bitrateKbps}
                                playableLabel={title.playableLabel}
                                missing={title.versions[0]?.missing}
                                note={title.playableNote}
                              />
                            </dd>
                          </div>
                          <div className="col-span-2">
                            <dt className="text-muted-foreground">Audio</dt>
                            <dd>
                              <AudioTracks tracks={title.audioTracks} languages={title.audioLanguages} path={title.path} label={title.title} />
                            </dd>
                          </div>
                          <div className="col-span-2">
                            <dt className="text-muted-foreground">Subtitles</dt>
                            <dd>
                              <SubtitleCell tracks={title.subtitleTracks} present={title.subtitleLanguages} wanted={title.subtitleWanted} path={title.path} label={title.title} />
                            </dd>
                          </div>
                        </>
                      )}
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-1">
                      <Presence yes={title.inPlex} label="Plex" onOpen={title.inPlex ? () => openIn(title.id, "plex") : undefined} />
                      {arr.apps.map((app) => (
                        <Presence key={app.id} yes={app.present} label={app.label} onOpen={app.present ? () => openIn(title.id, app.id) : undefined} />
                      ))}
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">{arr.summary}</p>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </div>
      {data && filtered > 0 ? (
        <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
          <p>
            {pageStart}–{pageEnd} of {filtered}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 50))}>
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={offset + 50 >= filtered} onClick={() => setOffset((value) => value + 50)}>
              Next
            </Button>
          </div>
        </div>
      ) : null}
      <TitleDetail
        title={detailTitle}
        configured={data?.configured ?? []}
        busy={lookupBusy}
        fileBrowserUrl={data?.fileBrowserUrl ?? ""}
        fileBrowserRoot={data?.fileBrowserRoot ?? ""}
        episode={detailEpisode}
        onOpenChange={(open) => {
          if (!open) {
            setDetail(null);
            setDetailEpisode(null);
          }
        }}
        onLookup={(id) => void lookup([id])}
      />
    </div>
  );
}

function EpisodeRows({
  series,
  detail,
  configured,
  selected,
  onToggle,
  onOpen,
  onOpenIn,
}: {
  series: LibraryTitle;
  detail: LibraryEpisode[] | "loading" | "error" | undefined;
  configured: ConnectorId[];
  selected: Map<string, SelectedRow>;
  onToggle: (row: SelectedRow, on: boolean) => void;
  onOpen: (episode: LibraryEpisode) => void;
  onOpenIn: (app: ServiceApp, episodeId?: number) => void;
}) {
  const [openSeasons, setOpenSeasons] = useState<Set<string>>(() => new Set());
  if (!detail || detail === "loading") {
    return (
      <TableRow>
        <TableCell colSpan={COLUMNS} className="text-xs text-muted-foreground">Loading episodes…</TableCell>
      </TableRow>
    );
  }
  if (detail === "error") {
    return (
      <TableRow>
        <TableCell colSpan={COLUMNS} className="text-xs text-rose-700 dark:text-rose-300">Episodes could not be loaded.</TableCell>
      </TableRow>
    );
  }
  if (detail.length === 0) {
    return (
      <TableRow>
        <TableCell colSpan={COLUMNS} className="text-xs text-muted-foreground">No episode metadata stored.</TableCell>
      </TableRow>
    );
  }
  const seasons = new Map<string, LibraryEpisode[]>();
  for (const episode of detail) {
    const key = episode.season == null ? "specials" : String(episode.season);
    const list = seasons.get(key) ?? [];
    list.push(episode);
    seasons.set(key, list);
  }
  return (
    <>
      {[...seasons.entries()].map(([key, seasonEpisodes]) => {
        const seasonOpen = openSeasons.has(key);
        const label = key === "specials" ? "Specials" : `Season ${key}`;
        return (
          <Fragment key={`${series.id}-season-${key}`}>
            <TableRow className="bg-muted/30">
              <TableCell />
              <TableCell colSpan={COLUMNS - 1}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between py-1 text-left text-sm font-medium"
                  onClick={() =>
                    setOpenSeasons((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                >
                  <span>{label}</span>
                  <span className="text-xs text-muted-foreground">{seasonOpen ? "Hide" : `${seasonEpisodes.length} episodes`}</span>
                </button>
              </TableCell>
            </TableRow>
            {seasonOpen
              ? seasonEpisodes.map((episode) => {
                  const versions = episode.versions.length > 1 ? episode.versions : [null];
                  const row = episodeSelection(series, episode);
                  return versions.map((version, index) => (
                    <TableRow key={`${episode.id}-${version?.path ?? index}`} className="align-top">
                      {index === 0 ? (
                        <>
                          <TableCell rowSpan={versions.length > 1 ? versions.length : undefined}>
                            <Checkbox
                              checked={selected.has(row.key)}
                              onCheckedChange={(value) => onToggle(row, value === true)}
                              aria-label={`Select ${row.label}`}
                            />
                          </TableCell>
                          <TableCell rowSpan={versions.length > 1 ? versions.length : undefined} className="whitespace-normal">
                            <button type="button" className="block text-left" onClick={() => onOpen(episode)}>
                              <p className="font-medium">
                                {episodeCode(episode.season, episode.episode)} {episode.title}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {formatRuntime(episode.runtimeMinutes)}
                                {episode.airDate ? ` · ${episode.airDate}` : ""}
                              </p>
                            </button>
                          </TableCell>
                          <TableCell rowSpan={versions.length > 1 ? versions.length : undefined}>
                            <div className="flex max-w-48 flex-wrap gap-1">
                              <Presence yes={episode.inPlex} label="Plex" onOpen={episode.inPlex ? () => onOpenIn("plex", episode.id) : undefined} />
                              {(["sonarr", "bazarr"] as const).filter((id) => configured.includes(id)).map((id) => {
                                const present = id === "sonarr" ? episode.inSonarr : episode.inBazarr;
                                return (
                                  <Presence key={id} yes={present} label={CONNECTOR_LABEL[id]} onOpen={present ? () => onOpenIn(id) : undefined} />
                                );
                              })}
                            </div>
                          </TableCell>
                          <TableCell rowSpan={versions.length > 1 ? versions.length : undefined}>—</TableCell>
                          <TableCell rowSpan={versions.length > 1 ? versions.length : undefined}>—</TableCell>
                        </>
                      ) : null}
                      {version ? (
                        <>
                          <TableCell className="whitespace-normal">
                            <CellScroll>
                              <VideoSummary
                                container={version.container}
                                resolution={version.resolution}
                                is3d={version.is3d}
                                hdr={version.hdr}
                                qualityName={version.qualityName}
                                bitrateKbps={version.bitrateKbps}
                                playableLabel={version.playableLabel}
                                missing={version.missing}
                                flags={version.flags}
                                length={lengthText(version, differingLength(episode.versions))}
                              />
                            </CellScroll>
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            <CellScroll>
                              <AudioTracks tracks={version.audioTracks} languages={version.audioLanguages} path={version.path} label={`${episodeCode(episode.season, episode.episode)} ${episode.title} · ${version.name}`} scroll={false} />
                            </CellScroll>
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            <SubtitleCell tracks={version.subtitleTracks} present={version.subtitleLanguages} wanted={index === 0 ? episode.subtitleWanted : []} path={version.path} label={`${episodeCode(episode.season, episode.episode)} ${episode.title} · ${version.name}`} />
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell className="whitespace-normal">
                            <CellScroll>
                              <VideoSummary
                                container={episode.container}
                                resolution={episode.resolution}
                                is3d={episode.is3d}
                                hdr={episode.hdr}
                                qualityName={episode.qualityName}
                                bitrateKbps={null}
                                playableLabel={episode.playableLabel}
                                missing={episode.versions[0]?.missing}
                              />
                            </CellScroll>
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            <CellScroll>
                              <AudioTracks tracks={episode.audioTracks} languages={episode.audioLanguages} path={episode.path} label={`${episodeCode(episode.season, episode.episode)} ${episode.title}`} scroll={false} />
                            </CellScroll>
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            <SubtitleCell tracks={episode.subtitleTracks} present={episode.subtitleLanguages} wanted={episode.subtitleWanted} path={episode.path} label={`${episodeCode(episode.season, episode.episode)} ${episode.title}`} />
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  ));
                })
              : null}
          </Fragment>
        );
      })}
    </>
  );
}

function EpisodeList({
  series,
  detail,
  selected,
  onToggle,
  onOpen,
}: {
  series: LibraryTitle;
  detail: LibraryEpisode[] | "loading" | "error" | undefined;
  selected: Map<string, SelectedRow>;
  onToggle: (row: SelectedRow, on: boolean) => void;
  onOpen: (episode: LibraryEpisode) => void;
}) {
  const [openSeasons, setOpenSeasons] = useState<Set<string>>(() => new Set());
  if (!detail || detail === "loading") return <p className="text-xs text-muted-foreground">Loading episodes…</p>;
  if (detail === "error") return <p className="text-xs text-rose-700 dark:text-rose-300">Episodes could not be loaded.</p>;
  if (detail.length === 0) return <p className="text-xs text-muted-foreground">No episode metadata stored.</p>;
  const seasons = new Map<string, LibraryEpisode[]>();
  for (const episode of detail) {
    const key = episode.season == null ? "specials" : String(episode.season);
    const list = seasons.get(key) ?? [];
    list.push(episode);
    seasons.set(key, list);
  }
  return (
    <div className="grid gap-2">
      {[...seasons.entries()].map(([key, episodes]) => {
        const open = openSeasons.has(key);
        const label = key === "specials" ? "Specials" : `Season ${key}`;
        return (
          <section key={key}>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md px-1 py-1 text-left text-xs font-medium hover:bg-muted"
              onClick={() =>
                setOpenSeasons((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            >
              <span>{label}</span>
              <span className="text-muted-foreground">{open ? "Hide" : `${episodes.length} episodes`}</span>
            </button>
            {open ? (
              <div className="grid max-h-36 gap-2 overflow-y-auto overscroll-contain pt-1 [scrollbar-width:thin]">
                {episodes.map((episode) => {
                  const status = episodeStatus(episode);
                  const row = episodeSelection(series, episode);
                  return (
                    <div key={episode.id} className="grid gap-1 border-b border-border/60 pb-2 text-xs last:border-0 md:grid-cols-[1.25rem_1fr_8rem] md:items-start">
                      <Checkbox
                        checked={selected.has(row.key)}
                        onCheckedChange={(value) => onToggle(row, value === true)}
                        aria-label={`Select ${row.label}`}
                      />
                      <button type="button" className="text-left" onClick={() => onOpen(episode)}>
                        <p className="font-medium">
                          {episodeCode(episode.season, episode.episode)} {episode.title}
                        </p>
                        {episode.versions.length > 1 ? (
                          <div className="mt-1">
                            <VersionLines versions={episode.versions} />
                          </div>
                        ) : (
                          <p className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
                            <MediaPills container={episode.container} resolution={episode.resolution} frameRate={episode.detail?.frameRate} />
                            {episode.qualityName}
                            {episode.versions[0]?.missing.length ? <span className="text-amber-800 dark:text-amber-200">Missing {episode.versions[0].missing.join(", ")}</span> : null}
                          </p>
                        )}
                      </button>
                      <div className="text-muted-foreground">
                        {status ? <p className={status.className}>{status.label}</p> : null}
                        {episode.versions.length > 1 ? (
                          <>
                            <VersionAudio versions={episode.versions} />
                            <VersionSubtitles versions={episode.versions} />
                          </>
                        ) : (
                          <>
                            <AudioTracks tracks={episode.audioTracks} languages={episode.audioLanguages} path={episode.path} label={`${episodeCode(episode.season, episode.episode)} ${episode.title}`} />
                            <SubtitleRows tracks={episode.subtitleTracks} languages={episode.subtitleLanguages} path={episode.path} label={`${episodeCode(episode.season, episode.episode)} ${episode.title}`} />
                          </>
                        )}
                        {episode.subtitleWanted.length ? <p>Bazarr missing: {episode.subtitleWanted.join(", ")}</p> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
