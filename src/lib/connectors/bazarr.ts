import { collectLanguages, normalizeImdb, normalizeNumericId, parseYear } from "@/lib/media";
import { sourceDraft } from "@/lib/source";
import type { SourceDraft } from "@/lib/types";
import { asRecord, fetchJson, normalizeBaseUrl, pagePayload, type ProgressUpdate } from "@/lib/connectors/http";

function headers(apiKey: string): Record<string, string> {
  return { Accept: "application/json", "X-Api-Key": apiKey };
}

function languageList(value: unknown): string[] {
  return collectLanguages(value);
}

export function parseBazarrMovie(value: unknown): SourceDraft | null {
  const movie = asRecord(value);
  if (!movie) return null;
  const title = typeof movie.title === "string" && movie.title.trim() ? movie.title.trim() : "Untitled";
  const radarrId = movie.radarrId ?? movie.radarrid;
  const imdbId = normalizeImdb(movie.imdbId ?? movie.imdbid);
  const externalKey = radarrId != null ? `radarr:${radarrId}` : imdbId ? `imdb:${imdbId}` : title;
  return sourceDraft({
    connector: "bazarr",
    kind: "movie",
    externalKey,
    title,
    year: parseYear(movie.year),
    imdbId,
    tmdbId: normalizeNumericId(movie.tmdbId ?? movie.tmdbid),
    audioLanguages: languageList(movie.audio_language ?? movie.audio_languages),
    subtitleLanguages: languageList(movie.subtitles),
    subtitleWanted: languageList(movie.missing_subtitles),
    monitored: true,
  });
}

export function parseBazarrEpisode(value: unknown): SourceDraft | null {
  const episode = asRecord(value);
  if (!episode) return null;
  const seriesTitle =
    (typeof episode.seriesTitle === "string" && episode.seriesTitle) ||
    (typeof episode.series_title === "string" && episode.series_title) ||
    (typeof asRecord(episode.series)?.title === "string" ? String(asRecord(episode.series)?.title) : "") ||
    "Untitled series";
  const title = typeof episode.title === "string" && episode.title.trim() ? episode.title.trim() : "Episode";
  const sonarrEpisodeId = episode.sonarrEpisodeId ?? episode.sonarr_episode_id ?? episode.episodeId;
  const sonarrSeriesId = episode.sonarrSeriesId ?? episode.sonarr_series_id ?? episode.seriesId;
  const season = numberOrNull(episode.season ?? episode.seasonNumber);
  const episodeNumber = numberOrNull(episode.episode ?? episode.episodeNumber ?? episode.episode_number);
  const externalKey =
    sonarrEpisodeId != null
      ? `sonarr-episode:${sonarrEpisodeId}`
      : `${sonarrSeriesId ?? seriesTitle}:${season ?? "x"}:${episodeNumber ?? title}`;
  return sourceDraft({
    connector: "bazarr",
    kind: "episode",
    externalKey,
    title,
    seriesTitle,
    year: parseYear(episode.year ?? episode.seriesYear),
    season,
    episode: episodeNumber,
    imdbId: normalizeImdb(episode.imdbId ?? episode.imdbid),
    tvdbId: normalizeNumericId(episode.tvdbId ?? episode.tvdbid ?? episode.seriesTvdbId),
    parentKey: sonarrSeriesId != null ? `sonarr-series:${sonarrSeriesId}` : null,
    audioLanguages: languageList(episode.audio_language ?? episode.audio_languages),
    subtitleLanguages: languageList(episode.subtitles),
    subtitleWanted: languageList(episode.missing_subtitles),
    monitored: episode.monitored !== false,
  });
}

function numberOrNull(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.trunc(numeric);
}

async function fetchPaged(
  baseUrl: string,
  apiKey: string,
  resource: "movies" | "episodes",
  onProgress: (update: ProgressUpdate) => void,
): Promise<unknown[]> {
  const collected: unknown[] = [];
  const pageSize = 100;
  let start = 0;
  let total: number | null = null;
  for (let guard = 0; guard < 10000; guard += 1) {
    const payload = await fetchJson(
      `${baseUrl}/api/${resource}?start=${start}&length=${pageSize}`,
      headers(apiKey),
    );
    const batch = pagePayload(payload);
    if (total == null) total = batch.total;
    if (batch.items.length === 0) break;
    collected.push(...batch.items);
    start += batch.items.length;
    onProgress({
      message: `Bazarr · ${resource} ${collected.length}${total != null ? `/${total}` : ""}`,
      fetched: collected.length,
      total,
    });
    if (total != null && collected.length >= total) break;
    if (batch.items.length < pageSize) break;
  }
  return collected;
}

export async function testBazarr(baseUrl: string, apiKey: string): Promise<string> {
  const base = normalizeBaseUrl(baseUrl);
  const key = apiKey.trim();
  let payload: unknown;
  try {
    payload = await fetchJson(`${base}/api/system/status`, headers(key));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("HTTP 404")) {
      payload = await fetchJson(`${base}/api/system/health`, headers(key));
    } else {
      throw error;
    }
  }
  const record = asRecord(payload);
  const data = asRecord(record?.data) ?? record;
  const version =
    (typeof data?.bazarr_version === "string" && data.bazarr_version) ||
    (typeof data?.version === "string" && data.version) ||
    "";
  return version ? `Connected to Bazarr ${version}.` : "Connected to Bazarr.";
}

export async function pullBazarr(
  baseUrl: string,
  apiKey: string,
  onProgress: (update: ProgressUpdate) => void,
): Promise<SourceDraft[]> {
  const base = normalizeBaseUrl(baseUrl);
  const key = apiKey.trim();
  const movies = (await fetchPaged(base, key, "movies", onProgress))
    .map(parseBazarrMovie)
    .filter((movie): movie is SourceDraft => Boolean(movie));
  const episodes = (await fetchPaged(base, key, "episodes", onProgress))
    .map(parseBazarrEpisode)
    .filter((episode): episode is SourceDraft => Boolean(episode));
  const records = [...movies, ...episodes];
  onProgress({
    message: `Bazarr · ${movies.length} movies, ${episodes.length} episodes`,
    fetched: records.length,
    total: records.length,
  });
  return records;
}
