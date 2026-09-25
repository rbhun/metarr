import type { HdrLabel, MediaFile, PlayableLabel } from "@/lib/types";

const VIDEO_EXTENSIONS = new Set([
  "mkv",
  "mp4",
  "avi",
  "m4v",
  "ts",
  "wmv",
  "mov",
  "m2ts",
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
  if (raw && raw !== "unknown" && /^[a-z0-9]{1,8}$/.test(raw)) return raw;
  return fileExtension(filePath);
}

export function isDiscImage(container: string | null, filePath: string | null): boolean {
  const ext = (container || fileExtension(filePath) || "").toLowerCase();
  const path = (filePath || "").toLowerCase().replace(/\\/g, "/");
  if (ext === "iso" || ext === "img") return true;
  return path.includes("video_ts") || path.includes("bdmv");
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
  if (isDiscImage(normalized, filePath)) return "disc";
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
  if (height >= 2000) return "2160p";
  if (height >= 1000) return "1080p";
  if (height >= 700) return "720p";
  if (height >= 500) return "576p";
  if (height >= 400) return "480p";
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
  const playable = label === "video" ? 2 : label === "disc" ? 1 : 0;
  return playable * 1_000_000 + resolutionRank(file.resolution) * 100 + hdrRank(file.hdr);
}

export function pickBestFile(files: MediaFile[]): MediaFile | null {
  if (files.length === 0) return null;
  return files.reduce((best, file) => (fileScore(file) > fileScore(best) ? file : best));
}

export function summarizeFiles(files: MediaFile[], titleHints: Array<string | null | undefined> = []) {
  const best = pickBestFile(files);
  const labels = files.map((file) => playableFrom(true, file.container, file.path));
  const hasVideo = labels.includes("video");
  const hasDisc = labels.includes("disc");
  let playableLabel: PlayableLabel = "missing";
  let playableNote: string | null = null;
  if (files.length === 0) {
    playableLabel = "missing";
  } else if (hasVideo && hasDisc) {
    playableLabel = "video";
    playableNote = "Also has a disc image";
  } else if (hasVideo) {
    playableLabel = "video";
  } else if (hasDisc) {
    playableLabel = "disc";
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
    resolution: best?.resolution ?? null,
    hdr: bestHdr(files.map((file) => file.hdr)),
    is3d: hint3d || files.some((file) => file.is3d),
    audioLanguages: uniqueLanguages(files.flatMap((file) => file.audioLanguages)),
    subtitleLanguages: uniqueLanguages(files.flatMap((file) => file.subtitleLanguages)),
  };
}

export function mergeLanguages(...groups: string[][]): string[] {
  return uniqueLanguages(groups.flat());
}
