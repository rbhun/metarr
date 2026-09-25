"use client";

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
import { arrPresence, episodeCode, formatList, formatRating, formatRuntime, formatWhen, hdrText, playableText } from "@/lib/format";
import { displayGenres, displayRating } from "@/lib/online";
import type { LibraryEpisode, LibraryResponse, LibraryTitle, PlayableLabel, TitleKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Search } from "lucide-react";
import { TitleDetail } from "@/components/title-detail";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";

type KindFilter = "all" | TitleKind;

type SelectedRow = {
  key: string;
  label: string;
  path: string | null;
};

const COLUMNS = 9;

function titleSelection(title: LibraryTitle): SelectedRow {
  return {
    key: `title:${title.id}`,
    label: title.year ? `${title.title} (${title.year})` : title.title,
    path: title.path,
  };
}

function episodeSelection(series: LibraryTitle, episode: LibraryEpisode): SelectedRow {
  return {
    key: `episode:${episode.id}`,
    label: `${series.title} ${episodeCode(episode.season, episode.episode)} ${episode.title}`.trim(),
    path: episode.path,
  };
}

function playableClass(label: PlayableLabel): string {
  if (label === "disc") return "text-amber-300";
  if (label === "missing") return "text-rose-300";
  return "text-foreground";
}

function Presence({ yes, label }: { yes: boolean; label: string }) {
  return (
    <Badge
      variant="outline"
      className={
        yes
          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-100"
          : "border-rose-500/40 bg-rose-500/10 text-rose-200"
      }
    >
      {yes ? label : `No ${label}`}
    </Badge>
  );
}

function SubtitleCell({ present, wanted }: { present: string[]; wanted: string[] }) {
  return (
    <div className="min-w-36">
      <p>{formatList(present)}</p>
      {wanted.length ? <p className="text-xs text-amber-300">Bazarr missing: {wanted.join(", ")}</p> : null}
    </div>
  );
}

function Poster({ title, className }: { title: LibraryTitle; className?: string }) {
  const src = title.online?.posterUrl;
  if (!src) {
    return <div className={cn("shrink-0 rounded-md bg-muted", className)} aria-hidden />;
  }
  return (
    // Posters come from TMDB or OMDb and are not known at build time.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className={cn("shrink-0 rounded-md object-cover", className)} />
  );
}

function TitleCell({ title }: { title: LibraryTitle }) {
  const rating = displayRating(title.rating, title.online);
  return (
    <div className="flex min-w-56 gap-3">
      <Poster title={title} className="h-16 w-11" />
      <div>
        <p className="font-medium">
          {title.title}
          {title.year ? <span className="ml-1.5 font-normal text-muted-foreground">{title.year}</span> : null}
        </p>
        <p className="text-xs text-muted-foreground">
          {title.kind === "movie" ? "Movie" : `${title.episodeFileCount} of ${title.episodeCount} episodes on disk`}
          {rating.value != null ? ` · ${formatRating(rating.value)}` : ""}
          {title.online?.runtimeMinutes ? ` · ${formatRuntime(title.online.runtimeMinutes)}` : ""}
        </p>
        {title.missingReason ? <p className="text-xs text-rose-300">{title.missingReason}</p> : null}
      </div>
    </div>
  );
}

function episodeStatus(episode: LibraryEpisode): { label: string; className: string } {
  if (episode.playableLabel === "video") return { label: "Video file", className: "text-foreground" };
  if (episode.playableLabel === "disc") return { label: "Disc image", className: "text-amber-300" };
  if (!episode.wanted && episode.airDate && Date.parse(episode.airDate) > Date.now()) {
    return { label: "Not aired", className: "text-muted-foreground" };
  }
  return { label: "Missing file", className: "text-rose-300" };
}

