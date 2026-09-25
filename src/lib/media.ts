import type { AudioTrack, HdrLabel, MediaDetail, MediaFile, MediaVersion, PlayableLabel, SubtitleTrack, TitleNotes } from "@/lib/types";

const VIDEO_EXTENSIONS = new Set([
  "mkv",
  "mp4",
  "avi",
  "m4v",
  "ts",
  "wmv",
  "mov",
  "m2ts",
  "mts",
  "mpg",
  "mpeg",
  "webm",
  "ogm",
  "divx",
  "flv",
  "asf",
  "vob",
  "m4p",
  "3gp",
  "wtv",
]);

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  eng: "English",
  hu: "Hungarian",
  hun: "Hungarian",
  de: "German",
  deu: "German",
  ger: "German",
  es: "Spanish",
  spa: "Spanish",
  fr: "French",
  fra: "French",
  fre: "French",
  it: "Italian",
  ita: "Italian",
  ja: "Japanese",
  jpn: "Japanese",
  ko: "Korean",
  kor: "Korean",
  zh: "Chinese",
  zho: "Chinese",
  chi: "Chinese",
  cmn: "Chinese",
  yue: "Chinese",
  pt: "Portuguese",
  por: "Portuguese",
  ru: "Russian",
  rus: "Russian",
  pl: "Polish",
  pol: "Polish",
  nl: "Dutch",
  nld: "Dutch",
  dut: "Dutch",
  sv: "Swedish",
  swe: "Swedish",
  no: "Norwegian",
  nor: "Norwegian",
  nob: "Norwegian",
  nb: "Norwegian",
  da: "Danish",
  dan: "Danish",
  fi: "Finnish",
  fin: "Finnish",
  cs: "Czech",
  ces: "Czech",
  cze: "Czech",
  tr: "Turkish",
  tur: "Turkish",
  ar: "Arabic",
  ara: "Arabic",
  arb: "Arabic",
  hi: "Hindi",
  hin: "Hindi",
  th: "Thai",
  tha: "Thai",
  uk: "Ukrainian",
  ukr: "Ukrainian",
  he: "Hebrew",
  heb: "Hebrew",
  el: "Greek",
  ell: "Greek",
  gre: "Greek",
  ro: "Romanian",
  ron: "Romanian",
  rum: "Romanian",
  sk: "Slovak",
  slk: "Slovak",
  hr: "Croatian",
  hrv: "Croatian",
  sr: "Serbian",
  srp: "Serbian",
  bg: "Bulgarian",
  bul: "Bulgarian",
  ca: "Catalan",
  cat: "Catalan",
  id: "Indonesian",
  ind: "Indonesian",
  vi: "Vietnamese",
  vie: "Vietnamese",
};

const HDR_RANK: Record<HdrLabel, number> = {
  none: 0,
  HLG: 1,
  HDR10: 2,
  "HDR10+": 3,
  "Dolby Vision": 4,
};

const ROMAN: Array<[RegExp, string]> = [
  [/\bviii\b/g, "8"],
  [/\bvii\b/g, "7"],
  [/\bvi\b/g, "6"],
  [/\bix\b/g, "9"],
  [/\biv\b/g, "4"],
  [/\biii\b/g, "3"],
  [/\bii\b/g, "2"],
  [/\bv\b/g, "5"],
];

export function fileExtension(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const clean = filePath.split("?")[0]?.replace(/\\/g, "/") ?? "";
  const base = clean.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,5}$/.test(ext)) return null;
  return ext;
}

export function normalizeContainer(
  container: string | null | undefined,
  filePath: string | null | undefined,
): string | null {
  const raw = (container ?? "").trim().toLowerCase().replace(/^\./, "");
  const ext = fileExtension(filePath);
  if (raw === "mpegts") {
    if (ext === "m2ts" || ext === "mts" || ext === "ts") return ext;
    return "ts";
  }
  if (raw && raw !== "unknown" && /^[a-z0-9]{1,8}$/.test(raw)) return raw;
  return ext;
}

