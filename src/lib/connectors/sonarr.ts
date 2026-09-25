import {
  collectGenres,
  collectLanguages,
  detect3d,
  detectHdr,
  isAired,
  normalizeContainer,
  normalizeImdb,
  normalizeNumericId,
  normalizeResolution,
  parseRating,
  parseYear,
} from "@/lib/media";
import { sourceDraft, withMedia } from "@/lib/source";
import type { MediaFile, SourceDraft } from "@/lib/types";
import {
  asArray,
  asRecord,
  fetchJson,
  mapPool,
  normalizeBaseUrl,
  pagePayload,
  type ProgressUpdate,
} from "@/lib/connectors/http";

function headers(apiKey: string): Record<string, string> {
  return { Accept: "application/json", "X-Api-Key": apiKey };
}

function qualityName(file: Record<string, unknown> | null): string | null {
  const quality = asRecord(asRecord(file?.quality)?.quality);
  return typeof quality?.name === "string" ? quality.name : null;
}

function fileMedia(file: Record<string, unknown>, title: string): MediaFile {
  const media = asRecord(file.mediaInfo);
  const filePath =
    (typeof file.path === "string" && file.path) ||
    (typeof file.relativePath === "string" && file.relativePath) ||
    null;
  const quality = qualityName(file);
  const hdr = detectHdr([media?.videoDynamicRangeType, media?.videoDynamicRange, media?.videoHdrFormat]);
  return {
    container: normalizeContainer(typeof media?.container === "string" ? media.container : null, filePath),
    path: filePath,
    qualityName: quality,
    resolution: normalizeResolution(media?.resolution ?? asRecord(asRecord(file.quality)?.quality)?.resolution, media?.height),
    hdr,
    is3d: detect3d([title, filePath, quality]),
    audioLanguages: collectLanguages(media?.audioLanguages ?? media?.audioLanguage ?? file.languages),
    subtitleLanguages: collectLanguages(media?.subtitles),
  };
}

export function parseSonarrSeries(value: unknown): SourceDraft | null {
  const series = asRecord(value);
  if (!series || series.id == null) return null;
  const title = typeof series.title === "string" && series.title.trim() ? series.title.trim() : "Untitled series";
  const statistics = asRecord(series.statistics);
  const fileCount = typeof statistics?.episodeFileCount === "number" ? statistics.episodeFileCount : 0;
  return sourceDraft({
    connector: "sonarr",
    kind: "series",
    externalKey: String(series.id),
    title,
    year: parseYear(series.year),
    imdbId: normalizeImdb(series.imdbId),
    tmdbId: normalizeNumericId(series.tmdbId),
    tvdbId: normalizeNumericId(series.tvdbId),
    parentKey: `sonarr-series:${series.id}`,
    hasFile: fileCount > 0,
    monitored: series.monitored !== false,
    rating: parseRating(asRecord(series.ratings)?.value),
    genres: collectGenres(series.genres),
  });
}

export function parseSonarrEpisode(
  value: unknown,
  series: SourceDraft,
  file: Record<string, unknown> | null,
  wantedIds: Set<string>,
): SourceDraft | null {
  const episode = asRecord(value);
  if (!episode || episode.id == null) return null;
  const title = typeof episode.title === "string" && episode.title.trim() ? episode.title.trim() : "Episode";
  const airDate =
    (typeof episode.airDateUtc === "string" && episode.airDateUtc) ||
    (typeof episode.airDate === "string" && episode.airDate) ||
    null;
  const hasFile = Boolean(episode.hasFile) && Boolean(file);
  const monitored = Boolean(episode.monitored);
  const id = String(episode.id);
  const wanted = wantedIds.has(id) || (!hasFile && monitored && isAired(airDate));
  const media = hasFile && file ? fileMedia(file, `${series.title} ${title}`) : null;
  const draft = sourceDraft({
    connector: "sonarr",
    kind: "episode",
    externalKey: id,
    title,
    seriesTitle: series.title,
    year: series.year,
    season: typeof episode.seasonNumber === "number" ? episode.seasonNumber : null,
    episode: typeof episode.episodeNumber === "number" ? episode.episodeNumber : null,
    imdbId: series.imdbId,
    tmdbId: series.tmdbId,
    tvdbId: series.tvdbId,
    parentKey: series.parentKey,
    hasFile,
    wanted,
    monitored,
    airDate,
    qualityName: media?.qualityName ?? null,
    hdr: media?.hdr ?? "none",
    is3d: media?.is3d ?? false,
  });
  if (!media) return draft;
  return withMedia(draft, [media], [series.title, title, media.path]);
}

