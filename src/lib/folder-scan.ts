import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { audioCodecLabel, audioLayoutLabel, formatGaps } from "@/lib/audio-format";
import { languageFromProbeTags } from "@/lib/detect/audio";
import { resolveMediaPath, type PathMap } from "@/lib/detect/paths";
import { readDetectSettings } from "@/lib/detect/store";
import { fetchPlexLibraryFolders, type PlexLibraryFolder } from "@/lib/connectors/plex";
import { getMeta, listConnectors, plexExcludedLibraries, saveConnector, setMeta } from "@/lib/db";
import { fileExtension, normalizeImdb, normalizeNumericId, normalizeTitle, uniqueLanguages } from "@/lib/media";
import { sourceDraft, withMedia } from "@/lib/source";
import type { AudioTrack, SourceDraft, SubtitleTrack } from "@/lib/types";
import type { ProgressUpdate } from "@/lib/connectors/http";
import type Database from "better-sqlite3";

const ROOTS_KEY = "folder_roots";
const VIDEO = new Set(["mkv", "mp4", "m4v", "avi", "ts", "m2ts", "mts", "mpg", "mpeg", "wmv", "mov", "webm"]);
const SKIP_DIR = new Set([".git", "node_modules", ".metarr-work", "#recycle", "@eadir"]);
const STRUCTURAL = new Set(["bdmv", "stream", "certificate", "video_ts", "audio_ts", "backup"]);
const FILE_LIMIT = 20_000;

export type FolderScanSettings = {
  enabled: boolean;
  roots: string[];
};

export function pathKey(filePath: string | null | undefined): string | null {
  const normalized = filePath?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized ? normalized.toLowerCase() : null;
}

export function cleanRoots(values: unknown): string[] {
  const lines = Array.isArray(values) ? values : typeof values === "string" ? values.split(/\r?\n/) : [];
  const roots: string[] = [];
  for (const value of lines) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!path.isAbsolute(trimmed)) throw new Error(`Use a full path: ${trimmed}`);
    roots.push(path.resolve(trimmed));
  }
  return [...new Set(roots)];
}

export function readFolderScan(db: Database.Database): FolderScanSettings {
  const enabled = listConnectors(db).some((connector) => connector.id === "files" && connector.enabled);
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(getMeta(db, ROOTS_KEY) ?? "[]") as unknown;
  } catch {
    parsed = [];
  }
  const roots = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  return { enabled, roots };
}

export function writeFolderScan(db: Database.Database, settings: FolderScanSettings) {
  saveConnector({ id: "files", baseUrl: "", apiKey: "", enabled: settings.enabled }, db);
  setMeta(db, ROOTS_KEY, JSON.stringify(settings.roots));
}