export function discKind(container: string | null, filePath: string | null): Exclude<PlayableLabel, "video" | "missing"> | null {
  const ext = (container || fileExtension(filePath) || "").toLowerCase().replace(/^\./, "");
  const path = (filePath || "").toLowerCase().replace(/\\/g, "/");
  const name = path.split("/").pop() ?? "";
  if (ext === "iso" || ext === "img") {
    const bluray = /\bbd\d+\b|\buhd\b|\bblu[-_. ]?ray\b/.test(name);
    const dvd = /\bdvd/.test(name);
    if (bluray) return "bluray-iso";
    if (dvd) return "dvd-iso";
    return "iso";
  }
  if (path.includes("/bdmv/") || path.endsWith("/bdmv")) return "bluray";
  if (path.includes("/video_ts/") || path.endsWith("/video_ts") || path.includes("video_ts.")) return "dvd";
  if (ext === "vob" || ext === "ifo" || ext === "bup") return "dvd";
  return null;
}

export function isDiscImage(container: string | null, filePath: string | null): boolean {
  return discKind(container, filePath) !== null;
}

export function isDiscPlayable(label: PlayableLabel): boolean {
  return label !== "video" && label !== "missing";
}

export function playableName(label: PlayableLabel): string {
  if (label === "dvd") return "DVD";
  if (label === "bluray") return "Blu-ray";
  if (label === "iso") return "ISO";
  if (label === "dvd-iso") return "DVD ISO";
  if (label === "bluray-iso") return "Blu-ray ISO";
  if (label === "disc") return "Disc image";
  if (label === "video") return "Video file";
  return "Missing file";
}

export function isVideoExtension(ext: string | null): boolean {
  return Boolean(ext && VIDEO_EXTENSIONS.has(ext));
}

/** Disc images and missing files are not labeled playable. Known video containers are video files, without claiming direct play. */
export function playableFrom(
  hasFile: boolean,
  container: string | null,
  filePath: string | null,
): PlayableLabel {
  const normalized = normalizeContainer(container, filePath);
  const hasPath = Boolean(filePath && filePath.trim());
  if (!hasFile && !hasPath && !normalized) return "missing";
  const kind = discKind(normalized, filePath);
  if (kind) return kind;
  if (!hasFile && !hasPath) return "missing";
  if (normalized && !isVideoExtension(normalized) && normalized !== "iso" && normalized !== "img") {
    return "missing";
  }
  return "video";
}

export function detect3d(parts: Array<string | null | undefined>): boolean {
  const blob = parts.filter((part) => part && part.trim()).join(" ");
  if (!blob) return false;
  return /\b3d\b|\bhsbs\b|\bhou\b|half[-\s]?sbs|half[-\s]?ou|half[-\s]?over[-\s]?under/i.test(blob);
}

export function detectHdr(parts: unknown[]): HdrLabel {
  const blob = parts
    .filter((part) => part !== null && part !== undefined && part !== false && part !== "")
    .map((part) => String(part))
    .join(" ")
    .toLowerCase();
  if (!blob.trim()) return "none";
  if (/dolby\s*vision|\bdovi\b|\bdv\b/.test(blob)) return "Dolby Vision";
  if (/hdr10\s*\+|hdr10plus|hdr10\+/.test(blob)) return "HDR10+";
  if (/hdr10/.test(blob)) return "HDR10";
  if (/\bhlg\b|arib-std-b67/.test(blob)) return "HLG";
  if (/\bhdr\b|smpte2084/.test(blob)) return "HDR10";
  return "none";
}

export function bestHdr(values: HdrLabel[]): HdrLabel {
  return values.reduce<HdrLabel>(
    (best, value) => (HDR_RANK[value] > HDR_RANK[best] ? value : best),
    "none",
  );
}