export function LibraryView({ initial }: { initial?: LibraryResponse }) {
  const { epoch, bump, status } = useShell();
  const [kind, setKind] = useState<KindFilter>("all");
  const [missing, setMissing] = useState(false);
  const [notInPlex, setNotInPlex] = useState(false);
  const [notPlayable, setNotPlayable] = useState(false);
  const [missingEnglish, setMissingEnglish] = useState(false);
  const [only3d, setOnly3d] = useState(false);
  const [hungarian, setHungarian] = useState(false);
  const [selected, setSelected] = useState<Map<string, SelectedRow>>(() => new Map());
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<LibraryResponse | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initial);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<LibraryTitle | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [episodes, setEpisodes] = useState<Record<number, LibraryEpisode[] | "loading" | "error">>({});

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
    if (missing) params.set("missing", "1");
    if (notInPlex) params.set("notInPlex", "1");
    if (notPlayable) params.set("notPlayable", "1");
    if (missingEnglish) params.set("missingEnglish", "1");
    if (only3d) params.set("only3d", "1");
    if (hungarian) params.set("hungarian", "1");
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
  }, [kind, missing, notInPlex, notPlayable, missingEnglish, only3d, hungarian, debounced, offset, epoch]);

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
  const filtersActive =
    kind !== "all" || missing || notInPlex || notPlayable || missingEnglish || only3d || hungarian || debounced.trim().length > 0;
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
        } | null;
        if (!response.ok) throw new Error(body?.error || "Lookup failed.");
        found += body?.found ?? 0;
        missing += body?.missing ?? 0;
        errors += body?.errors ?? 0;
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
      toast.success(`Lookup finished. ${parts.join(", ")}. Nothing was written back to Plex or the *arr apps.`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Lookup failed.");
    } finally {
      setLookupBusy(false);
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
          </div>
        </div>
        {data?.demo ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100">
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
            <Button
              size="sm"
              variant={missing ? "default" : "outline"}
              aria-pressed={missing}
              onClick={() => {
                setMissing((value) => !value);
                setOffset(0);
              }}
            >
              Missing
            </Button>
            <Button
              size="sm"
              variant={notInPlex ? "default" : "outline"}
              aria-pressed={notInPlex}
              onClick={() => {
                setNotInPlex((value) => !value);
                setOffset(0);
              }}
            >
              Not in Plex
            </Button>
            <Button
              size="sm"
              variant={notPlayable ? "default" : "outline"}
              aria-pressed={notPlayable}
              onClick={() => {
                setNotPlayable((value) => !value);
                setOffset(0);
              }}
            >
              Disc / not playable
            </Button>
            <Button
              size="sm"
              variant={missingEnglish ? "default" : "outline"}
              aria-pressed={missingEnglish}
              onClick={() => {
                setMissingEnglish((value) => !value);
                setOffset(0);
              }}
            >
              No English subs
            </Button>
            <Button
              size="sm"
              variant={only3d ? "default" : "outline"}
              aria-pressed={only3d}
              onClick={() => {
                setOnly3d((value) => !value);
                setOffset(0);
              }}
            >
              3D only
            </Button>
            <Button
              size="sm"
              variant={hungarian ? "default" : "outline"}
              aria-pressed={hungarian}
              onClick={() => {
                setHungarian((value) => !value);
                setOffset(0);
              }}
            >
              Hungarian
            </Button>
          </div>
        </div>
        {selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
            <span className="font-medium">{selected.size} selected</span>
            <span className="text-muted-foreground">
              Marks rows in this browser only. Metarr does not rename, delete, move, or update files.
            </span>
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
              It never copies video files. You can also load a demo library to click through the table first.
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
              <Table className="min-w-[1100px]">
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
                    <TableHead>File</TableHead>
                    <TableHead>Picture</TableHead>
                    <TableHead>Audio</TableHead>
                    <TableHead>Subtitles</TableHead>
                    <TableHead>Rating</TableHead>
                    <TableHead>Genres</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {titles.map((title) => {
                    const arr = arrPresence(title, data?.configured ?? []);
                    const open = openId === title.id;
                    const detail = episodes[title.id];
                    return (
                      <Fragment key={title.id}>
                        <TableRow className="align-top">
                          <TableCell>
                            <Checkbox
                              checked={selected.has(titleSelection(title).key)}
                              onCheckedChange={(value) => toggleSelected(titleSelection(title), value === true)}
                              aria-label={`Select ${title.title}`}
                            />
                          </TableCell>
                          <TableCell>
                            <button type="button" className="text-left" onClick={() => setDetail(title)}>
                              <TitleCell title={title} />
                            </button>
                            {title.kind === "series" ? (
                              <button type="button" className="mt-1 text-xs text-primary" onClick={() => void toggleEpisodes(title)}>
                                {open ? "Hide episodes" : "Show episodes"}
                              </button>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <div className="flex max-w-48 flex-wrap gap-1">
                              <Presence yes={title.inPlex} label="Plex" />
                              {arr.apps.map((app) => (
                                <Presence key={app.id} yes={app.present} label={app.label} />
                              ))}
                            </div>
                          </TableCell>
                          <TableCell>
                            <p className={cn("whitespace-nowrap", playableClass(title.playableLabel))}>
                              {playableText(title.playableLabel)}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {[title.container, title.resolution, title.qualityName].filter(Boolean).join(" · ") || "—"}
                            </p>
                            {title.playableNote ? <p className="text-[11px] text-amber-200/80">{title.playableNote}</p> : null}
                          </TableCell>
                          <TableCell>
                            <p>{title.is3d ? "3D" : "2D"}</p>
                            <p className={title.hdr === "none" ? "text-[11px] text-muted-foreground" : "text-[11px]"}>{hdrText(title.hdr)}</p>
                          </TableCell>
                          <TableCell>{formatList(title.audioLanguages)}</TableCell>
                          <TableCell>
                            <SubtitleCell present={title.subtitleLanguages} wanted={title.subtitleWanted} />
                          </TableCell>
                          <TableCell>
                            {formatRating(displayRating(title.rating, title.online).value)}
                            {title.rating == null && title.online?.rating != null ? (
                              <p className="text-[11px] text-muted-foreground">{displayRating(title.rating, title.online).source}</p>
                            ) : null}
                          </TableCell>
                          <TableCell className="max-w-48">
                            {formatList(displayGenres(title.genres, title.online).genres)}
                            {displayGenres(title.genres, title.online).filled ? (
                              <p className="text-[11px] text-muted-foreground">Filled online</p>
                            ) : null}
                          </TableCell>
                        </TableRow>
                        {open ? (
                          <TableRow key={`${title.id}-episodes`}>
                            <TableCell colSpan={COLUMNS} className="bg-muted/30">
                              <EpisodeList
                                series={title}
                                detail={detail}
                                selected={selected}
                                onToggle={toggleSelected}
                              />
                            </TableCell>
                          </TableRow>
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
                      <button type="button" className="text-left" onClick={() => setDetail(title)}>
                        <TitleCell title={title} />
                      </button>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">Format</dt>
                        <dd>{title.container ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Playable</dt>
                        <dd className={playableClass(title.playableLabel)}>{playableText(title.playableLabel)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Resolution</dt>
                        <dd>{title.resolution ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Quality</dt>
                        <dd>{title.qualityName ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">3D</dt>
                        <dd>{title.is3d ? "Yes" : "No"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">HDR</dt>
                        <dd>{hdrText(title.hdr)}</dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-muted-foreground">Audio</dt>
                        <dd>{formatList(title.audioLanguages)}</dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-muted-foreground">Subtitles</dt>
                        <dd>
                          {formatList(title.subtitleLanguages)}
                          {title.subtitleWanted.length ? ` · Bazarr missing: ${title.subtitleWanted.join(", ")}` : ""}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Rating</dt>
                        <dd>{formatRating(title.rating)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Genres</dt>
                        <dd>{formatList(title.genres)}</dd>
                      </div>
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-1">
                      <Presence yes={title.inPlex} label="Plex" />
                      {arr.apps.map((app) => (
                        <Presence key={app.id} yes={app.present} label={app.label} />
                      ))}
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">{arr.summary}</p>
                    {title.kind === "series" ? (
                      <Button className="mt-3" size="sm" variant="outline" onClick={() => void toggleEpisodes(title)}>
                        {open ? "Hide episodes" : "Show episodes"}
                      </Button>
                    ) : null}
                    {open ? (
                      <div className="mt-3">
                        <EpisodeList
                          series={title}
                          detail={episodes[title.id]}
                          selected={selected}
                          onToggle={toggleSelected}
                        />
                      </div>
                    ) : null}
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
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
        onLookup={(id) => void lookup([id])}
      />
    </div>
  );
}

function EpisodeList({
  series,
  detail,
  selected,
  onToggle,
}: {
  series: LibraryTitle;
  detail: LibraryEpisode[] | "loading" | "error" | undefined;
  selected: Map<string, SelectedRow>;
  onToggle: (row: SelectedRow, on: boolean) => void;
}) {
  if (!detail || detail === "loading") return <p className="text-xs text-muted-foreground">Loading episodes…</p>;
  if (detail === "error") return <p className="text-xs text-rose-300">Episodes could not be loaded.</p>;
  if (detail.length === 0) return <p className="text-xs text-muted-foreground">No episode metadata stored.</p>;
  return (
    <div className="grid gap-2">
      {detail.map((episode) => {
        const status = episodeStatus(episode);
        const row = episodeSelection(series, episode);
        return (
          <div key={episode.id} className="grid gap-1 border-b border-border/60 pb-2 text-xs last:border-0 md:grid-cols-[1.25rem_7rem_1fr_8rem_8rem_1fr] md:items-center">
            <Checkbox
              checked={selected.has(row.key)}
              onCheckedChange={(value) => onToggle(row, value === true)}
              aria-label={`Select ${row.label}`}
            />
            <p className="font-medium">{episodeCode(episode.season, episode.episode)}</p>
            <p>{episode.title}</p>
            <p className={status.className}>{status.label}</p>
            <p>{episode.container ?? "—"} {episode.qualityName ? `· ${episode.qualityName}` : ""}</p>
            <p className="text-muted-foreground">
              Audio {formatList(episode.audioLanguages)} · Subs {formatList(episode.subtitleLanguages)}
              {episode.subtitleWanted.length ? ` · Bazarr missing: ${episode.subtitleWanted.join(", ")}` : ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}