function localizeFolder(folder: string, maps: PathMap[]): string {
  const found = resolveMediaPath(folder, maps, (candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
  return found ?? folder.trim();
}

/** Folders from the Plex libraries Metarr syncs. A path map is applied when that folder exists here. */
export async function suggestedPlexFolders(db: Database.Database): Promise<PlexLibraryFolder[]> {
  const plex = listConnectors(db).find((connector) => connector.id === "plex");
  if (!plex?.baseUrl.trim() || !plex.apiKey.trim()) return [];
  const folders = await fetchPlexLibraryFolders(plex.baseUrl, plex.apiKey, plexExcludedLibraries(db));
  const maps = readDetectSettings(db).pathMaps;
  const seen = new Set<string>();
  const local: PlexLibraryFolder[] = [];
  for (const folder of folders) {
    const folderPath = localizeFolder(folder.path, maps);
    const identity = folderPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    local.push({ path: folderPath, library: folder.library, key: folder.key });
  }
  return local;
}

export function tracksFromProbe(payload: unknown): { audio: AudioTrack[]; subtitles: SubtitleTrack[] } | null {
  const record = payload && typeof payload === "object" ? (payload as { streams?: unknown }) : null;
  if (!Array.isArray(record?.streams)) return null;
  const audio: AudioTrack[] = [];
  const subtitles: SubtitleTrack[] = [];
  for (const item of record.streams) {
    if (!item || typeof item !== "object") continue;
    const stream = item as {
      codec_type?: unknown;
      codec_name?: unknown;
      profile?: unknown;
      channels?: unknown;
      channel_layout?: unknown;
      tags?: unknown;
    };
    const language = languageFromProbeTags(stream.tags);
    if (stream.codec_type === "audio") {
      audio.push({
        language,
        layout: audioLayoutLabel(stream.channels, stream.channel_layout, null),
        codec: audioCodecLabel(stream.codec_name, stream.profile, null),
        streamIndex: audio.length,
        fromFile: true,
      });
      continue;
    }
    if (stream.codec_type === "subtitle") {
      subtitles.push({
        language,
        placement: "internal",
        format: subtitleFormat(stream.codec_name),
        forced: false,
        streamIndex: subtitles.length,
        fromFile: true,
      });
    }
  }
  if (!audio.length && !subtitles.length) return null;
  return { audio, subtitles };
}

function reportedAudio(records: SourceDraft[], filePath: string): AudioTrack[] {
  const key = pathKey(filePath);
  let tracks: AudioTrack[] = [];
  for (const record of records) {
    if (record.connector === "files") continue;
    const files = record.files.length ? record.files : record.path ? [{ path: record.path, audioTracks: record.audioTracks }] : [];
    for (const file of files) {
      if (pathKey(file.path) !== key) continue;
      const list = file.audioTracks ?? [];
      if (!tracks.length) {
        tracks = list;
        continue;
      }
      const count = Math.max(tracks.length, list.length);
      const merged: AudioTrack[] = [];
      for (let index = 0; index < count; index += 1) {
        const left = tracks[index];
        const right = list[index];
        merged.push({
          language: left?.language ?? right?.language ?? null,
          layout: left?.layout ?? right?.layout ?? null,
          codec: left?.codec ?? right?.codec ?? null,
        });
      }
      tracks = merged;
    }
  }
  return tracks;
}

/** Files whose stream has a format or channel count the other apps have not stored. */
export function formatRefreshPaths(known: SourceDraft[], scanned: SourceDraft[]): string[] {
  const paths: string[] = [];
  for (const record of scanned) {
    const filePath = record.path;
    if (!filePath) continue;
    const probed = record.files[0]?.audioTracks ?? record.audioTracks;
    if (formatGaps(reportedAudio(known, filePath), probed)) paths.push(filePath);
  }
  return paths;
}

type EpisodeCode = { season: number; episode: number };

type KnownIndex = {
  roots: string[];
  records: SourceDraft[];
  byFolder: Map<string, SourceDraft[]>;
  episodes: SourceDraft[];
  movies: SourceDraft[];
};

export function episodeInName(name: string): EpisodeCode | null {
  const patterns = [
    /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]*e(\d{1,3})(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?:[^a-z0-9]|$)/i,
  ];
  for (const pattern of patterns) {
    const found = name.match(pattern);
    if (!found) continue;
    const season = Number(found[1]);
    const episode = Number(found[2]);
    if (Number.isFinite(season) && Number.isFinite(episode)) return { season, episode };
  }
  return null;
}

export function chooseMatch(records: SourceDraft[], filePath: string, roots: string[] = []): SourceDraft | null {
  return pickMatch(indexKnown(records, roots), filePath);
}

/** Disc playlists are named 00000.m2ts, 00366.m2ts, and similar. The folder around them is the title. */
export function isStreamFile(filePath: string): boolean {
  const stem = path.basename(filePath).replace(/\.[^.]+$/, "");
  return /^0\d{3,}$/.test(stem) || /^\d{5,}$/.test(stem);
}

/** One file per movie folder for numbered streams. Other videos stay as they are. A stream Plex or Radarr already points at wins over 00000.m2ts. */
export function filesRepresentingFolders(files: string[], known: SourceDraft[]): string[] {
  const keep: string[] = [];
  const streams = new Map<string, string[]>();
  for (const file of files) {
    if (!isStreamFile(file)) {
      keep.push(file);
      continue;
    }
    const folder = titleFromAncestors(file)?.directory ?? path.dirname(file);
    const key = pathKey(folder) ?? folder;
    const list = streams.get(key) ?? [];
    list.push(file);
    streams.set(key, list);
  }
  for (const list of streams.values()) {
    const knownFile = list.find((file) => exactMatch(known, file));
    keep.push(knownFile ?? [...list].sort((left, right) => path.basename(left).localeCompare(path.basename(right), undefined, { numeric: true }))[0]!);
  }
  return keep;
}

export function folderDraft(filePath: string, probed: { audio: AudioTrack[]; subtitles: SubtitleTrack[] }, match: SourceDraft | null): SourceDraft {
  const base = path.basename(filePath);
  const named = match?.kind === "episode" ? null : titleFromAncestors(filePath);
  const loose = match ? null : episodeInName(base);
  const guess = loose ? seriesGuess(base) : null;
  const stream = isStreamFile(filePath);
  const title = match?.title ?? (loose && guess ? guess : null) ?? named?.title ?? (stream ? "Untitled" : titleFromName(base));
  const year = match?.year ?? named?.year ?? (stream ? null : yearInName(base));
  const audioLanguages = uniqueLanguages(probed.audio.map((track) => track.language));
  const subtitleLanguages = uniqueLanguages(probed.subtitles.map((track) => track.language));
  const draft = sourceDraft({
    connector: "files",
    kind: match?.kind === "episode" || loose ? "episode" : "movie",
    externalKey: `path:${pathKey(filePath) ?? filePath}`,
    title,
    seriesTitle: match?.kind === "episode" ? (match.seriesTitle ?? guess) : guess,
    year,
    season: match?.season ?? loose?.season ?? null,
    episode: match?.episode ?? loose?.episode ?? null,
    imdbId: match?.imdbId ?? null,
    tmdbId: match?.tmdbId ?? null,
    tvdbId: match?.tvdbId ?? null,
    parentKey: match?.parentKey ?? null,
    hasFile: true,
    path: filePath,
    container: fileExtension(filePath),
  });
  return withMedia(draft, [
    {
      container: fileExtension(filePath),
      path: filePath,
      qualityName: null,
      resolution: null,
      hdr: "none",
      is3d: false,
      audioLanguages,
      subtitleLanguages,
      audioTracks: probed.audio,
      subtitleTracks: probed.subtitles,
    },
  ]);
}

export function listVideos(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    if (found.length > FILE_LIMIT) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length > FILE_LIMIT) return;
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIR.has(entry.name.toLowerCase())) continue;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = fileExtension(full);
      if (ext && VIDEO.has(ext)) found.push(full);
    }
  };
  walk(root);
  if (found.length > FILE_LIMIT) throw new Error("That folder has more than 20,000 video files. Point the scan at the movie or series folders.");
  return found;
}

