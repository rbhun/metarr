"use client";

import { AudioTracks } from "@/components/audio-tracks";
import { enqueueDetection } from "@/components/detect-actions";
import { toastDetection } from "@/components/detect-tasks";
import { LineScroll } from "@/components/line-scroll";
import { SubtitleRows } from "@/components/subtitle-rows";
import { FileBrowserButton } from "@/components/file-browser-button";
import { VersionDetail } from "@/components/versions";
import { MediaPills } from "@/components/media-pills";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { arrPresence, episodeCode, formatBitrate, formatBytes, formatList, formatRating, formatRuntime, hdrText, playableText } from "@/lib/format";
import { multiPartLabel } from "@/lib/media";
import { displayGenres, displayRating } from "@/lib/online";
import type { ConnectorId, LibraryEpisode, LibraryTitle } from "@/lib/types";
import { PROVIDER_LABEL } from "@/lib/types";
import { openService, type ServiceApp } from "@/components/open-service";
import { toast } from "sonner";
import { useState } from "react";

export function GenreLines({ genres }: { genres: string[] }) {
  if (!genres.length) return <>—</>;
  return (
    <LineScroll>
      {genres.map((genre) => (
        <p key={genre}>{genre}</p>
      ))}
    </LineScroll>
  );
}

export function TitleDetail({
  title,
  episode,
  configured,
  busy,
  fileBrowserUrl = "",
  fileBrowserRoot = "",
  onOpenChange,
  onLookup,
}: {
  title: LibraryTitle | null;
  episode?: LibraryEpisode | null;
  configured: ConnectorId[];
  busy: boolean;
  fileBrowserUrl?: string;
  fileBrowserRoot?: string;
  onOpenChange: (open: boolean) => void;
  onLookup: (id: number) => void;
}) {
  const [arrBusy, setArrBusy] = useState<"open" | "search" | "plex" | null>(null);
  const [detectBusy, setDetectBusy] = useState(false);
  async function detectNow() {
    if (!title) return;
    setDetectBusy(true);
    try {
      toastDetection(await enqueueDetection("now", episode ? [] : [title.id], episode ? [episode.id] : []));
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Could not start language detection.");
    } finally {
      setDetectBusy(false);
    }
  }
  const rating = title ? displayRating(title.rating, title.online) : { value: null, source: null };
  const genres = title ? displayGenres(title.genres, title.online) : { genres: [], filled: false };
  const arr = title ? arrPresence(title, configured) : null;
  const arrApp = arr?.apps.find((app) => (app.id === "radarr" || app.id === "sonarr") && app.present) ?? null;
  async function askArr(id: number, action: "open" | "search", app?: ServiceApp) {
    setArrBusy(action === "search" ? "search" : app === "plex" ? "plex" : "open");
    try {
      if (action === "open" && app) {
        toast.success(await openService(id, app, episode?.id));
        return;
      }
      const response = await fetch(`/api/library/${id}/arr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "search" }),
      });
      const body = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.error || "The request failed.");
      toast.success(body.message || "Sent.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The request failed.");
    } finally {
      setArrBusy(null);
    }
  }
  const ids = title
    ? [
        ["IMDb", title.imdbId ?? title.online?.imdbId],
        ["TMDB", title.tmdbId ?? title.online?.tmdbId],
        ["TVDB", title.tvdbId ?? title.online?.tvdbId],
      ].filter((entry): entry is [string, string] => Boolean(entry[1]))
    : [];
  const file = title
    ? {
        playableLabel: episode?.playableLabel ?? title.playableLabel,
        is3d: episode?.is3d ?? title.is3d,
        hdr: episode?.hdr ?? title.hdr,
        container: episode ? episode.container : title.container,
        resolution: episode ? episode.resolution : title.resolution,
        qualityName: episode ? episode.qualityName : title.qualityName,
        bitrateKbps: episode ? null : title.bitrateKbps,
        detail: episode ? episode.detail : title.detail,
        path: episode ? episode.path : title.path,
        audioTracks: episode ? episode.audioTracks : title.audioTracks,
        audioLanguages: episode ? episode.audioLanguages : title.audioLanguages,
        subtitleTracks: episode ? episode.subtitleTracks : title.subtitleTracks,
        subtitleLanguages: episode ? episode.subtitleLanguages : title.subtitleLanguages,
        subtitleWanted: episode ? episode.subtitleWanted : title.subtitleWanted,
        versions: episode ? episode.versions : title.versions,
      }
    : null;

  return (
    <Sheet open={title != null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:w-full sm:data-[side=right]:max-w-md">
        {title ? (
          <>
            <SheetHeader>
              <SheetTitle>
                {episode ? `${episodeCode(episode.season, episode.episode)} ${episode.title}` : title.title}
                {!episode && title.year ? <span className="ml-2 font-normal text-muted-foreground">{title.year}</span> : null}
              </SheetTitle>
              {!episode && title.localTitle ? <p className="text-sm text-muted-foreground">{title.localTitle}</p> : null}
              <SheetDescription>
                {episode
                  ? title.title
                  : title.kind === "movie"
                    ? "Movie"
                    : "Series"}
                {!episode && title.online?.originalTitle && title.online.originalTitle !== title.title
                  ? ` · ${title.online.originalTitle}`
                  : ""}
              </SheetDescription>
              <Button size="sm" variant="outline" className="mt-2 w-fit" disabled={detectBusy} onClick={() => void detectNow()}>
                {detectBusy ? "Queuing…" : "Detect languages now"}
              </Button>
            </SheetHeader>
            <div className="flex gap-4 px-4">
              {title.online?.posterUrl || title.posterPath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={title.online?.posterUrl || `/api/library/${title.id}/poster`}
                  alt=""
                  className="h-44 w-28 rounded-lg object-cover"
                />
              ) : (
                <div className="h-44 w-28 rounded-lg bg-muted" />
              )}
              <dl className="grid flex-1 content-start gap-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Rating</dt>
                  <dd>
                    {formatRating(rating.value)}
                    {rating.source && rating.source !== "library" ? (
                      <span className="ml-1 text-xs text-muted-foreground">{rating.source}</span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Rated</dt>
                  <dd>{title.contentRating || title.online?.contentRating || "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Runtime</dt>
                  <dd>{formatRuntime(episode?.runtimeMinutes ?? title.runtimeMinutes ?? title.online?.runtimeMinutes)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Genres</dt>
                  <dd>
                    <GenreLines genres={genres.genres} />
                    {genres.filled ? <span className="text-xs text-muted-foreground">filled online</span> : null}
                  </dd>
                </div>
              </dl>
            </div>
            <div className="space-y-3 px-4 pb-6 text-sm">
              <p className="leading-6 text-muted-foreground">
                {episode?.detail?.summary || title.online?.overview || title.detail?.summary || "No overview yet. Look this title up to fill it from TMDB or OMDb."}
              </p>
              {(episode?.detail?.tagline || (!episode && title.detail?.tagline)) ? (
                <p className="italic text-muted-foreground">{episode?.detail?.tagline || title.detail?.tagline}</p>
              ) : null}
              {title.online ? (
                <p className="text-xs text-muted-foreground">
                  {title.online.status === "found"
                    ? `Filled from ${title.online.sources.map((source) => PROVIDER_LABEL[source]).join(" and ")}.`
                    : title.online.message}
                  {" "}
                  Stored on this machine only.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-1">
                {(episode?.inPlex ?? title.inPlex) ? (
                  <Badge variant="secondary" asChild className="cursor-pointer hover:underline">
                    <button type="button" disabled={arrBusy != null} onClick={() => void askArr(title.id, "open", "plex")} aria-label="Open in Plex">
                      Plex
                    </button>
                  </Badge>
                ) : (
                  <Badge variant="outline">Not in Plex</Badge>
                )}
                {arr?.apps.map((app) =>
                  app.present ? (
                    <Badge key={app.id} variant="secondary" asChild className="cursor-pointer hover:underline">
                      <button type="button" disabled={arrBusy != null} onClick={() => void askArr(title.id, "open", app.id)} aria-label={`Open in ${app.label}`}>
                        {app.label}
                      </button>
                    </Badge>
                  ) : (
                    <Badge key={app.id} variant="outline">{`No ${app.label}`}</Badge>
                  ),
                )}
              </div>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                {file?.playableLabel === "video" ? null : (
                <div>
                  <dt className="text-muted-foreground">Playable</dt>
                  <dd>{file ? playableText(file.playableLabel) : "—"}</dd>
                </div>
                )}
                <div>
                  <dt className="text-muted-foreground">Picture</dt>
                  <dd>
                    {file?.is3d ? "3D · " : ""}
                    {file && file.versions.length > 1
                      ? [...new Set(file.versions.map((version) => hdrText(version.hdr)))].join(", ")
                      : hdrText(file?.hdr ?? "none")}
                  </dd>
                </div>
                {file && file.versions.length > 1 ? null : (
                <div className="col-span-2">
                  <dt className="text-muted-foreground">Video</dt>
                  <dd className="mt-1 flex flex-wrap items-center gap-1">
                    <MediaPills container={file?.container} resolution={file?.resolution} frameRate={file?.detail?.frameRate} part={multiPartLabel(file?.path, file?.versions[0]?.name, file?.title)} />
                    <span>{[file?.qualityName, file?.bitrateKbps ? formatBitrate(file.bitrateKbps) : null].filter(Boolean).join(" · ")}</span>
                  </dd>
                </div>
                )}
                {file?.detail ? (
                  <>
                    <div>
                      <dt className="text-muted-foreground">Video</dt>
                      <dd>{[file.detail.videoCodec, file.detail.videoProfile].filter(Boolean).join(" ") || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Frame rate</dt>
                      <dd>{file.detail.frameRate ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Size</dt>
                      <dd>
                        {file.detail.width && file.detail.height ? `${file.detail.width}×${file.detail.height}` : "—"}
                        {file.detail.aspectRatio ? ` · ${file.detail.aspectRatio}` : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Bit depth</dt>
                      <dd>{file.detail.bitDepth ? `${file.detail.bitDepth}-bit` : "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">File size</dt>
                      <dd>{formatBytes(file.detail.fileBytes)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Studio</dt>
                      <dd>{file.detail.studio ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Released</dt>
                      <dd>{file.detail.released ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Added</dt>
                      <dd>{file.detail.addedAt ? file.detail.addedAt.slice(0, 10) : "—"}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-muted-foreground">Directors</dt>
                      <dd>{formatList(file.detail.directors)}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-muted-foreground">Writers</dt>
                      <dd>{formatList(file.detail.writers)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Countries</dt>
                      <dd>{formatList(file.detail.countries)}</dd>
                    </div>
                    {file.detail.collections.length ? (
                      <div>
                        <dt className="text-muted-foreground">Collections</dt>
                        <dd>{formatList(file.detail.collections)}</dd>
                      </div>
                    ) : null}
                    {file.versions.length < 2 && file.detail.files.length > 1 ? (
                      <div className="col-span-2 space-y-1">
                        <dt className="text-muted-foreground">Parts</dt>
                        {file.detail.files.map((part) => (
                          <dd key={part.name} className="flex flex-wrap items-center gap-1">
                            <span className="break-all">{part.name}</span>
                            <MediaPills container={part.container} resolution={part.resolution} frameRate={part.frameRate} part={multiPartLabel(part.name)} />
                          </dd>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : null}
                {file && file.versions.length > 1 ? (
                  <VersionDetail versions={file.versions} fileBrowserUrl={fileBrowserUrl} fileBrowserRoot={fileBrowserRoot} />
                ) : (
                <div className="col-span-2">
                  <dt className="text-muted-foreground">Path</dt>
                  <dd className="break-all">{file?.path ?? "No file"}</dd>
                  {file?.versions[0]?.missing.length ? (
                    <dd className="text-amber-800 dark:text-amber-200">Missing {file.versions[0].missing.join(", ")}</dd>
                  ) : null}
                </div>
                )}
                {file && file.versions.length > 1 ? null : (
                <>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">Audio</dt>
                  <dd>
                    <AudioTracks tracks={file?.audioTracks ?? []} languages={file?.audioLanguages ?? []} path={file?.path ?? null} label={episode ? `${episodeCode(episode.season, episode.episode)} ${episode.title}` : (title?.title ?? "Title")} />
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">Subtitles</dt>
                  <dd>
                    <LineScroll>
                    <SubtitleRows
                      tracks={file?.subtitleTracks ?? []}
                      languages={file?.subtitleLanguages ?? []}
                      path={file?.path ?? null}
                      label={episode ? `${episodeCode(episode.season, episode.episode)} ${episode.title}` : (title?.title ?? "Title")}
                    />
                    {file?.subtitleWanted.length ? (
                      <p className="text-amber-800 dark:text-amber-300">Bazarr missing: {file.subtitleWanted.join(", ")}</p>
                    ) : null}
                    </LineScroll>
                  </dd>
                </div>
                </>
                )}
                {ids.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap gap-2">
                {fileBrowserUrl && (file?.path || file?.versions[0]?.path) ? (
                  <FileBrowserButton
                    filePath={file?.path || file?.versions[0]?.path || null}
                    baseUrl={fileBrowserUrl}
                    root={fileBrowserRoot}
                  />
                ) : null}
                {arrApp ? (
                  <Button size="sm" disabled={arrBusy != null} onClick={() => void askArr(title.id, "search")}>
                    {arrBusy === "search" ? "Searching…" : `Search in ${arrApp.label}`}
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" disabled={busy} onClick={() => onLookup(title.id)}>
                  {busy ? "Looking up…" : "Look up this title"}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