export async function testSonarr(baseUrl: string, apiKey: string): Promise<string> {
  const base = normalizeBaseUrl(baseUrl);
  const payload = asRecord(await fetchJson(`${base}/api/v3/system/status`, headers(apiKey.trim())));
  const appName = typeof payload?.appName === "string" ? payload.appName : "";
  if (appName && appName.toLowerCase() !== "sonarr") {
    throw new Error(`That server reports ${appName}, not Sonarr.`);
  }
  const version = typeof payload?.version === "string" ? payload.version : "";
  return version ? `Connected to Sonarr ${version}.` : "Connected to Sonarr.";
}

export async function pullSonarr(
  baseUrl: string,
  apiKey: string,
  onProgress: (update: ProgressUpdate) => void,
): Promise<SourceDraft[]> {
  const base = normalizeBaseUrl(baseUrl);
  const key = apiKey.trim();
  onProgress({ message: "Sonarr · requesting series", fetched: 0, total: null });
  const seriesPayload = await fetchJson(`${base}/api/v3/series`, headers(key));
  const series = (Array.isArray(seriesPayload) ? seriesPayload : pagePayload(seriesPayload).items)
    .map(parseSonarrSeries)
    .filter((item): item is SourceDraft => Boolean(item));

  const wantedIds = new Set<string>();
  let page = 1;
  let seen = 0;
  let total: number | null = null;
  try {
  for (let guard = 0; guard < 10000; guard += 1) {
    const payload = await fetchJson(
      `${base}/api/v3/wanted/missing?page=${page}&pageSize=200&sortKey=airDateUtc&sortDirection=descending`,
      headers(key),
    );
    const batch = pagePayload(payload);
    if (total == null) total = batch.total;
    if (batch.items.length === 0) break;
    for (const item of batch.items) {
      const record = asRecord(item);
      if (record?.id != null) wantedIds.add(String(record.id));
    }
    seen += batch.items.length;
    onProgress({
      message: `Sonarr · wanted episodes ${seen}${total != null ? `/${total}` : ""}`,
      fetched: seen,
      total,
    });
    if (total != null && seen >= total) break;
    if (batch.items.length < 200) break;
    page += 1;
  }
  } catch {
    onProgress({
      message: "Sonarr · series list saved; wanted queue could not be read",
      fetched: series.length,
      total: series.length,
    });
  }

  let finished = 0;
  const episodeGroups = await mapPool(series, 4, async (show) => {
    const [episodePayload, filePayload] = await Promise.all([
      fetchJson(`${base}/api/v3/episode?seriesId=${encodeURIComponent(show.externalKey)}`, headers(key)),
      fetchJson(`${base}/api/v3/episodefile?seriesId=${encodeURIComponent(show.externalKey)}`, headers(key)),
    ]);
    const files = new Map<string, Record<string, unknown>>();
    for (const fileValue of Array.isArray(filePayload) ? filePayload : asArray(asRecord(filePayload)?.records)) {
      const file = asRecord(fileValue);
      if (file?.id != null) files.set(String(file.id), file);
    }
    const episodes = (Array.isArray(episodePayload) ? episodePayload : asArray(episodePayload))
      .map((episode) => {
        const record = asRecord(episode);
        const fileId = record?.episodeFileId != null ? String(record.episodeFileId) : "";
        return parseSonarrEpisode(episode, show, fileId ? (files.get(fileId) ?? null) : null, wantedIds);
      })
      .filter((episode): episode is SourceDraft => Boolean(episode));
    finished += 1;
    onProgress({
      message: `Sonarr · series ${finished}/${series.length}`,
      fetched: finished,
      total: series.length,
    });
    return episodes;
  });

  const records = [...series, ...episodeGroups.flat()];
  onProgress({
    message: `Sonarr · ${series.length} series, ${records.length - series.length} episodes`,
    fetched: records.length,
    total: records.length,
  });
  return records;
}
