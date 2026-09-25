import { normalizeContentRating, normalizeImdb, normalizeNumericId, parseRating, parseYear } from "@/lib/media";
import { acceptSearchScore, blankHit, localTitlesFromTranslations, mergeHits, titleScore, type Identity, type SourceHit } from "@/lib/online";
import type { OnlineMeta, ProviderId, TitleKind } from "@/lib/types";

type FetchLike = typeof fetch;

const TMDB_IMAGE = "https://image.tmdb.org/t/p/w342";

function posterFromPath(path: string | null | undefined): string | null {
  if (!path || path === "N/A") return null;
  if (path.startsWith("http")) return path;
  return `${TMDB_IMAGE}${path}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim().toUpperCase() !== "N/A" ? value.trim() : null;
}

function runtimeMinutes(value: unknown): number | null {
  if (typeof value === "number" && value > 0) return Math.round(value);
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "number" && item > 0);
    return typeof first === "number" ? Math.round(first) : null;
  }
  if (typeof value === "string") {
    const match = value.match(/\d+/);
    if (match) return Number(match[0]);
  }
  return null;
}

function genreNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim() && item !== "N/A") names.push(item.trim());
    const record = asRecord(item);
    if (record && typeof record.name === "string" && record.name.trim()) names.push(record.name.trim());
  }
  return names;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    message: string,
  ) {
    super(message);
  }
}

async function tmdbGet(apiKey: string, path: string, fetchImpl: FetchLike): Promise<unknown> {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", apiKey);
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError("tmdb", "TMDB rejected the API key.");
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new ProviderError("tmdb", `TMDB returned ${response.status}.`);
  return readJson(response);
}

function hitFromTmdb(kind: TitleKind, body: Record<string, unknown>): SourceHit {
  const external = asRecord(body.external_ids);
  const title = text(kind === "movie" ? body.title : body.name) ?? text(body.title) ?? text(body.name);
  const original = text(kind === "movie" ? body.original_title : body.original_name);
  return {
    ...blankHit("tmdb"),
    overview: text(body.overview),
    posterUrl: posterFromPath(text(body.poster_path)),
    originalTitle: original && original !== title ? original : original,
    localTitles: localTitlesFromTranslations(body.translations),
    runtimeMinutes: runtimeMinutes(kind === "movie" ? body.runtime : body.episode_run_time),
    rating: parseRating(body.vote_average),
    genres: genreNames(body.genres),
    imdbId: normalizeImdb(body.imdb_id) ?? normalizeImdb(external?.imdb_id),
    tmdbId: normalizeNumericId(body.id),
    tvdbId: normalizeNumericId(external?.tvdb_id),
  };
}

function pickTmdbResult(kind: TitleKind, payload: unknown, identity: Identity): number | null {
  const body = asRecord(payload);
  if (!body) return null;
  const list = kind === "movie" ? body.movie_results ?? body.results : body.tv_results ?? body.results;
  if (!Array.isArray(list)) return null;
  let bestId: number | null = null;
  let bestScore = 0;
  for (const item of list) {
    const record = asRecord(item);
    if (!record) continue;
    const id = normalizeNumericId(record.id);
    if (!id) continue;
    const name = text(kind === "movie" ? record.title : record.name) ?? "";
    const date = text(kind === "movie" ? record.release_date : record.first_air_date);
    const score = titleScore(name, parseYear(date), identity);
    if (score > bestScore) {
      bestScore = score;
      bestId = Number(id);
    }
  }
  return acceptSearchScore(bestScore) ? bestId : null;
}

export async function lookupTmdb(identity: Identity, apiKey: string, fetchImpl: FetchLike = fetch): Promise<SourceHit | null> {
  const kindPath = identity.kind === "movie" ? "movie" : "tv";
  const known = normalizeNumericId(identity.tmdbId);
  let id = known;
  if (!id && identity.imdbId) {
    const found = await tmdbGet(apiKey, `/find/${encodeURIComponent(identity.imdbId)}?external_source=imdb_id`, fetchImpl);
    const picked = pickTmdbResult(identity.kind, found, { ...identity, title: identity.title });
    if (picked) id = String(picked);
    else {
      const loose = asRecord(found);
      const list = identity.kind === "movie" ? loose?.movie_results : loose?.tv_results;
      const first = Array.isArray(list) ? asRecord(list[0]) : null;
      const firstId = normalizeNumericId(first?.id);
      if (firstId) id = firstId;
    }
  }
  if (!id && identity.kind === "series" && identity.tvdbId) {
    const found = await tmdbGet(apiKey, `/find/${encodeURIComponent(identity.tvdbId)}?external_source=tvdb_id`, fetchImpl);
    const first = asRecord(found);
    const list = first?.tv_results;
    const row = Array.isArray(list) ? asRecord(list[0]) : null;
    id = normalizeNumericId(row?.id);
  }
  if (!id) {
    const params = new URLSearchParams({ query: identity.title });
    if (identity.year) params.set(identity.kind === "movie" ? "year" : "first_air_date_year", String(identity.year));
    const searched = await tmdbGet(apiKey, `/search/${kindPath}?${params.toString()}`, fetchImpl);
    const picked = pickTmdbResult(identity.kind, searched, identity);
    if (!picked) return null;
    id = String(picked);
  }
  const details = await tmdbGet(apiKey, `/${kindPath}/${id}?append_to_response=external_ids,translations`, fetchImpl);
  const record = asRecord(details);
  if (!record) return null;
  return hitFromTmdb(identity.kind, record);
}

function omdbHit(body: Record<string, unknown>): SourceHit | null {
  if (text(body.Response) === "False") return null;
  const title = text(body.Title);
  if (!title) return null;
  const genres = text(body.Genre)
    ?.split(",")
    .map((genre) => genre.trim())
    .filter((genre) => genre && genre.toUpperCase() !== "N/A") ?? [];
  return {
    ...blankHit("omdb"),
    overview: text(body.Plot),
    posterUrl: text(body.Poster),
    originalTitle: title,
    runtimeMinutes: runtimeMinutes(body.Runtime),
    rating: parseRating(body.imdbRating),
    contentRating: normalizeContentRating(body.Rated),
    genres,
    imdbId: normalizeImdb(body.imdbID),
  };
}

export async function lookupOmdb(identity: Identity, apiKey: string, fetchImpl: FetchLike = fetch): Promise<SourceHit | null> {
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", apiKey);
  const imdb = normalizeImdb(identity.imdbId);
  if (imdb) url.searchParams.set("i", imdb);
  else {
    url.searchParams.set("t", identity.title);
    url.searchParams.set("type", identity.kind === "movie" ? "movie" : "series");
    if (identity.year) url.searchParams.set("y", String(identity.year));
  }
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (response.status === 401) throw new ProviderError("omdb", "OMDb rejected the API key.");
  if (!response.ok) throw new ProviderError("omdb", `OMDb returned ${response.status}.`);
  const body = asRecord(await readJson(response));
  if (!body) return null;
  if (body.Error === "Invalid API key!") throw new ProviderError("omdb", "OMDb rejected the API key.");
  if (typeof body.Error === "string" && /limit/i.test(body.Error)) {
    throw new ProviderError("omdb", "OMDb daily request limit reached.");
  }
  const hit = omdbHit(body);
  if (!hit) return null;
  if (!imdb && !acceptSearchScore(titleScore(text(body.Title) ?? "", parseYear(body.Year), identity))) return null;
  return hit;
}

export async function lookupOnline(
  identity: Identity,
  keys: Partial<Record<ProviderId, string>>,
  fetchImpl: FetchLike = fetch,
): Promise<Omit<OnlineMeta, "fetchedAt">> {
  const hits: SourceHit[] = [];
  const problems: string[] = [];
  let next = identity;
  if (keys.tmdb) {
    try {
      const hit = await lookupTmdb(next, keys.tmdb, fetchImpl);
      if (hit) {
        hits.push(hit);
        next = {
          ...next,
          imdbId: next.imdbId ?? hit.imdbId,
          tmdbId: next.tmdbId ?? hit.tmdbId,
          tvdbId: next.tvdbId ?? hit.tvdbId,
        };
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : "TMDB lookup failed.");
    }
  }
  if (keys.omdb) {
    try {
      const hit = await lookupOmdb(next, keys.omdb, fetchImpl);
      if (hit) hits.push(hit);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : "OMDb lookup failed.");
    }
  }
  if (hits.length === 0 && problems.length) {
    const merged = mergeHits([], problems.join(" "));
    if (problems.includes("OMDb daily request limit reached.")) {
      return { ...merged, message: "OMDb daily request limit reached." };
    }
    return merged;
  }
  const merged = mergeHits(hits);
  if (problems.includes("OMDb daily request limit reached.")) {
    return { ...merged, message: "OMDb daily request limit reached." };
  }
  return merged;
}