/** Probe one video. Used after a language write so the folder scanner does not walk the library. */
export async function scanOneFile(filePath: string, match: SourceDraft | null): Promise<SourceDraft | null> {
  const probed = tracksFromProbe(await probeFile(filePath));
  if (!probed) return null;
  return folderDraft(filePath, probed, match);
}

export async function scanFolders(roots: string[], known: SourceDraft[], onProgress: (update: ProgressUpdate) => void): Promise<SourceDraft[]> {
  const present = roots.filter((root) => fs.existsSync(root));
  const missing = roots.filter((root) => !fs.existsSync(root));
  if (!present.length) throw new Error(`Folder not found: ${missing[0] ?? "the scan folder"}`);
  const files = filesRepresentingFolders(present.flatMap((root) => listVideos(root)), known);
  const indexed = indexKnown(known, present);
  const drafts: SourceDraft[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    onProgress({ message: `Files · ${index + 1}/${files.length} ${path.basename(file)}`, fetched: index, total: files.length });
    const probed = tracksFromProbe(await probeFile(file));
    if (!probed) continue;
    drafts.push(folderDraft(file, probed, pickMatch(indexed, file)));
  }
  onProgress({
    message: missing.length ? `Scanned ${drafts.length} files. Missing folder: ${missing[0]}` : `Scanned ${drafts.length} files.`,
    fetched: files.length,
    total: files.length,
  });
  return drafts;
}

function recordPaths(record: SourceDraft): string[] {
  const paths = [record.path, ...record.files.map((file) => file.path)];
  return paths.filter((item): item is string => Boolean(item));
}

function matchRank(record: SourceDraft): number {
  return (record.imdbId || record.tmdbId || record.tvdbId ? 2 : 0) + (record.connector === "radarr" || record.connector === "sonarr" ? 1 : 0);
}

