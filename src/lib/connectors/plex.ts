import {
  absorbGuids,
  collectGenres,
  collectLanguages,
  detect3d,
  detectHdr,
  normalizeResolution,
  parseRating,
  parseYear,
} from "@/lib/media";
import { sourceDraft, withMedia } from "@/lib/source";
import type { MediaFile, SourceDraft } from "@/lib/types";
import { asArray, asRecord, fetchJson, normalizeBaseUrl, type ProgressUpdate } from "@/lib/connectors/http";

const PAGE_SIZE = 100;

function plexHeaders(token: string, start?: number): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Plex-Token": token,
    "X-Plex-Product": "Metarr",
    "X-Plex-Client-Identifier": "metarr-local",
  };
  if (start !== undefined) {
    headers["X-Plex-Container-Start"] = String(start);
    headers["X-Plex-Container-Size"] = String(PAGE_SIZE);
  }
  return headers;
}

function mediaFiles(item: Record<string, unknown>, title: string): MediaFile[] {
  const medias = asArray(item.Media);
  const files: MediaFile[] = [];
  const sources = medias.length ? medias : [item];
  for (const mediaValue of sources) {
    const media = asRecord(mediaValue);
    if (!media) continue;
    const parts = asArray(media.Part);
    const partList = parts.length ? parts : [null];
    for (const partValue of partList) {
      const part = asRecord(partValue);
      const streams = asArray(part?.Stream ?? media.Stream);
      const videos = streams.map(asRecord).filter((stream) => stream?.streamType === 1);
      const audios = streams.map(asRecord).filter((stream) => stream?.streamType === 2);
      const subtitles = streams.map(asRecord).filter((stream) => stream?.streamType === 3);
      const video = videos[0];
      const filePath = typeof part?.file === "string" ? part.file : null;
      const container =
        (typeof part?.container === "string" && part.container) ||
        (typeof media.container === "string" && media.container) ||
        null;
      files.push({
        container,
        path: filePath,
        qualityName: null,
        resolution: normalizeResolution(media.videoResolution, video?.height),
        hdr: detectHdr([
          video?.displayTitle,
          video?.extendedDisplayTitle,
          video?.colorTrc,
          video?.colorSpace,
          video?.DOVIPresent ? "Dolby Vision" : "",
          video?.doviPresent ? "Dolby Vision" : "",
          video?.DVProfile ? "Dolby Vision" : "",
          video?.hdr ? "HDR" : "",
        ]),
        is3d: detect3d([
          title,
          filePath,
          typeof video?.displayTitle === "string" ? video.displayTitle : null,
          typeof video?.stereoMode === "string" ? video.stereoMode : null,
          typeof media.video3DFormat === "string" ? media.video3DFormat : null,
        ]),
        audioLanguages: collectLanguages(
          audios.map((stream) => stream?.language || stream?.languageTag || stream?.languageCode),
        ),
        subtitleLanguages: collectLanguages(
          subtitles.map((stream) => stream?.language || stream?.languageTag || stream?.languageCode),
        ),
      });
    }
  }
  return files.filter((file) => file.path || file.container);
}

export function parsePlexItem(value: unknown, parent?: SourceDraft | null): SourceDraft | null {
  const item = asRecord(value);
  if (!item) return null;
  const type = typeof item.type === "string" ? item.type : "";
  if (type !== "movie" && type !== "show" && type !== "episode") return null;
  const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : "Untitled";
  const guidValues = [
    typeof item.guid === "string" ? item.guid : null,
    ...asArray(item.Guid).map((guid) => {
      const record = asRecord(guid);
      return typeof record?.id === "string" ? record.id : null;
    }),
  ];
  const ids = absorbGuids(guidValues);
  const ratingKey = item.ratingKey != null ? String(item.ratingKey) : ids.guid || title;
  const showGuid = typeof item.grandparentGuid === "string" ? item.grandparentGuid : parent?.guid;
  const parentKey =
    type === "show"
      ? `plex:${ids.guid || ratingKey}`
      : type === "episode"
        ? parent?.parentKey || (showGuid ? `plex:${showGuid}` : null)
        : null;

  const draft = sourceDraft({
    connector: "plex",
    kind: type === "show" ? "series" : type === "episode" ? "episode" : "movie",
    externalKey: type === "episode" ? `episode:${ratingKey}` : `item:${ratingKey}`,
    title: type === "episode" ? title : title,
    seriesTitle:
      type === "episode"
        ? (typeof item.grandparentTitle === "string" ? item.grandparentTitle : parent?.title) ?? null
        : null,
    year:
      type === "episode"
        ? (parent?.year ?? parseYear(item.parentYear ?? item.year))
        : parseYear(item.year),
    season: type === "episode" ? parseYearish(item.parentIndex) : null,
    episode: type === "episode" ? parseYearish(item.index) : null,
    imdbId: type === "episode" ? (parent?.imdbId ?? null) : ids.imdbId,
    tmdbId: type === "episode" ? (parent?.tmdbId ?? null) : ids.tmdbId,
    tvdbId: type === "episode" ? (parent?.tvdbId ?? null) : ids.tvdbId,
    guid: type === "episode" ? (showGuid ?? null) : ids.guid,
    parentKey,
    monitored: true,
    rating: parseRating(item.audienceRating ?? item.rating),
    genres: type === "episode" ? [] : collectGenres(item.Genre),
  });

  if (type === "show") {
    draft.parentKey = `plex:${ids.guid || ratingKey}`;
    draft.guid = ids.guid;
    return draft;
  }
  return withMedia(draft, mediaFiles(item, `${draft.seriesTitle ?? ""} ${title}`), [draft.seriesTitle, title]);
}

