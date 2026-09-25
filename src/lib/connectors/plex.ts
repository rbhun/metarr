import {
  absorbGuids,
  collectGenres,
  collectLanguages,
  detect3d,
  detectHdr,
  normalizeContentRating,
  formatAspect,
  formatFrameRate,
  normalizeResolution,
  parseBitrateKbps,
  videoCodecLabel,
  parseRating,
  parseYear,
} from "@/lib/media";
import { sourceDraft, withMedia } from "@/lib/source";
import type { AudioTrack, MediaFile, SourceDraft, SubtitlePlacement, SubtitleTrack } from "@/lib/types";
import { asArray, asRecord, fetchJson, normalizeBaseUrl, type ProgressUpdate } from "@/lib/connectors/http";

const PAGE_SIZE = 100;
const STREAM_BATCH = 40;

function plexList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

function streamTypeOf(stream: Record<string, unknown> | null): number | null {
  const raw = stream?.streamType;
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function channelLayout(count: number): string | null {
  if (count === 1) return "1.0";
  if (count === 2) return "2.0";
  if (count === 3) return "2.1";
  if (count === 4) return "3.1";
  if (count === 5) return "5.0";
  if (count === 6) return "5.1";
  if (count === 7) return "6.1";
  if (count === 8) return "7.1";
  if (count === 10) return "7.1.2";
  if (count === 12) return "7.1.4";
  if (Number.isFinite(count) && count > 0) return `${count}.0`;
  return null;
}

function audioLayout(channels: unknown, layout: unknown, title: unknown): string | null {
  const named = textOf(layout);
  if (named) {
    const found = named.match(/\d\.\d(?:\.\d)?/);
    if (found) return found[0];
    if (/stereo/i.test(named)) return "2.0";
    if (/mono/i.test(named)) return "1.0";
  }
  const count = typeof channels === "number" ? channels : typeof channels === "string" ? Number(channels) : NaN;
  const fromCount = channelLayout(count);
  if (fromCount) return fromCount;
  const label = textOf(title) ?? "";
  const fromTitle = label.match(/\b(\d\.\d(?:\.\d)?)\b/);
  if (fromTitle?.[1]) return fromTitle[1];
  if (/stereo/i.test(label)) return "2.0";
  if (/\bmono\b/i.test(label)) return "1.0";
  return null;
}

function audioCodecLabel(codec: unknown, profile: unknown, title: unknown): string | null {
  const blob = [codec, profile, title].map(textOf).filter(Boolean).join(" ");
  if (!blob) return null;
  if (/atmos/i.test(blob)) return "Dolby Atmos";
  if (/truehd/i.test(blob)) return "Dolby TrueHD";
  if (/eac3|e-ac-3|digital plus/i.test(blob)) return "Dolby Digital Plus";
  if (/\bdts-hd\b|\bdts:x\b|\bdts hd\b/i.test(blob)) return "DTS-HD";
  if (/\bdts\b|\bdca\b/i.test(blob)) return "DTS";
  if (/ac3|ac-3|dolby digital/i.test(blob)) return "Dolby Digital";
  if (/\baac\b/i.test(blob)) return "AAC";
  if (/flac/i.test(blob)) return "FLAC";
  if (/opus/i.test(blob)) return "Opus";
  if (/mp3/i.test(blob)) return "MP3";
  if (/pcm/i.test(blob)) return "PCM";
  return null;
}

function audioTrackFrom(stream: Record<string, unknown>, media: Record<string, unknown>, streamIndex: number): AudioTrack {
  const title = stream.displayTitle ?? stream.extendedDisplayTitle ?? stream.title;
  const language = collectLanguages([streamLanguage(stream)])[0] ?? null;
  const label = textOf(stream.title);
  return {
    language,
    layout: audioLayout(stream.channels ?? media.audioChannels, stream.audioChannelLayout ?? media.audioChannelLayout, title),
    codec: audioCodecLabel(stream.codec ?? media.audioCodec, stream.profile ?? stream.audioProfile ?? media.audioProfile, title),
    streamIndex,
    ...(label ? { label } : {}),
  };
}

function subtitleFormat(codec: unknown, title: unknown): string | null {
  const blob = [codec, title].map(textOf).filter(Boolean).join(" ");
  if (!blob) return null;
  if (/pgs|hdmv/i.test(blob)) return "PGS";
  if (/\bass\b|\bssa\b/i.test(blob)) return "ASS";
  if (/srt|subrip/i.test(blob)) return "SRT";
  if (/vobsub|dvd_sub/i.test(blob)) return "VobSub";
  if (/mov_text|tx3g/i.test(blob)) return "MOV";
  if (/webvtt|\bvtt\b/i.test(blob)) return "VTT";
  const raw = textOf(codec);
  return raw ? raw.toUpperCase() : null;
}

function subtitlePlacement(stream: Record<string, unknown>, partFile: string | null): SubtitlePlacement {
  const title = [stream.displayTitle, stream.extendedDisplayTitle, stream.title, stream.codec].map(textOf).filter(Boolean).join(" ");
  if (/burn(?:ed)?[ -]?in/i.test(title)) return "burn-in";
  const index = typeof stream.index === "number" ? stream.index : typeof stream.index === "string" ? Number(stream.index) : NaN;
  const key = textOf(stream.key) ?? "";
  const streamFile = textOf(stream.file);
  if ((Number.isFinite(index) && index < 0) || key.includes("/library/streams/") || /external/i.test(title) || (streamFile != null && streamFile !== partFile)) {
    return "external";
  }
  return "internal";
}

function subtitleTrackFrom(stream: Record<string, unknown>, partFile: string | null): SubtitleTrack {
  const title = stream.displayTitle ?? stream.extendedDisplayTitle ?? stream.title;
  return {
    language: collectLanguages([streamLanguage(stream)])[0] ?? null,
    placement: subtitlePlacement(stream, partFile),
    format: subtitleFormat(stream.codec ?? stream.format, title),
    forced: stream.forced === true || stream.forced === 1 || stream.forced === "1",
  };
}

function positiveInt(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

function tagList(value: unknown): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of plexList(value)) {
    const tag = textOf(asRecord(entry)?.tag);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(tag);
  }
  return names;
}