function indexKnown(records: SourceDraft[], roots: string[]): KnownIndex {
  const known = records.filter((record) => record.connector !== "files");
  const byFolder = new Map<string, SourceDraft[]>();
  for (const record of known) {
    for (const item of recordPaths(record)) {
      const folder = mediaFolder(item, roots);
      if (!folder) continue;
      const list = byFolder.get(folder) ?? [];
      list.push(record);
      byFolder.set(folder, list);
    }
  }
  return {
    roots,
    records: known,
    byFolder,
    episodes: known.filter((record) => record.kind === "episode" || record.kind === "series"),
    movies: known.filter((record) => record.kind === "movie"),
  };
}

function pickMatch(index: KnownIndex, filePath: string): SourceDraft | null {
  return exactMatch(index.records, filePath) ?? matchByFolder(index, filePath) ?? matchEpisodeByName(index, filePath) ?? matchByFolderName(index, filePath);
}

function exactMatch(records: SourceDraft[], filePath: string): SourceDraft | null {
  const key = pathKey(filePath);
  if (!key) return null;
  const hits = records.filter((record) => recordPaths(record).some((item) => pathKey(item) === key));
  hits.sort((left, right) => matchRank(right) - matchRank(left));
  return hits[0] ?? null;
}

/** The first directory under the scan root. That is the movie or series folder. */
function mediaFolder(filePath: string, roots: string[]): string | null {
  const file = pathKey(filePath);
  if (!file || !roots.length) return null;
  let bestRoot = -1;
  let chosen: string | null = null;
  for (const root of roots) {
    const key = pathKey(root);
    if (!key || key.length < bestRoot) continue;
    const prefix = `${key}/`;
    if (file !== key && !file.startsWith(prefix)) continue;
    const rest = file.startsWith(prefix) ? file.slice(prefix.length) : "";
    const segment = rest.split("/").find(Boolean);
    bestRoot = key.length;
    chosen = segment ? `${prefix}${segment}` : key;
  }
  return chosen;
}

function matchByFolder(index: KnownIndex, filePath: string): SourceDraft | null {
  const folder = mediaFolder(filePath, index.roots);
  if (!folder) return null;
  const records = uniqueRecords(index.byFolder.get(folder) ?? []);
  if (!records.length) return null;
  const code = episodeInName(path.basename(filePath)) ?? episodeInName(path.basename(path.dirname(filePath)));
  const seriesIds = [...new Set(records.map(seriesId).filter((item): item is string => Boolean(item)))];
  if (code && seriesIds.length === 1) {
    const id = seriesIds[0]!;
    const picked = pickEpisode(
      index.episodes.filter((record) => seriesId(record) === id),
      code,
      filePath,
    );
    if (picked) return picked;
  }
  const movieIds = [...new Set(records.map(movieId).filter((item): item is string => Boolean(item)))];
  if (movieIds.length !== 1) return null;
  const movies = records.filter((record) => movieId(record) === movieIds[0]);
  movies.sort((left, right) => matchRank(right) - matchRank(left));
  return movies[0] ?? null;
}

function matchEpisodeByName(index: KnownIndex, filePath: string): SourceDraft | null {
  const base = path.basename(filePath);
  const code = episodeInName(base);
  const guess = seriesGuess(base);
  if (!code || !guess) return null;
  const normalized = normalizeTitle(guess);
  if (!normalized) return null;
  const candidates = index.episodes.filter((record) => {
    const name = record.kind === "series" ? record.title : record.seriesTitle;
    return name != null && normalizeTitle(name) === normalized;
  });
  return pickEpisode(candidates, code, filePath);
}

function matchByFolderName(index: KnownIndex, filePath: string): SourceDraft | null {
  const named = titleFromAncestors(filePath);
  if (!named) return null;
  const title = normalizeTitle(named.title);
  if (!title) return null;
  const movies = index.movies.filter((record) => normalizeTitle(record.title) === title);
  const yearMatches = named.year ? movies.filter((record) => record.year == null || record.year === named.year) : movies;
  const ids = [...new Set(yearMatches.map(movieId).filter((item): item is string => Boolean(item)))];
  if (ids.length !== 1) return null;
  const hits = yearMatches.filter((record) => movieId(record) === ids[0]);
  hits.sort((left, right) => matchRank(right) - matchRank(left));
  return hits[0] ?? null;
}

function pickEpisode(candidates: SourceDraft[], code: EpisodeCode, filePath: string): SourceDraft | null {
  const episodes = candidates.filter((record) => record.kind === "episode" && record.season === code.season && record.episode === code.episode);
  if (episodes.length) {
    episodes.sort((left, right) => matchRank(right) - matchRank(left));
    return episodes[0] ?? null;
  }
  const series = candidates.find((record) => record.kind === "series") ?? candidates.find((record) => record.kind === "episode");
  return series ? episodeShell(series, code, filePath) : null;
}