export function hdrRank(value: HdrLabel): number {
  return HDR_RANK[value] ?? 0;
}

export function normalizeResolution(value: unknown, height?: unknown): string | null {
  const numericHeight = typeof height === "number" ? height : typeof height === "string" ? Number(height) : NaN;
  if (Number.isFinite(numericHeight) && numericHeight > 0) {
    return resolutionFromHeight(numericHeight);
  }
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1800) return "2160p";
    if (value >= 1000) return "1080p";
    if (value >= 700) return "720p";
    if (value >= 500) return "576p";
    if (value >= 400) return "480p";
    return resolutionFromHeight(value);
  }
  const text = String(value).trim();
  const frame = text.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/i);
  if (frame) return resolutionFromHeight(Number(frame[2]));
  const lower = text.toLowerCase();
  if (!lower || lower === "unknown") return null;
  if (lower.includes("2160") || lower.includes("4k") || lower === "uhd") return "2160p";
  if (lower.includes("1080")) return "1080p";
  if (lower.includes("720")) return "720p";
  if (lower.includes("576")) return "576p";
  if (lower.includes("480") || lower === "sd") return "480p";
  const parsed = Number(lower.replace(/p$/, ""));
  if (Number.isFinite(parsed) && parsed > 0) return normalizeResolution(parsed);
  return null;
}

function resolutionFromHeight(height: number): string | null {
  if (!Number.isFinite(height) || height < 100) return null;
  if (height >= 2000) return "2160p";
  if (height >= 1000) return "1080p";
  if (height >= 700) return "720p";
  if (height >= 500) return "576p";
  if (height >= 400) return "480p";
  return `${Math.round(height)}p`;
}

export function resolvedResolution(file: { resolution?: string | null; height?: number | null; path?: string | null }): string | null {
  if (file.resolution) return file.resolution;
  if (typeof file.height === "number") {
    const fromHeight = resolutionFromHeight(file.height);
    if (fromHeight) return fromHeight;
  }
  if (file.path) return normalizeResolution(file.path);
  return null;
}

export function resolutionRank(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeTitle(title: string): string {
  let text = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  text = text.replace(/^(the|a|an)\s+/, "");
  for (const [pattern, digit] of ROMAN) text = text.replace(pattern, digit);
  return text.replace(/\s+/g, " ").trim();
}

export function parseYear(value: unknown): number | null {
  if (typeof value === "number" && value > 1880 && value < 2200) return Math.trunc(value);
  if (typeof value === "string") {
    const match = value.match(/\b(18|19|20)\d{2}\b/);
    if (match) return Number(match[0]);
  }
  return null;
}

export function parseRating(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const scaled = numeric > 10 && numeric <= 100 ? numeric / 10 : numeric;
  if (scaled <= 0 || scaled > 10) return null;
  return Math.round(scaled * 10) / 10;
}

export function normalizeImdb(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const match = String(value).match(/tt\d{5,}/i);
  return match ? match[0].toLowerCase() : null;
}

export function normalizeNumericId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const match = String(value).trim().match(/\d+/);
  if (!match) return null;
  const numeric = Number(match[0]);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return String(numeric);
}

