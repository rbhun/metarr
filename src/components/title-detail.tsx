"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { arrPresence, formatList, formatRating, formatRuntime, hdrText, playableText } from "@/lib/format";
import { displayGenres, displayRating } from "@/lib/online";
import type { ConnectorId, LibraryTitle } from "@/lib/types";
import { PROVIDER_LABEL } from "@/lib/types";

export function TitleDetail({
  title,
  configured,
  busy,
  onOpenChange,
  onLookup,
}: {
  title: LibraryTitle | null;
  configured: ConnectorId[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onLookup: (id: number) => void;
}) {
  const rating = title ? displayRating(title.rating, title.online) : { value: null, source: null };
  const genres = title ? displayGenres(title.genres, title.online) : { genres: [], filled: false };
  const arr = title ? arrPresence(title, configured) : null;
  const ids = title
    ? [
        ["IMDb", title.imdbId ?? title.online?.imdbId],
        ["TMDB", title.tmdbId ?? title.online?.tmdbId],
        ["TVDB", title.tvdbId ?? title.online?.tvdbId],
      ].filter((entry): entry is [string, string] => Boolean(entry[1]))
    : [];

  return (
    <Sheet open={title != null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:w-full sm:data-[side=right]:max-w-md">
        {title ? (
          <>
            <SheetHeader>
              <SheetTitle>
                {title.title}
                {title.year ? <span className="ml-2 font-normal text-muted-foreground">{title.year}</span> : null}
              </SheetTitle>
              <SheetDescription>
                {title.kind === "movie" ? "Movie" : "Series"}
                {title.online?.originalTitle && title.online.originalTitle !== title.title
                  ? ` · ${title.online.originalTitle}`
                  : ""}
              </SheetDescription>
            </SheetHeader>
            <div className="flex gap-4 px-4">
              {title.online?.posterUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={title.online.posterUrl} alt="" className="h-44 w-28 rounded-lg object-cover" />
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
                  <dt className="text-xs text-muted-foreground">Runtime</dt>
                  <dd>{formatRuntime(title.online?.runtimeMinutes)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Genres</dt>
                  <dd>
                    {formatList(genres.genres)}
                    {genres.filled ? <span className="ml-1 text-xs text-muted-foreground">filled online</span> : null}
                  </dd>
                </div>
              </dl>
            </div>
            <div className="space-y-3 px-4 pb-6 text-sm">
              <p className="leading-6 text-muted-foreground">
                {title.online?.overview ?? "No overview yet. Look this title up to fill it from TMDB or OMDb."}
              </p>
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
                <Badge variant={title.inPlex ? "secondary" : "outline"}>{title.inPlex ? "Plex" : "Not in Plex"}</Badge>
                {arr?.apps.map((app) => (
                  <Badge key={app.id} variant={app.present ? "secondary" : "outline"}>
                    {app.present ? app.label : `No ${app.label}`}
                  </Badge>
                ))}
              </div>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-muted-foreground">Playable</dt>
                  <dd>{playableText(title.playableLabel)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Picture</dt>
                  <dd>{title.is3d ? "3D" : "2D"} · {hdrText(title.hdr)}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">File</dt>
                  <dd>{[title.container, title.resolution, title.qualityName].filter(Boolean).join(" · ") || "—"}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">Path</dt>
                  <dd className="break-all">{title.path ?? "No file"}</dd>
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
                {ids.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <Button size="sm" disabled={busy} onClick={() => onLookup(title.id)}>
                {busy ? "Looking up…" : "Look up this title"}
              </Button>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