function episodeShell(source: SourceDraft, code: EpisodeCode, filePath: string): SourceDraft {
  const seriesTitle = source.kind === "series" ? source.title : source.seriesTitle;
  return sourceDraft({
    connector: source.connector,
    kind: "episode",
    externalKey: source.externalKey,
    title: seriesTitle || titleFromName(path.basename(filePath)),
    seriesTitle,
    year: source.year,
    season: code.season,
    episode: code.episode,
    imdbId: source.imdbId,
    tmdbId: source.tmdbId,
    tvdbId: source.tvdbId,
    parentKey: source.parentKey,
  });
}

function seriesId(record: SourceDraft): string | null {
  if (record.kind !== "episode" && record.kind !== "series") return null;
  const tvdb = normalizeNumericId(record.tvdbId);
  if (tvdb) return `tvdb:${tvdb}`;
  if (record.parentKey) return `parent:${record.parentKey}`;
  const name = record.kind === "series" ? record.title : record.seriesTitle;
  const normalized = name ? normalizeTitle(name) : "";
  return normalized ? `title:${normalized}` : null;
}

function movieId(record: SourceDraft): string | null {
  if (record.kind !== "movie") return null;
  const imdb = normalizeImdb(record.imdbId);
  if (imdb) return `imdb:${imdb}`;
  const title = normalizeTitle(record.title);
  return title ? `title:${title}|${record.year ?? ""}` : null;
}

function uniqueRecords(records: SourceDraft[]): SourceDraft[] {
  const seen = new Set<SourceDraft>();
  const unique: SourceDraft[] = [];
  for (const record of records) {
    if (seen.has(record)) continue;
    seen.add(record);
    unique.push(record);
  }
  return unique;
}

function seriesGuess(name: string): string | null {
  const stem = name.replace(/\.[^.]+$/, "");
  const found = stem.match(/^(.*?)(?:[ ._-]+s\d{1,2}[ ._-]*e\d{1,3}|[ ._-]+\d{1,2}x\d{1,3})(?:[^a-z0-9]|$)/i);
  if (!found?.[1]) return null;
  const text = found[1].replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length >= 2 ? text : null;
}

function titleFromAncestors(filePath: string): { title: string; year: number | null; directory: string } | null {
  const found: Array<{ title: string; year: number | null; yearly: boolean; directory: string }> = [];
  let dir = path.dirname(filePath);
  for (let depth = 0; depth < 8; depth += 1) {
    const base = path.basename(dir);
    const parent = path.dirname(dir);
    if (!base || base === dir || base === "." || base === "/") break;
    const yearly = /[\(\[](?:19|20)\d{2}[\)\]]$/.test(base.trim());
    if (!STRUCTURAL.has(base.toLowerCase()) && !/^\d+$/.test(base)) {
      const title = base
        .replace(/\s*[\(\[](?:19|20)\d{2}[\)\]]\s*$/, "")
        .replace(/[._]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (title && !/^\d+$/.test(title)) found.push({ title, year: yearInName(base), yearly, directory: dir });
    }
    if (yearly) break;
    dir = parent;
  }
  const preferred = found.find((item) => item.yearly) ?? found[0];
  return preferred ? { title: preferred.title, year: preferred.year, directory: preferred.directory } : null;
}

function yearInName(name: string): number | null {
  const match = name.match(/(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9]|$)/);
  const year = match ? Number(match[1]) : NaN;
  return Number.isFinite(year) ? year : null;
}

function titleFromName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "");
  const text = stem.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  return text || stem;
}

function subtitleFormat(codec: unknown): string | null {
  const raw = typeof codec === "string" ? codec.toLowerCase() : "";
  if (!raw) return null;
  if (raw.includes("pgs") || raw.includes("hdmv")) return "PGS";
  if (raw.includes("subrip") || raw === "srt") return "SRT";
  if (raw === "ass" || raw === "ssa") return "ASS";
  if (raw.includes("vob") || raw.includes("dvd")) return "VobSub";
  return raw.toUpperCase();
}

function probeFile(file: string): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,profile,channels,channel_layout:stream_tags=language", "-of", "json", file], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        resolve(null);
      }
    });
  });
}
