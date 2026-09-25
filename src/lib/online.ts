import { normalizeImdb, normalizeNumericId, normalizeTitle, parseRating } from "@/lib/media";
import type { OnlineMeta, ProviderId, TitleKind } from "@/lib/types";

export type Identity = {
  kind: TitleKind;
  title: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: string | null;
  tvdbId: string | null;
};

export type SourceHit = {
  source: ProviderId;
  overview: string | null;
  posterUrl: string | null;
  originalTitle: string | null;
  runtimeMinutes: number | null;
  rating: number | null;
  genres: string[];
  imdbId: string | null;
  tmdbId: string | null;
  tvdbId: string | null;
};

export function enrichmentKey(identity: Identity): string {
  const imdb = normalizeImdb(identity.imdbId);
  if (imdb) return `${identity.kind}:imdb:${imdb}`;
  const tmdb = normalizeNumericId(identity.tmdbId);
  if (tmdb) return `${identity.kind}:tmdb:${tmdb}`;
  const tvdb = normalizeNumericId(identity.tvdbId);
  if (tvdb) return `${identity.kind}:tvdb:${tvdb}`;
  const title = normalizeTitle(identity.title) || identity.title.trim().toLowerCase();
  return `${identity.kind}:title:${title}:${identity.year ?? ""}`;
}

export function titleScore(candidateTitle: string, candidateYear: number | null, query: Identity): number {
  const left = normalizeTitle(candidateTitle);
  const right = normalizeTitle(query.title);
  if (!left || !right) return 0;
  const yearGap =
    query.year && candidateYear ? Math.abs(query.year - candidateYear) : null;
  if (left === right) {
    if (yearGap === null) return 70;
    if (yearGap === 0) return 100;
    if (yearGap === 1) return 80;
    return 30;
  }
  if (left.includes(right) || right.includes(left)) {
    if (yearGap === null || yearGap <= 1) return 55;
  }
  return 0;
}

export function acceptSearchScore(score: number): boolean {
  return score >= 70;
}

function cleanText(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text || text.toUpperCase() === "N/A") return null;
  return text;
}

export function blankHit(source: ProviderId): SourceHit {
  return {
    source,
    overview: null,
    posterUrl: null,
    originalTitle: null,
    runtimeMinutes: null,
    rating: null,
    genres: [],
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
  };
}

export function mergeHits(hits: SourceHit[], message: string | null = null): Omit<OnlineMeta, "fetchedAt"> {
  const usable = hits.filter((hit) => hit.overview || hit.posterUrl || hit.rating || hit.genres.length || hit.imdbId || hit.tmdbId);
  if (usable.length === 0) {
    return {
      status: message ? "error" : "missing",
      sources: [],
      overview: null,
      posterUrl: null,
      originalTitle: null,
      runtimeMinutes: null,
      rating: null,
      genres: [],
      imdbId: null,
      tmdbId: null,
      tvdbId: null,
      message: message ?? "No matching title on the configured sources.",
    };
  }
  const tmdb = usable.find((hit) => hit.source === "tmdb");
  const omdb = usable.find((hit) => hit.source === "omdb");
  const genres: string[] = [];
  const seen = new Set<string>();
  for (const hit of [tmdb, omdb]) {
    for (const genre of hit?.genres ?? []) {
      const key = genre.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      genres.push(genre);
    }
  }
  return {
    status: "found",
    sources: usable.map((hit) => hit.source),
    overview: cleanText(tmdb?.overview) ?? cleanText(omdb?.overview),
    posterUrl: cleanText(tmdb?.posterUrl) ?? cleanText(omdb?.posterUrl),
    originalTitle: cleanText(tmdb?.originalTitle) ?? cleanText(omdb?.originalTitle),
    runtimeMinutes: tmdb?.runtimeMinutes ?? omdb?.runtimeMinutes ?? null,
    rating: parseRating(omdb?.rating) ?? parseRating(tmdb?.rating),
    genres,
    imdbId: normalizeImdb(tmdb?.imdbId) ?? normalizeImdb(omdb?.imdbId),
    tmdbId: normalizeNumericId(tmdb?.tmdbId),
    tvdbId: normalizeNumericId(tmdb?.tvdbId),
    message: null,
  };
}

export function displayRating(local: number | null, online: OnlineMeta | null): { value: number | null; source: string | null } {
  if (local != null) return { value: local, source: "library" };
  if (online?.rating != null) {
    return { value: online.rating, source: online.sources.includes("omdb") ? "OMDb" : "TMDB" };
  }
  return { value: null, source: null };
}

export function displayGenres(local: string[], online: OnlineMeta | null): { genres: string[]; filled: boolean } {
  if (local.length) return { genres: local, filled: false };
  if (online?.genres.length) return { genres: online.genres, filled: true };
  return { genres: [], filled: false };
}