function titleNotes(item: Record<string, unknown>) {
  const added = positiveInt(item.addedAt);
  return {
    summary: textOf(item.summary),
    studio: textOf(item.studio),
    tagline: textOf(item.tagline),
    released: textOf(item.originallyAvailableAt),
    addedAt: added ? new Date(added * 1000).toISOString() : null,
    directors: tagList(item.Director),
    writers: tagList(item.Writer),
    countries: tagList(item.Country),
    collections: tagList(item.Collection),
  };
}

function runtimeMinutesOf(value: unknown): number | null {
  const ms = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(ms) || ms < 60_000) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0 || minutes > 1_000) return null;
  return minutes;
}

function posterPathOf(item: Record<string, unknown>): string | null {
  const images = plexList(item.Image).map(asRecord);
  const cover = images.find((image) => image?.type === "coverPoster");
  const thumb = textOf(item.thumb) ?? textOf(cover?.url);
  if (!thumb || !thumb.startsWith("/library/")) return null;
  return thumb.split("?")[0] ?? null;
}

function streamLanguage(stream: Record<string, unknown> | null): unknown {
  if (!stream) return null;
  if (stream.language || stream.languageTag || stream.languageCode) {
    return stream.language || stream.languageTag || stream.languageCode;
  }
  if (typeof stream.displayTitle !== "string") return null;
  const name = stream.displayTitle.split("(")[0]?.trim() ?? "";
  if (!name || /^unknown$/i.test(name)) return null;
  return name;
}

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
  const medias = plexList(item.Media);
  const files: MediaFile[] = [];
  const sources = medias.length ? medias : [item];
  for (const mediaValue of sources) {
    const media = asRecord(mediaValue);
    if (!media) continue;
    const parts = plexList(media.Part);
    const partList = parts.length ? parts : [null];
    for (const partValue of partList) {
      const part = asRecord(partValue);
      const streams = plexList(part?.Stream ?? media.Stream).map(asRecord);
      const videos = streams.filter((stream) => streamTypeOf(stream) === 1);
      const audios = streams.filter((stream): stream is Record<string, unknown> => streamTypeOf(stream) === 2);
      const subtitles = streams.filter((stream): stream is Record<string, unknown> => streamTypeOf(stream) === 3);
      const video = videos[0];
      const filePath = typeof part?.file === "string" ? part.file : null;
      const audioTracks = audios.length
        ? audios.map((stream, index) => audioTrackFrom(stream, media, index))
        : [
            {
              language: null,
              layout: audioLayout(media.audioChannels, media.audioChannelLayout, null),
              codec: audioCodecLabel(media.audioCodec, media.audioProfile, null),
            },
          ].filter((track) => track.layout || track.codec);
      let subtitleOrdinal = 0;
      const subtitleTracks = subtitles.map((stream) => {
        const track = subtitleTrackFrom(stream, filePath);
        const file = textOf(stream?.file);
        if (track.placement === "external") return file ? { ...track, file } : track;
        if (track.placement === "burn-in") return track;
        const indexed = { ...track, streamIndex: subtitleOrdinal };
        subtitleOrdinal += 1;
        return indexed;
      });
      const container =
        (typeof part?.container === "string" && part.container) ||
        (typeof media.container === "string" && media.container) ||
        null;
      const width = positiveInt(video?.width ?? media.width);
      const height = positiveInt(video?.height ?? media.height);
      const size = positiveInt(part?.size);
      files.push({
        container,
        path: filePath,
        qualityName: null,
        resolution: normalizeResolution(media.videoResolution, height),
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
        audioLanguages: collectLanguages(audioTracks.map((track) => track.language)),
        subtitleLanguages: collectLanguages(subtitleTracks.map((track) => track.language)),
        audioTracks,
        subtitleTracks,
        bitrateKbps: parseBitrateKbps(media.bitrate ?? video?.bitrate, "kbps"),
        videoCodec: videoCodecLabel(video?.codec ?? media.videoCodec),
        videoProfile: textOf(video?.profile ?? media.videoProfile),
        frameRate: formatFrameRate(video?.frameRate, media.videoFrameRate),
        width,
        height,
        bitDepth: positiveInt(video?.bitDepth),
        aspectRatio: formatAspect(media.aspectRatio),
        fileBytes: size,
        durationMinutes: runtimeMinutesOf(media.duration ?? part?.duration),
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
    contentRating: type === "episode" ? (parent?.contentRating ?? null) : normalizeContentRating(item.contentRating),
    genres: type === "episode" ? [] : collectGenres(item.Genre),
    posterPath: posterPathOf(item),
    runtimeMinutes: runtimeMinutesOf(item.duration),
    notes: titleNotes(item),
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
  const items = plexList(container?.Metadata);
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

function itemHasStreams(item: unknown): boolean {
  const record = asRecord(item);
  if (!record) return false;
  for (const mediaValue of plexList(record.Media)) {
    const media = asRecord(mediaValue);
    if (!media) continue;
    if (plexList(media.Stream).length > 0) return true;
    for (const partValue of plexList(media.Part)) {
      const part = asRecord(partValue);
      if (part && plexList(part.Stream).length > 0) return true;
    }
  }
  return false;
}

export function applyDetailedItems(items: unknown[], detailed: unknown[]): unknown[] {
  const byKey = new Map<string, unknown>();
  for (const item of detailed) {
    const record = asRecord(item);
    if (record?.ratingKey == null) continue;
    byKey.set(String(record.ratingKey), item);
  }
  return items.map((item) => {
    const record = asRecord(item);
    if (record?.ratingKey == null) return item;
    const full = byKey.get(String(record.ratingKey));
    if (!full) return item;
    const detail = asRecord(full);
    if (!detail) return item;
    if (!(itemHasStreams(full) || plexList(detail.Media).length > 0)) return item;
    if (detail.thumb || !record.thumb) return full;
    return { ...detail, thumb: record.thumb, Image: detail.Image ?? record.Image };
  });
}

async function withStreamDetails(
  baseUrl: string,
  token: string,
  items: unknown[],
  label: string,
  onProgress: (update: ProgressUpdate) => void,
): Promise<unknown[]> {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const record = asRecord(item);
    const type = record?.type;
    if (type !== "movie" && type !== "episode") continue;
    if (itemHasStreams(item) || record?.ratingKey == null) continue;
    const key = String(record.ratingKey);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  if (keys.length === 0) return items;

  let current = items;
  let missed = 0;
  for (let offset = 0; offset < keys.length; offset += STREAM_BATCH) {
    const slice = keys.slice(offset, offset + STREAM_BATCH);
    const params = new URLSearchParams({ includeGuids: "1", includeExternalMedia: "1" });
    try {
      const payload = await fetchJson(
        `${baseUrl}/library/metadata/${slice.join(",")}?${params.toString()}`,
        plexHeaders(token),
        60_000,
      );
      const container = asRecord(asRecord(payload)?.MediaContainer) ?? asRecord(payload);
      const detailed = plexList(container?.Metadata);
      const returned = new Set(
        detailed
          .map((item) => {
            const record = asRecord(item);
            return record?.ratingKey != null ? String(record.ratingKey) : "";
          })
          .filter(Boolean),
      );
      missed += slice.filter((key) => !returned.has(key)).length;
      current = applyDetailedItems(current, detailed);
    } catch {
      missed += slice.length;
    }
    onProgress({
      message: `Plex · ${label} audio and subtitles ${Math.min(offset + slice.length, keys.length)}/${keys.length}`,
      fetched: Math.min(offset + slice.length, keys.length),
      total: keys.length,
    });
  }
  if (missed > 0) {
    onProgress({
      message: `Plex · ${label} audio and subtitles missing for ${missed}`,
      fetched: keys.length - missed,
      total: keys.length,
    });
  }
  return current;
}

export type PlexLibrary = {
  key: string;
  title: string;
  type: "movie" | "show";
};

export function listPlexLibraries(payload: unknown): PlexLibrary[] {
  const container = asRecord(asRecord(payload)?.MediaContainer) ?? asRecord(payload);
  const libraries: PlexLibrary[] = [];
  for (const section of asArray(container?.Directory)) {
    const record = asRecord(section);
    if (!record || (record.type !== "movie" && record.type !== "show")) continue;
    const key = record.key != null ? String(record.key) : "";
    if (!key) continue;
    libraries.push({
      key,
      title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : key,
      type: record.type,
    });
  }
  return libraries;
}

export async function fetchPlexLibraries(baseUrl: string, token: string): Promise<PlexLibrary[]> {
  const base = normalizeBaseUrl(baseUrl, 32400);
  const payload = await fetchJson(`${base}/library/sections`, plexHeaders(token.trim()));
  return listPlexLibraries(payload);
}

export async function testPlex(baseUrl: string, token: string): Promise<string> {
  const base = normalizeBaseUrl(baseUrl, 32400);
  const payload = await fetchJson(`${base}/identity`, plexHeaders(token.trim()));
  const container = asRecord(asRecord(payload)?.MediaContainer) ?? asRecord(payload);
  const version = typeof container?.version === "string" ? container.version : null;
  return version ? `Connected to Plex ${version}.` : "Connected to Plex.";
}

export async function pullPlex(
  baseUrl: string,
  token: string,
  onProgress: (update: ProgressUpdate) => void,
  excludedKeys: string[] = [],
): Promise<SourceDraft[]> {
  const base = normalizeBaseUrl(baseUrl, 32400);
  const secret = token.trim();
  const skipped = new Set(excludedKeys);
  onProgress({ message: "Plex · reading libraries", fetched: 0, total: null });
  const sections = await fetchPlexLibraries(base, secret);

  const records: SourceDraft[] = [];
  for (const section of sections) {
    const key = section.key;
    const title = section.title;
    if (skipped.has(key)) {
      onProgress({ message: `Plex · skipped ${title}`, fetched: records.length, total: null });
      continue;
    }
    if (section.type === "movie") {
      const listed = await fetchAllPaged(base, secret, key, 1, title, onProgress);
      const items = await withStreamDetails(base, secret, listed, title, onProgress);
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
    const listedEpisodes = await fetchAllPaged(base, secret, key, 4, `${title} episodes`, onProgress);
    const episodes = await withStreamDetails(base, secret, listedEpisodes, `${title} episodes`, onProgress);
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