function parseYearish(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.trunc(numeric);
}

async function fetchPage(
  baseUrl: string,
  token: string,
  sectionKey: string,
  type: number | null,
  start: number,
): Promise<{ items: unknown[]; total: number | null }> {
  const params = new URLSearchParams({ includeGuids: "1" });
  if (type != null) params.set("type", String(type));
  const payload = await fetchJson(
    `${baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/all?${params.toString()}`,
    plexHeaders(token, start),
  );
  const container = asRecord(asRecord(payload)?.MediaContainer) ?? asRecord(payload);
  const items = asArray(container?.Metadata);
  const total = typeof container?.totalSize === "number" ? container.totalSize : null;
  return { items, total };
}

async function fetchAllPaged(
  baseUrl: string,
  token: string,
  sectionKey: string,
  type: number | null,
  label: string,
  onProgress: (update: ProgressUpdate) => void,
): Promise<unknown[]> {
  const collected: unknown[] = [];
  const seen = new Set<string>();
  let start = 0;
  let total: number | null = null;
  for (let page = 0; page < 10000; page += 1) {
    const batch = await fetchPage(baseUrl, token, sectionKey, type, start);
    if (total == null) total = batch.total;
    if (batch.items.length === 0) break;
    let fresh = 0;
    for (const item of batch.items) {
      const record = asRecord(item);
      const key = record?.ratingKey != null ? String(record.ratingKey) : JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(item);
      fresh += 1;
    }
    start += batch.items.length;
    onProgress({
      message: `Plex · ${label} ${collected.length}${total != null ? `/${total}` : ""}`,
      fetched: collected.length,
      total,
    });
    if (fresh === 0) break;
    if (total != null && collected.length >= total) break;
    if (batch.items.length < PAGE_SIZE) break;
  }
  return collected;
}

export async function testPlex(baseUrl: string, token: string): Promise<string> {
  const base = normalizeBaseUrl(baseUrl);
  const payload = await fetchJson(`${base}/identity`, plexHeaders(token.trim()));
  const container = asRecord(asRecord(payload)?.MediaContainer) ?? asRecord(payload);
  const version = typeof container?.version === "string" ? container.version : null;
  return version ? `Connected to Plex ${version}.` : "Connected to Plex.";
}

export async function pullPlex(
  baseUrl: string,
  token: string,
  onProgress: (update: ProgressUpdate) => void,
): Promise<SourceDraft[]> {
  const base = normalizeBaseUrl(baseUrl);
  const secret = token.trim();
  onProgress({ message: "Plex · reading libraries", fetched: 0, total: null });
  const sectionsPayload = await fetchJson(`${base}/library/sections`, plexHeaders(secret));
  const container = asRecord(asRecord(sectionsPayload)?.MediaContainer) ?? asRecord(sectionsPayload);
  const sections = asArray(container?.Directory)
    .map(asRecord)
    .filter((section): section is Record<string, unknown> => Boolean(section))
    .filter((section) => section.type === "movie" || section.type === "show");

  const records: SourceDraft[] = [];
  for (const section of sections) {
    const key = section.key != null ? String(section.key) : "";
    const title = typeof section.title === "string" ? section.title : String(section.type);
    if (!key) continue;
    if (section.type === "movie") {
      const items = await fetchAllPaged(base, secret, key, 1, title, onProgress);
      for (const item of items) {
        const parsed = parsePlexItem(item);
        if (parsed?.kind === "movie") records.push(parsed);
      }
      continue;
    }
    const shows = await fetchAllPaged(base, secret, key, 2, title, onProgress);
    const showByKey = new Map<string, SourceDraft>();
    for (const item of shows) {
      const parsed = parsePlexItem(item);
      if (!parsed || parsed.kind !== "series") continue;
      records.push(parsed);
      const raw = asRecord(item);
      if (raw?.ratingKey != null) showByKey.set(String(raw.ratingKey), parsed);
      if (parsed.guid) showByKey.set(parsed.guid, parsed);
    }
    const episodes = await fetchAllPaged(base, secret, key, 4, `${title} episodes`, onProgress);
    for (const item of episodes) {
      const raw = asRecord(item);
      const parent =
        (raw?.grandparentRatingKey != null ? showByKey.get(String(raw.grandparentRatingKey)) : undefined) ||
        (typeof raw?.grandparentGuid === "string" ? showByKey.get(raw.grandparentGuid) : undefined) ||
        null;
      const parsed = parsePlexItem(item, parent);
      if (parsed?.kind === "episode") records.push(parsed);
    }
  }
  onProgress({
    message: `Plex · ${records.length} metadata records`,
    fetched: records.length,
    total: records.length,
  });
  return records;
}