export function languageName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /^(und|unknown|null|none|undefined)$/i.test(trimmed)) return null;
  const key = trimmed.toLowerCase().replace(/_/g, "-");
  if (LANGUAGE_NAMES[key]) return LANGUAGE_NAMES[key];
  const base = key.split("-")[0] ?? key;
  if (LANGUAGE_NAMES[base]) return LANGUAGE_NAMES[base];
  if (/^[a-z]{2,3}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^[a-z][a-z\s.'-]{1,40}$/i.test(trimmed)) {
    return trimmed
      .split(/\s+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }
  return null;
}

export function mergeAudioTracks(groups: AudioTrack[][]): AudioTrack[] {
  const tracks: AudioTrack[] = [];
  const seen = new Set<string>();
  for (const track of groups.flat()) {
    if (!track.language && !track.layout && !track.codec) continue;
    const key = `${track.language ?? ""}|${track.layout ?? ""}|${track.codec ?? ""}|${track.streamIndex ?? ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push(track);
  }
  return tracks;
}

export function mergeSubtitleTracks(groups: SubtitleTrack[][]): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];
  const seen = new Set<string>();
  for (const track of groups.flat()) {
    const key = `${track.language ?? ""}|${track.placement}|${track.format ?? ""}|${track.forced ? 1 : 0}|${track.streamIndex ?? ""}|${track.file ?? ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push(track);
  }
  return tracks;
}

export function uniqueLanguages(values: Array<string | null | undefined>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const part of value.split(/[/|,;]/)) {
      const name = languageName(part);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

export function collectLanguages(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string" || typeof value === "number") return uniqueLanguages([String(value)]);
  if (Array.isArray(value)) {
    const pieces: Array<string | null> = [];
    for (const item of value) {
      if (!item) continue;
      if (typeof item === "string" || typeof item === "number") {
        pieces.push(String(item));
        continue;
      }
      if (typeof item === "object") {
        const record = item as Record<string, unknown>;
        for (const key of ["name", "language", "code2", "code3", "languageTag", "languageCode"]) {
          const field = record[key];
          if (typeof field === "string" || typeof field === "number") pieces.push(String(field));
        }
      }
    }
    return uniqueLanguages(pieces);
  }
  return [];
}

export function collectGenres(value: unknown): string[] {
  const raw: string[] = [];
  if (!value) return [];
  if (typeof value === "string") raw.push(...value.split(/[,/|]/));
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") raw.push(item);
      else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (typeof record.tag === "string") raw.push(record.tag);
        else if (typeof record.name === "string") raw.push(record.name);
      }
    }
  }
  const genres: string[] = [];
  const seen = new Set<string>();
  for (const genre of raw) {
    const name = genre.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    genres.push(name);
  }
  return genres;
}

export function isAired(airDate: string | null | undefined, now = Date.now()): boolean {
  if (!airDate) return false;
  const time = Date.parse(airDate);
  if (Number.isNaN(time)) return false;
  return time <= now;
}

