import {
  collectGenres,
  collectLanguages,
  detect3d,
  detectHdr,
  normalizeContainer,
  normalizeImdb,
  normalizeNumericId,
  normalizeResolution,
  parseRating,
  parseYear,
} from "@/lib/media";
import { sourceDraft, withMedia } from "@/lib/source";
import type { SourceDraft } from "@/lib/types";
import { asRecord, fetchJson, normalizeBaseUrl, pagePayload, type ProgressUpdate } from "@/lib/connectors/http";

function headers(apiKey: string): Record<string, string> {
  return { Accept: "application/json", "X-Api-Key": apiKey };
}

function qualityName(file: Record<string, unknown> | null): string | null {
  const quality = asRecord(asRecord(file?.quality)?.quality);
  return typeof quality?.name === "string" ? quality.name : null;
}

export function parseRadarrMovie(value: unknown): SourceDraft | null {
  const movie = asRecord(value);
  if (!movie) return null;
  const title = typeof movie.title === "string" && movie.title.trim() ? movie.title.trim() : "Untitled";
  const file = asRecord(movie.movieFile);
  const media = asRecord(file?.mediaInfo);
  const filePath =
    (typeof file?.path === "string" && file.path) ||
    (typeof file?.relativePath === "string" && file.relativePath) ||
    null;
  const hasFile = Boolean(movie.hasFile) && Boolean(filePath || file);
  const container = normalizeContainer(
    typeof media?.container === "string" ? media.container : null,
    filePath,
  );
  const resolution = normalizeResolution(
    media?.resolution ?? asRecord(asRecord(file?.quality)?.quality)?.resolution,
    media?.height,
  );
  const hdr = detectHdr([media?.videoDynamicRangeType, media?.videoDynamicRange, media?.videoHdrFormat]);
  const audio = collectLanguages(media?.audioLanguages ?? media?.audioLanguage);
  const subtitles = collectLanguages(media?.subtitles);
  const quality = qualityName(file);
  const is3d = detect3d([title, filePath, quality]);
  const id = movie.id != null ? String(movie.id) : movie.tmdbId != null ? `tmdb:${movie.tmdbId}` : title;
  const draft = sourceDraft({
    connector: "radarr",
    kind: "movie",
    externalKey: id,
    title,
    year: parseYear(movie.year),
    imdbId: normalizeImdb(movie.imdbId),
    tmdbId: normalizeNumericId(movie.tmdbId),
    monitored: Boolean(movie.monitored),
    wanted: !hasFile,
    rating: parseRating(
      asRecord(movie.ratings)?.value ?? asRecord(asRecord(movie.ratings)?.imdb)?.value ?? asRecord(asRecord(movie.ratings)?.tmdb)?.value,
    ),
    genres: collectGenres(movie.genres),
    qualityName: quality,
    hdr,
    is3d,
  });
  if (!hasFile) return draft;
  return withMedia(
    draft,
    [
      {
        container,
        path: filePath,
        qualityName: quality,
        resolution,
        hdr,
        is3d,
        audioLanguages: audio,
        subtitleLanguages: subtitles,
      },
    ],
    [title, filePath, quality],
  );
}

export async function testRadarr(baseUrl: string, apiKey: string): Promise<string> {
  const base = normalizeBaseUrl(baseUrl);
  const payload = asRecord(await fetchJson(`${base}/api/v3/system/status`, headers(apiKey.trim())));
  const appName = typeof payload?.appName === "string" ? payload.appName : "";
  if (appName && appName.toLowerCase() !== "radarr") {
    throw new Error(`That server reports ${appName}, not Radarr.`);
  }
  const version = typeof payload?.version === "string" ? payload.version : "";
  return version ? `Connected to Radarr ${version}.` : "Connected to Radarr.";
}

export async function pullRadarr(
  baseUrl: string,
  apiKey: string,
  onProgress: (update: ProgressUpdate) => void,
): Promise<SourceDraft[]> {
  const base = normalizeBaseUrl(baseUrl);
  const key = apiKey.trim();
  onProgress({ message: "Radarr · requesting movies", fetched: 0, total: null });
  const payload = await fetchJson(`${base}/api/v3/movie`, headers(key));
  const movies = Array.isArray(payload) ? payload : pagePayload(payload).items;
  const byId = new Map<string, SourceDraft>();
  movies.forEach((movie, index) => {
    const parsed = parseRadarrMovie(movie);
    if (!parsed) return;
    byId.set(parsed.externalKey, parsed);
    if ((index + 1) % 100 === 0 || index === movies.length - 1) {
      onProgress({
        message: `Radarr · movies ${index + 1}/${movies.length}`,
        fetched: index + 1,
        total: movies.length,
      });
    }
  });

  let page = 1;
  let seen = 0;
  let total: number | null = null;
  try {
  for (let guard = 0; guard < 10000; guard += 1) {
    const wantedPayload = await fetchJson(
      `${base}/api/v3/wanted/missing?page=${page}&pageSize=200&sortKey=title&sortDirection=ascending`,
      headers(key),
    );
    const batch = pagePayload(wantedPayload);
    if (total == null) total = batch.total;
    if (batch.items.length === 0) break;
    for (const movie of batch.items) {
      const parsed = parseRadarrMovie(movie);
      if (!parsed) continue;
      parsed.wanted = true;
      parsed.hasFile = false;
      parsed.files = [];
      const existing = byId.get(parsed.externalKey);
      if (existing) {
        existing.wanted = true;
        if (!existing.hasFile) {
          existing.files = [];
        }
      } else {
        byId.set(parsed.externalKey, parsed);
      }
    }
    seen += batch.items.length;
    onProgress({
      message: `Radarr · wanted ${seen}${total != null ? `/${total}` : ""}`,
      fetched: seen,
      total,
    });
    if (total != null && seen >= total) break;
    if (batch.items.length < 200) break;
    page += 1;
  }
  } catch {
    onProgress({
      message: "Radarr · movie list saved; wanted queue could not be read",
      fetched: byId.size,
      total: byId.size,
    });
  }

  const records = [...byId.values()];
  onProgress({ message: `Radarr · ${records.length} movies`, fetched: records.length, total: records.length });
  return records;
}