export function absorbGuids(values: Array<string | null | undefined>): {
  imdbId: string | null;
  tmdbId: string | null;
  tvdbId: string | null;
  guid: string | null;
} {
  let imdbId: string | null = null;
  let tmdbId: string | null = null;
  let tvdbId: string | null = null;
  let guid: string | null = null;
  for (const value of values) {
    if (!value) continue;
    const text = value.trim();
    if (!text) continue;
    if (!imdbId && /imdb/i.test(text)) imdbId = normalizeImdb(text);
    if (!imdbId && /^tt\d{5,}$/i.test(text)) imdbId = normalizeImdb(text);
    if (!tmdbId && /(?:tmdb|themoviedb):\/\/(\d+)/i.test(text)) {
      tmdbId = normalizeNumericId(text.match(/(?:tmdb|themoviedb):\/\/(\d+)/i)?.[1]);
    }
    if (!tvdbId && /(?:tvdb|thetvdb):\/\/(\d+)/i.test(text)) {
      tvdbId = normalizeNumericId(text.match(/(?:tvdb|thetvdb):\/\/(\d+)/i)?.[1]);
    }
    if (!guid && (/^plex:\/\//i.test(text) || /plexapp/i.test(text))) guid = text;
  }
  return { imdbId, tmdbId, tvdbId, guid };
}

function fileScore(file: MediaFile): number {
  const label = playableFrom(true, file.container, file.path);
  const playable = label === "video" ? 2 : isDiscPlayable(label) ? 1 : 0;
  return playable * 1_000_000 + resolutionRank(resolvedResolution(file)) * 100 + hdrRank(file.hdr);
}

export function pickBestFile(files: MediaFile[]): MediaFile | null {
  if (files.length === 0) return null;
  return files.reduce((best, file) => (fileScore(file) > fileScore(best) ? file : best));
}

export function summarizeFiles(files: MediaFile[], titleHints: Array<string | null | undefined> = []) {
  const best = pickBestFile(files);
  const labels = files.map((file) => playableFrom(true, file.container, file.path));
  const hasVideo = labels.includes("video");
  const discLabels = [...new Set(labels.filter(isDiscPlayable))];
  let playableLabel: PlayableLabel = "missing";
  let playableNote: string | null = null;
  if (files.length === 0) {
    playableLabel = "missing";
  } else if (hasVideo && discLabels.length > 0) {
    playableLabel = "video";
    playableNote = `Also has ${discLabels.map((label) => (playableName(label) === "ISO" ? "an ISO" : `a ${playableName(label)}`)).join(" and ")}`;
  } else if (hasVideo) {
    playableLabel = "video";
  } else if (best && discLabels.length > 0) {
    playableLabel = playableFrom(true, best.container, best.path);
  }

  const containers = new Set<string>();
  for (const file of files) {
    const container = normalizeContainer(file.container, file.path);
    if (container) containers.add(container);
  }

  const hint3d = detect3d([...titleHints, ...files.map((file) => file.path)]);
  return {
    hasFile: files.length > 0 && playableLabel !== "missing",
    container: containers.size ? [...containers].join(", ") : null,
    path: best?.path ?? files.find((file) => file.path)?.path ?? null,
    playableLabel,
    playableNote,
    qualityName: best?.qualityName ?? files.find((file) => file.qualityName)?.qualityName ?? null,
    resolution: best ? resolvedResolution(best) : null,
    hdr: bestHdr(files.map((file) => file.hdr)),
    is3d: hint3d || files.some((file) => file.is3d),
    audioLanguages: uniqueLanguages(files.flatMap((file) => file.audioLanguages)),
    subtitleLanguages: uniqueLanguages(files.flatMap((file) => file.subtitleLanguages)),
    audioTracks: mergeAudioTracks(files.map((file) => file.audioTracks ?? [])),
    videoCodec: best?.videoCodec ?? null,
    videoProfile: best?.videoProfile ?? null,
    frameRate: best?.frameRate ?? null,
    width: best?.width ?? null,
    height: best?.height ?? null,
    bitDepth: best?.bitDepth ?? null,
    aspectRatio: best?.aspectRatio ?? null,
    fileBytes: best?.fileBytes ?? null,
    subtitleTracks: mergeSubtitleTracks(files.map((file) => file.subtitleTracks ?? [])),
    bitrateKbps: maxBitrate(files),
  };
}

export function buildDetail(notes: TitleNotes | null, files: MediaFile[]): MediaDetail | null {
  const summary = summarizeFiles(files);
  const ranked = [...files].sort((a, b) => Number(Boolean(b.frameRate)) - Number(Boolean(a.frameRate)));
  const briefs = ranked.slice(0, 8).map((file) => ({
    name: fileName(file.path),
    container: file.container,
    resolution: resolvedResolution(file),
    frameRate: file.frameRate ?? null,
    videoCodec: file.videoCodec ?? null,
  }));
  const detail: MediaDetail = {
    summary: notes?.summary ?? null,
    studio: notes?.studio ?? null,
    tagline: notes?.tagline ?? null,
    released: notes?.released ?? null,
    addedAt: notes?.addedAt ?? null,
    directors: notes?.directors ?? [],
    writers: notes?.writers ?? [],
    countries: notes?.countries ?? [],
    collections: notes?.collections ?? [],
    videoCodec: summary.videoCodec,
    videoProfile: summary.videoProfile,
    frameRate: summary.frameRate,
    width: summary.width,
    height: summary.height,
    bitDepth: summary.bitDepth,
    aspectRatio: summary.aspectRatio,
    fileBytes: summary.fileBytes,
    files: briefs,
  };
  const hasText = detail.summary || detail.studio || detail.tagline || detail.frameRate || detail.videoCodec;
  if (!hasText && detail.files.length === 0 && detail.directors.length === 0) return null;
  return detail;
}

function fileName(path: string | null): string {
  if (!path) return "File";
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || "File";
}

const EDITION_LABELS: Array<[RegExp, string]> = [
  [/director'?s?\s*cut/i, "Director's Cut"],
  [/extended(?:\s*(?:cut|edition))?/i, "Extended"],
  [/theatrical(?:\s*cut)?/i, "Theatrical"],
  [/unrated|\buncut\b/i, "Unrated"],
  [/open\s*matte/i, "Open Matte"],
  [/\bimax\b/i, "IMAX"],
  [/remaster(?:ed)?/i, "Remastered"],
  [/criterion/i, "Criterion"],
  [/special\s*edition/i, "Special Edition"],
  [/final\s*cut/i, "Final Cut"],
];

export function editionLabel(filePath: string | null | undefined): string | null {
  if (!filePath?.trim()) return null;
  for (const [pattern, label] of EDITION_LABELS) {
    if (pattern.test(filePath)) return label;
  }
  return null;
}

function isSamplePath(filePath: string | null | undefined): boolean {
  if (!filePath?.trim()) return false;
  const base = fileName(filePath).replace(/\.[a-z0-9]{1,5}$/i, "");
  if (/^(?:etrg|rarbg(?:\.com)?|yify(?:\.com)?)$/i.test(base)) return true;
  return /(?:^|[^a-z0-9])sample(?:[^a-z0-9]|$)/i.test(filePath);
}

function isShortCopy(file: MediaFile, peers: MediaFile[]): boolean {
  const bytes = file.fileBytes ?? 0;
  const duration = file.durationMinutes ?? null;
  const muchSmaller =
    bytes > 0 &&
    bytes < 500_000_000 &&
    peers.some((peer) => peer !== file && (peer.fileBytes ?? 0) >= Math.max(bytes * 8, 500_000_000));
  const muchShorter =
    duration != null &&
    duration > 0 &&
    duration < 12 &&
    peers.some((peer) => peer !== file && (peer.durationMinutes ?? 0) >= 40);
  return muchSmaller || muchShorter;
}

export function versionFlags(file: MediaFile, peers: MediaFile[]): string[] {
  const flags: string[] = [];
  if (isSamplePath(file.path)) flags.push("sample");
  if (isShortCopy(file, peers)) flags.push("short");
  return flags;
}

function missingMetadata(file: MediaFile): string[] {
  const subtitlesNamed =
    file.subtitleLanguages.some((language) => language.trim()) ||
    (file.subtitleTracks ?? []).some((track) => track.language);
  return subtitlesNamed ? [] : ["subtitles"];
}

/** Every file stays visible. A lower resolution or SDR copy is its own version, not a duplicate of the largest file. */
export function versionsFrom(files: MediaFile[]): MediaVersion[] {
  return [...files]
    .sort((left, right) => {
      const resolution = resolutionRank(resolvedResolution(right)) - resolutionRank(resolvedResolution(left));
      if (resolution !== 0) return resolution;
      return hdrRank(right.hdr) - hdrRank(left.hdr);
    })
    .map((file) => ({
      name: fileName(file.path),
      path: file.path,
      container: normalizeContainer(file.container, file.path),
      resolution: resolvedResolution(file),
      hdr: file.hdr,
      is3d: file.is3d,
      qualityName: file.qualityName,
      bitrateKbps: file.bitrateKbps ?? null,
      playableLabel: playableFrom(true, file.container, file.path),
      edition: editionLabel(file.path),
      audioLanguages: uniqueLanguages(file.audioLanguages),
      subtitleLanguages: uniqueLanguages(file.subtitleLanguages),
      audioTracks: mergeAudioTracks([file.audioTracks ?? []]),
      subtitleTracks: mergeSubtitleTracks([file.subtitleTracks ?? []]),
      missing: missingMetadata(file),
      flags: versionFlags(file, files),
      fileBytes: file.fileBytes ?? null,
      durationMinutes: file.durationMinutes ?? null,
    }));
}

function maxBitrate(files: MediaFile[]): number | null {
  let best: number | null = null;
  for (const file of files) {
    const bitrate = file.bitrateKbps;
    if (bitrate == null || !Number.isFinite(bitrate) || bitrate <= 0) continue;
    if (best == null || bitrate > best) best = bitrate;
  }
  return best;
}

export function videoCodecLabel(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return null;
  if (raw === "hevc" || raw === "h265" || raw === "h.265") return "HEVC";
  if (raw === "h264" || raw === "avc" || raw === "h.264") return "H.264";
  if (raw.includes("mpeg2")) return "MPEG-2";
  if (raw.includes("mpeg4") || raw.includes("msmpeg")) return "MPEG-4";
  if (raw === "av1") return "AV1";
  if (raw === "vp9") return "VP9";
  if (raw === "vc1" || raw === "vc-1") return "VC-1";
  return raw.toUpperCase();
}

export function formatFrameRate(streamRate: unknown, mediaRate: unknown): string | null {
  const numeric = typeof streamRate === "number" ? streamRate : typeof streamRate === "string" ? Number(streamRate) : NaN;
  if (Number.isFinite(numeric) && numeric > 1 && numeric < 1000) {
    const text = (Math.round(numeric * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "");
    return `${text} fps`;
  }
  const named = typeof mediaRate === "string" ? mediaRate.trim().toLowerCase() : "";
  if (named === "ntsc") return "29.97 fps";
  if (named === "pal") return "25 fps";
  if (named === "24p") return "24 fps";
  if (named === "25p") return "25 fps";
  if (named === "30p") return "30 fps";
  if (named === "60p") return "60 fps";
  return named || null;
}

export function formatAspect(value: unknown): string | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 5) return null;
  return `${numeric.toFixed(2)}:1`;
}

export function parseBitrateKbps(value: unknown, unit: "kbps" | "bps"): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const kbps = unit === "bps" ? numeric / 1000 : numeric;
  if (kbps < 1 || kbps > 500_000) return null;
  return Math.round(kbps);
}

const CONTENT_RATINGS: Record<string, string> = {
  g: "G",
  pg: "PG",
  "pg-13": "PG-13",
  pg13: "PG-13",
  r: "R",
  "nc-17": "NC-17",
  nc17: "NC-17",
  "tv-y": "TV-Y",
  "tv-y7": "TV-Y7",
  "tv-g": "TV-G",
  "tv-pg": "TV-PG",
  "tv-14": "TV-14",
  "tv-ma": "TV-MA",
  u: "U",
  "12": "12",
  "12a": "12A",
  "15": "15",
  "18": "18",
  unrated: "Unrated",
  nr: "Unrated",
  "not rated": "Unrated",
};

export const CONTENT_RATING_OPTIONS = [
  "G",
  "PG",
  "PG-13",
  "R",
  "NC-17",
  "TV-Y",
  "TV-Y7",
  "TV-G",
  "TV-PG",
  "TV-14",
  "TV-MA",
  "U",
  "12",
  "12A",
  "15",
  "18",
  "Unrated",
];

export function normalizeContentRating(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || /^n\/?a$/i.test(text)) return null;
  return CONTENT_RATINGS[text.toLowerCase()] ?? text;
}

export function languageOptions(): string[] {
  return [...new Set(Object.values(LANGUAGE_NAMES))].sort((left, right) => left.localeCompare(right));
}

export function mergeLanguages(...groups: string[][]): string[] {
  return uniqueLanguages(groups.flat());
}
